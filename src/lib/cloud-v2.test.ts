/**
 * Tests for the v2 HTTP client. We stub the global `fetch` and
 * verify that each method emits the expected method, URL, headers,
 * and body shape. A handful of error-path tests confirm that the
 * generic `request()` helper surfaces server-side error messages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudV2 } from './cloud-v2.js';

// ---------------------------------------------------------------------------
// fetch stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

let calls: RecordedCall[] = [];

function stubOk(body: any, status = 200) {
  return (global as any).fetch = vi.fn(async (url: string, init: any) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'ERR',
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
      json: async () => body,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    };
  });
}

function stubError(status: number, errorBody: any = { error: 'server said no' }) {
  return (global as any).fetch = vi.fn(async (url: string, init: any) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: false,
      status,
      statusText: `HTTP ${status}`,
      text: async () => JSON.stringify(errorBody),
      json: async () => errorBody,
      arrayBuffer: async () => new Uint8Array().buffer,
    };
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function client() {
  return new CloudV2('https://api.example.com/', 'cs_test_key', 'machine-abc');
}

// ---------------------------------------------------------------------------
// Happy-path request shapes
// ---------------------------------------------------------------------------

describe('CloudV2 request shapes', () => {
  it('createProject POSTs to /api/projects with the correct body and Bearer header', async () => {
    stubOk({ project: { id: 42, slug: 'foo', current_version: 0 } });
    const out = await client().createProject({
      slug: 'foo',
      name: 'Foo',
      git_url: 'git@example.com:foo.git',
      git_branch: 'main',
    });
    expect(out.id).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.example.com/api/projects');
    expect(calls[0].headers.Authorization).toBe('Bearer cs_test_key');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toEqual({
      slug: 'foo',
      name: 'Foo',
      git_url: 'git@example.com:foo.git',
      git_branch: 'main',
    });
  });

  it('pushProjectVersion POSTs ciphertext+content_hash to the versions endpoint', async () => {
    stubOk({ version: 3, r2_key: 'projects/42/v3', size_bytes: 100 });
    const result = await client().pushProjectVersion(42, 'BASE64CT', 'deadbeef');
    expect(result.version).toBe(3);
    expect(calls[0].url).toBe('https://api.example.com/api/projects/42/versions');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      ciphertext: 'BASE64CT',
      content_hash: 'deadbeef',
      pushed_from_machine_id: null,
    });
  });

  it('getProjectBlob GETs /api/projects/:id/blob and returns raw bytes', async () => {
    stubOk(undefined);
    const buf = await client().getProjectBlob(7);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://api.example.com/api/projects/7/blob');
    expect(calls[0].headers.Authorization).toBe('Bearer cs_test_key');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  it('syncPlan POSTs machine_id + entities to /api/sync/plan', async () => {
    stubOk({
      actions: [{ type: 'project', id: 1, action: 'noop', current_version: 3 }],
    });
    const result = await client().syncPlan('machine-abc', [
      { type: 'project', id: 1, local_version: 3 },
    ]);
    expect(result[0].action).toBe('noop');
    expect(calls[0].url).toBe('https://api.example.com/api/sync/plan');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      machine_id: 'machine-abc',
      entities: [{ type: 'project', id: 1, local_version: 3 }],
    });
  });

  it('listProjects filters by git_url via the query string', async () => {
    stubOk({ projects: [] });
    await client().listProjects({ git_url: 'git@example.com:foo.git' });
    expect(calls[0].url).toBe(
      'https://api.example.com/api/projects?git_url=git%40example.com%3Afoo.git',
    );
  });

  it('upsertProjectKey POSTs the wrapped_dek and user_id', async () => {
    stubOk({});
    await client().upsertProjectKey(42, 'WRAPPED', 99);
    expect(calls[0].url).toBe('https://api.example.com/api/projects/42/keys');
    expect(calls[0].body).toEqual({ user_id: 99, wrapped_dek: 'WRAPPED' });
  });

  it('uploadKeypair POSTs to /api/auth/keypair', async () => {
    stubOk(undefined);
    await client().uploadKeypair({
      public_key: 'pk',
      encrypted_private_key: 'epk',
      kek_salt: 'salt',
      kek_iterations: 600000,
    });
    expect(calls[0].url).toBe('https://api.example.com/api/auth/keypair');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({
      public_key: 'pk',
      encrypted_private_key: 'epk',
      kek_salt: 'salt',
      kek_iterations: 600000,
    });
  });

  it('strips trailing slashes from the API url', () => {
    const c = new CloudV2('https://api.example.com///', 'k', 'm');
    expect(c.apiUrl).toBe('https://api.example.com');
  });
});

// ---------------------------------------------------------------------------
// Error-path shapes
// ---------------------------------------------------------------------------

describe('CloudV2 error handling', () => {
  it('throws on 401 (auth failure) with the server message if present', async () => {
    stubError(401, { error: 'invalid token' });
    await expect(client().listProjects()).rejects.toThrow(/invalid token/);
  });

  it('throws on 404', async () => {
    stubError(404, { error: 'not found' });
    await expect(client().getProject(9999)).rejects.toThrow(/not found/);
  });

  it('throws on 500 and includes the method + path in the message', async () => {
    stubError(500, { error: 'boom' });
    await expect(
      client().pushProjectVersion(1, 'CT', 'H'),
    ).rejects.toThrow(/POST \/api\/projects\/1\/versions failed.*boom/);
  });

  it('fetchKeypair returns null on 404 (no keypair yet)', async () => {
    stubError(404, { error: 'missing' });
    const out = await client().fetchKeypair();
    expect(out).toBeNull();
  });
});
