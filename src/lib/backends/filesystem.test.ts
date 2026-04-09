/**
 * Tests for FilesystemBackend.
 *
 * The headline test at the bottom of this file is the full envelope
 * round-trip: generate a keypair, push an encrypted entity version,
 * tear down the `FilesystemBackend` instance, rebuild it from the same
 * directory, unwrap the private key from the master password, recover
 * the DEK from the wrapped key, and decrypt the blob. That sequence
 * is exactly the cross-machine flow v2 is meant to fix — if this test
 * passes, the backend abstraction faithfully preserves the envelope
 * encryption invariants across process boundaries.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { FilesystemBackend } from './filesystem.js';
import {
  decryptBlob,
  encryptBlob,
  generateDEK,
  generateUserKeypair,
  unwrapDEK,
  unwrapPrivateKey,
  wrapDEK,
  wrapPrivateKey,
} from '../envelope-crypto.js';
import type { UserKeypairRecord } from '../backend.js';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

let tempRoot: string;
let backend: FilesystemBackend;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-fsbackend-'));
  backend = new FilesystemBackend({ rootPath: tempRoot });
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sampleKeypairRecord(): UserKeypairRecord {
  return {
    publicKey: Buffer.from('public-key-bytes').toString('base64'),
    encryptedPrivateKey: Buffer.from('encrypted-private-key-bytes').toString('base64'),
    kekSalt: Buffer.from('thirty-two-byte-salt-padding-ok!').toString('base64'),
    kekIterations: 600_000,
    kekAlgorithm: 'PBKDF2-HMAC-SHA256',
    keyAlgorithm: 'X25519',
    keyVersion: 1,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Keypair round-trip
// ---------------------------------------------------------------------------

describe('FilesystemBackend.keypair', () => {
  it('round-trips a keypair through putKeypair/getKeypair', async () => {
    const userId = 'user-1';
    const record = sampleKeypairRecord();

    await backend.putKeypair(userId, record);
    const loaded = await backend.getKeypair(userId);

    expect(loaded).toEqual(record);
  });

  it('returns null when no keypair exists', async () => {
    const loaded = await backend.getKeypair('ghost-user');
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe('FilesystemBackend.entities', () => {
  it('creates an entity and fetches it by id and slug', async () => {
    const userId = 'user-1';
    const created = await backend.createEntity('project', userId, {
      slug: 'hello-world',
      name: 'Hello World',
      description: 'first project',
      git_url: 'https://example.com/repo.git',
    });

    expect(created.slug).toBe('hello-world');
    expect(created.name).toBe('Hello World');
    expect(created.fields.git_url).toBe('https://example.com/repo.git');

    const byId = await backend.getEntity('project', userId, created.id);
    const bySlug = await backend.getEntity('project', userId, 'hello-world');

    expect(byId?.id).toBe(created.id);
    expect(bySlug?.id).toBe(created.id);
  });

  it('lists entities and isolates by user', async () => {
    await backend.createEntity('project', 'u1', { slug: 'a', name: 'A' });
    await backend.createEntity('project', 'u1', { slug: 'b', name: 'B' });
    await backend.createEntity('project', 'u2', { slug: 'c', name: 'C' });

    const u1 = await backend.listEntities('project', 'u1');
    const u2 = await backend.listEntities('project', 'u2');

    expect(u1.map((e) => e.slug).sort()).toEqual(['a', 'b']);
    expect(u2.map((e) => e.slug)).toEqual(['c']);
  });

  it('rejects duplicate slugs for the same user/type', async () => {
    await backend.createEntity('project', 'u1', { slug: 'dup', name: 'One' });
    await expect(
      backend.createEntity('project', 'u1', { slug: 'dup', name: 'Two' }),
    ).rejects.toThrow(/already exists/);
  });

  it('patches entity fields', async () => {
    const e = await backend.createEntity('project', 'u1', { slug: 's', name: 'old name' });
    const patched = await backend.patchEntity('project', 'u1', e.id, {
      name: 'new name',
      git_url: 'https://example.com/new.git',
    });
    expect(patched.name).toBe('new name');
    expect(patched.fields.git_url).toBe('https://example.com/new.git');
  });

  it('deletes entities (soft delete)', async () => {
    const e = await backend.createEntity('project', 'u1', { slug: 's', name: 'n' });
    await backend.deleteEntity('project', 'u1', e.id);
    const listed = await backend.listEntities('project', 'u1');
    expect(listed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Entity versions
// ---------------------------------------------------------------------------

describe('FilesystemBackend.versions', () => {
  it('pushes three versions, lists them, pulls each, verifies hashes', async () => {
    const userId = 'u1';
    const e = await backend.createEntity('config', userId, { slug: 'c', name: 'c' });

    const blobs = [
      Buffer.from('payload-one'),
      Buffer.from('payload-two-longer'),
      Buffer.from('payload-three-longer-still'),
    ];
    const hashes = blobs.map(sha256Hex);

    const pushed = [];
    for (let i = 0; i < blobs.length; i++) {
      pushed.push(
        await backend.pushEntityVersion('config', userId, e.id, blobs[i]!, hashes[i]!),
      );
    }

    expect(pushed.map((v) => v.version)).toEqual([1, 2, 3]);

    const listed = await backend.listEntityVersions('config', userId, e.id);
    expect(listed.map((v) => v.version)).toEqual([1, 2, 3]);

    for (let i = 0; i < blobs.length; i++) {
      const pulled = await backend.pullEntityVersion('config', userId, e.id, i + 1);
      expect(pulled.contentHash).toBe(hashes[i]);
      expect(Buffer.compare(pulled.ciphertext, blobs[i]!)).toBe(0);
    }

    const current = await backend.pullEntityCurrent('config', userId, e.id);
    expect(current.version).toBe(3);
    expect(Buffer.compare(current.ciphertext, blobs[2]!)).toBe(0);
  });

  it('throws a clear error when pulling an unknown version', async () => {
    const e = await backend.createEntity('config', 'u', { slug: 'c', name: 'c' });
    await expect(
      backend.pullEntityVersion('config', 'u', e.id, 99),
    ).rejects.toThrow(/Version not found/);
  });

  it('throws when current is requested but no versions exist', async () => {
    const e = await backend.createEntity('config', 'u', { slug: 'c', name: 'c' });
    await expect(
      backend.pullEntityCurrent('config', 'u', e.id),
    ).rejects.toThrow(/no versions/);
  });
});

// ---------------------------------------------------------------------------
// Wrapped DEKs
// ---------------------------------------------------------------------------

describe('FilesystemBackend.wrappedDEKs', () => {
  it('round-trips wrapped DEKs for two recipients independently', async () => {
    const userId = 'owner';
    const e = await backend.createEntity('project', userId, { slug: 'p', name: 'p' });

    const wrapped1 = Buffer.from('wrapped-dek-for-alice');
    const wrapped2 = Buffer.from('wrapped-dek-for-bob-longer-bytes');

    await backend.putWrappedDEK('project', userId, e.id, 'alice', wrapped1);
    await backend.putWrappedDEK('project', userId, e.id, 'bob', wrapped2);

    const gotAlice = await backend.getWrappedDEK('project', userId, e.id, 'alice');
    const gotBob = await backend.getWrappedDEK('project', userId, e.id, 'bob');
    const gotGhost = await backend.getWrappedDEK('project', userId, e.id, 'ghost');

    expect(gotAlice && Buffer.compare(gotAlice, wrapped1)).toBe(0);
    expect(gotBob && Buffer.compare(gotBob, wrapped2)).toBe(0);
    expect(gotGhost).toBeNull();
  });

  it('rejects putWrappedDEK for nonexistent entities', async () => {
    await expect(
      backend.putWrappedDEK('project', 'u', 'no-such-id', 'alice', Buffer.from('x')),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Machine links
// ---------------------------------------------------------------------------

describe('FilesystemBackend.machineLinks', () => {
  it('links an entity to a machine, lists links, unlinks', async () => {
    const userId = 'u';
    const e = await backend.createEntity('project', userId, { slug: 's', name: 'n' });
    const machineId = 'machine-abc';

    await backend.linkEntityToMachine('project', userId, machineId, e.id, {
      localPath: '/home/dev/repo',
      lastSyncedVersion: 1,
    });

    const listed = await backend.listMachineLinks('project', userId, machineId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.entityId).toBe(e.id);
    expect(listed[0]!.localPath).toBe('/home/dev/repo');
    expect(listed[0]!.lastSyncedVersion).toBe(1);

    // Upsert: link again with a bumped version.
    await backend.linkEntityToMachine('project', userId, machineId, e.id, {
      lastSyncedVersion: 5,
    });
    const listed2 = await backend.listMachineLinks('project', userId, machineId);
    expect(listed2).toHaveLength(1);
    expect(listed2[0]!.lastSyncedVersion).toBe(5);
    // Prior localPath is preserved on partial update.
    expect(listed2[0]!.localPath).toBe('/home/dev/repo');

    await backend.unlinkEntityFromMachine('project', userId, machineId, e.id);
    const listed3 = await backend.listMachineLinks('project', userId, machineId);
    expect(listed3).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Headline: full envelope round-trip via FilesystemBackend
// ---------------------------------------------------------------------------

describe('FilesystemBackend envelope round-trip', () => {
  it('encrypts via envelope crypto on machine A and decrypts on machine B', async () => {
    const userId = 'user-42';
    const password = 'correct horse battery staple';
    const plaintext = Buffer.from('the secret contents of my env file', 'utf8');

    // -----------------------------------------------------------------
    // Machine A: generate keypair, wrap, push, store wrapped DEK.
    // -----------------------------------------------------------------
    const keypair = generateUserKeypair();
    const wrappedPriv = wrapPrivateKey(keypair.privateKey, password);

    await backend.putKeypair(userId, {
      publicKey: keypair.publicKey.toString('base64'),
      encryptedPrivateKey: wrappedPriv.ciphertext.toString('base64'),
      kekSalt: wrappedPriv.kekSalt.toString('base64'),
      kekIterations: wrappedPriv.kekIterations,
    });

    // Fresh DEK, wrap to our own public key (owner == sole recipient).
    const dek = generateDEK();
    const wrappedDek = wrapDEK(dek, keypair.publicKey);

    // Encrypt the plaintext with the DEK.
    const ciphertext = encryptBlob(plaintext, dek);

    // Create the entity + push a version + store the wrapped DEK.
    const entity = await backend.createEntity('project', userId, {
      slug: 'secret-proj',
      name: 'Secret Project',
    });
    const pushed = await backend.pushEntityVersion(
      'project',
      userId,
      entity.id,
      ciphertext,
      sha256Hex(plaintext),
    );
    expect(pushed.version).toBe(1);

    await backend.putWrappedDEK('project', userId, entity.id, userId, wrappedDek);

    // -----------------------------------------------------------------
    // Machine B: new FilesystemBackend pointing at the same directory.
    // Prove the data survives an instance boundary.
    // -----------------------------------------------------------------
    const machineB = new FilesystemBackend({ rootPath: tempRoot });

    const keypairRecord = await machineB.getKeypair(userId);
    expect(keypairRecord).not.toBeNull();

    const recoveredPrivate = unwrapPrivateKey(
      {
        ciphertext: Buffer.from(keypairRecord!.encryptedPrivateKey, 'base64'),
        kekSalt: Buffer.from(keypairRecord!.kekSalt, 'base64'),
        kekIterations: keypairRecord!.kekIterations,
      },
      password,
    );
    expect(Buffer.compare(recoveredPrivate, keypair.privateKey)).toBe(0);

    // Fetch entity by slug (simulating a fresh machine that only knows
    // the slug it was asked to pull).
    const entityRef = await machineB.getEntity('project', userId, 'secret-proj');
    expect(entityRef).not.toBeNull();

    const wrappedFromDisk = await machineB.getWrappedDEK(
      'project',
      userId,
      entityRef!.id,
      userId,
    );
    expect(wrappedFromDisk).not.toBeNull();

    const recoveredDek = unwrapDEK(wrappedFromDisk!, {
      publicKey: Buffer.from(keypairRecord!.publicKey, 'base64'),
      privateKey: recoveredPrivate,
    });
    expect(Buffer.compare(recoveredDek, dek)).toBe(0);

    const currentVersion = await machineB.pullEntityCurrent(
      'project',
      userId,
      entityRef!.id,
    );
    const decrypted = decryptBlob(currentVersion.ciphertext, recoveredDek);

    expect(decrypted.toString('utf8')).toBe(plaintext.toString('utf8'));
  });
});
