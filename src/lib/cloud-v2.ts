/**
 * v2 cloud API client for ConfigSync.
 *
 * This is the thin HTTP client used by the v2 commands (`init`,
 * `login`, `project add`, `pull`, `sync`, `vars ...`, `profile ...`).
 * Every method corresponds to one of the 41 routes under
 * configsync-web/app/api/, and every payload uses the envelope crypto
 * library instead of the legacy CryptoManager.
 */

import os from 'node:os';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeypairPayload {
  public_key: string;            // base64
  encrypted_private_key: string; // base64
  kek_salt: string;              // base64
  kek_iterations: number;
  kek_algorithm?: string;
  key_algorithm?: string;
  key_version?: number;
  created_at?: string;
  rotated_at?: string;
}

export interface EntityRow {
  id: number;
  user_id: number;
  slug: string;
  name: string;
  description: string | null;
  r2_key_prefix: string;
  current_version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  [extra: string]: unknown;
}

export interface ProjectRow extends EntityRow {
  git_url: string | null;
  git_branch: string | null;
  env_storage_mode: string;
}

export interface MachineRow {
  id: number;
  user_id: number;
  machine_id: string;
  name: string;
  platform: string | null;
  arch: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface PlanEntity {
  type: 'project' | 'workspace' | 'config' | 'module';
  id: number;
  local_version: number;
  local_hash?: string;
}

export type PlanAction = 'pull' | 'push' | 'conflict' | 'noop' | 'error';

export interface PlanResult {
  type: string;
  id: number;
  action: PlanAction;
  current_version?: number;
  last_synced_version?: number;
  error?: string;
}

export interface EnvVariableRow {
  id: number;
  project_id: number;
  environment_tier: string;
  name: string;
  visibility: 'shared' | 'personal' | 'restricted';
  owner_user_id: number | null;
  description: string | null;
  required: number;
  value_source: 'inline' | 'vault_ref' | 'external_ref';
  encrypted_value: string | null; // base64
  vault_secret_id: number | null;
  encrypted_external_ref: string | null;
  current_version: number;
}

// ---------------------------------------------------------------------------
// CloudV2 client
// ---------------------------------------------------------------------------

export class CloudV2 {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly machineId: string;

  constructor(apiUrl: string, apiKey: string, machineId?: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.machineId = machineId ?? CloudV2.generateMachineId();
  }

  static generateMachineId(): string {
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();

    let mac = '';
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const addrs = interfaces[name];
      if (!addrs) continue;
      for (const addr of addrs) {
        if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
          mac = addr.mac;
          break;
        }
      }
      if (mac) break;
    }

    const raw = `${hostname}-${platform}-${arch}-${mac}`;
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
  }

  private async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const errBody = (await res.json()) as any;
        if (errBody?.error) message = errBody.error;
      } catch {
        /* ignore */
      }
      throw new Error(`${method} ${path} failed: ${message}`);
    }
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async requestRaw(method: string, path: string): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    return fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
  }

  // -------------------------------------------------------------------------
  // Auth / keypair
  // -------------------------------------------------------------------------

  async verifyToken(): Promise<boolean> {
    const res = await this.requestRaw('GET', '/api/auth/verify');
    return res.ok;
  }

  async uploadKeypair(payload: KeypairPayload): Promise<void> {
    await this.request('POST', '/api/auth/keypair', payload);
  }

  /** Returns null on 404 (no keypair exists yet). */
  async fetchKeypair(): Promise<KeypairPayload | null> {
    const res = await this.requestRaw('GET', '/api/auth/keypair');
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GET /api/auth/keypair failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as KeypairPayload;
  }

  // -------------------------------------------------------------------------
  // Machines
  // -------------------------------------------------------------------------

  async registerMachine(name?: string): Promise<MachineRow> {
    const body = {
      machine_id: this.machineId,
      name: name ?? os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      python_version: null,
    };
    const out = await this.request<{ machine: MachineRow }>('POST', '/api/machines/register', body);
    return out.machine;
  }

  // -------------------------------------------------------------------------
  // Entities (projects / workspaces / configs / modules)
  // -------------------------------------------------------------------------

  async listProjects(query?: { git_url?: string }): Promise<ProjectRow[]> {
    const qs = query?.git_url ? `?git_url=${encodeURIComponent(query.git_url)}` : '';
    const out = await this.request<{ projects: ProjectRow[] }>('GET', `/api/projects${qs}`);
    return out.projects ?? [];
  }

  async createProject(body: {
    slug: string;
    name: string;
    description?: string;
    git_url?: string;
    git_branch?: string;
  }): Promise<ProjectRow> {
    const out = await this.request<{ project: ProjectRow }>('POST', '/api/projects', body);
    return out.project;
  }

  async getProject(id: number): Promise<{ project: ProjectRow; wrapped_dek: string | null }> {
    return this.request('GET', `/api/projects/${id}`);
  }

  async pushProjectVersion(
    id: number,
    ciphertextB64: string,
    contentHash: string,
  ): Promise<{ version: number; r2_key: string; size_bytes: number }> {
    return this.request('POST', `/api/projects/${id}/versions`, {
      ciphertext: ciphertextB64,
      content_hash: contentHash,
      pushed_from_machine_id: null,
    });
  }

  async upsertProjectKey(id: number, wrappedDekB64: string, userId: number): Promise<void> {
    await this.request('POST', `/api/projects/${id}/keys`, {
      user_id: userId,
      wrapped_dek: wrappedDekB64,
    });
  }

  async getProjectBlob(id: number): Promise<Buffer> {
    const res = await this.requestRaw('GET', `/api/projects/${id}/blob`);
    if (!res.ok) {
      throw new Error(`GET /api/projects/${id}/blob failed: ${res.status} ${res.statusText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // Workspaces
  async listWorkspaces(): Promise<EntityRow[]> {
    const out = await this.request<{ workspaces: EntityRow[] }>('GET', '/api/workspaces');
    return out.workspaces ?? [];
  }
  async createWorkspace(body: { slug: string; name: string; description?: string }): Promise<EntityRow> {
    const out = await this.request<{ workspace: EntityRow }>('POST', '/api/workspaces', body);
    return out.workspace;
  }

  // Configs
  async listConfigs(): Promise<EntityRow[]> {
    const out = await this.request<{ configs: EntityRow[] }>('GET', '/api/configs');
    return out.configs ?? [];
  }
  async createConfig(body: { slug: string; name: string; source_hint?: string }): Promise<EntityRow> {
    const out = await this.request<{ config: EntityRow }>('POST', '/api/configs', body);
    return out.config;
  }

  // Modules
  async listModules(): Promise<EntityRow[]> {
    const out = await this.request<{ modules: EntityRow[] }>('GET', '/api/modules');
    return out.modules ?? [];
  }
  async createModule(body: {
    slug: string;
    name: string;
    module_type: string;
  }): Promise<EntityRow> {
    const out = await this.request<{ module: EntityRow }>('POST', '/api/modules', body);
    return out.module;
  }

  // -------------------------------------------------------------------------
  // Machine link tables
  // -------------------------------------------------------------------------

  async linkMachineProject(machineId: string, projectId: number, localPath?: string): Promise<void> {
    await this.request('POST', `/api/machines/${machineId}/projects`, {
      project_id: projectId,
      local_path: localPath ?? null,
    });
  }

  async listMachineProjects(machineId: string): Promise<any[]> {
    const out = await this.request<{ projects: any[] }>(
      'GET',
      `/api/machines/${machineId}/projects`,
    );
    return out.projects ?? [];
  }

  async listMachineConfigs(machineId: string): Promise<any[]> {
    const out = await this.request<{ configs: any[] }>(
      'GET',
      `/api/machines/${machineId}/configs`,
    );
    return out.configs ?? [];
  }

  async listMachineModules(machineId: string): Promise<any[]> {
    const out = await this.request<{ modules: any[] }>(
      'GET',
      `/api/machines/${machineId}/modules`,
    );
    return out.modules ?? [];
  }

  async patchMachineProject(
    machineId: string,
    projectId: number,
    body: { last_synced_version?: number; local_path?: string },
  ): Promise<void> {
    await this.request('PATCH', `/api/machines/${machineId}/projects/${projectId}`, body);
  }

  // -------------------------------------------------------------------------
  // Sync helpers
  // -------------------------------------------------------------------------

  async syncPlan(
    machineId: string,
    entities: PlanEntity[],
  ): Promise<PlanResult[]> {
    const out = await this.request<{ actions: PlanResult[] }>('POST', '/api/sync/plan', {
      machine_id: machineId,
      entities,
    });
    return out.actions ?? [];
  }

  async syncCommit(
    machineId: string,
    updates: { entity_type: string; entity_id: number; new_last_synced_version: number }[],
  ): Promise<void> {
    await this.request('POST', '/api/sync/commit', { machine_id: machineId, updates });
  }

  // -------------------------------------------------------------------------
  // Env variables (Layer 5)
  // -------------------------------------------------------------------------

  async listEnvVariables(
    projectId: number,
    query: { env?: string; visibility?: string } = {},
  ): Promise<EnvVariableRow[]> {
    const params = new URLSearchParams();
    if (query.env) params.set('env', query.env);
    if (query.visibility) params.set('visibility', query.visibility);
    const qs = params.toString() ? `?${params}` : '';
    const out = await this.request<{ variables: EnvVariableRow[] }>(
      'GET',
      `/api/projects/${projectId}/env${qs}`,
    );
    return out.variables ?? [];
  }

  async upsertEnvVariable(
    projectId: number,
    name: string,
    body: {
      environment_tier: string;
      visibility: 'shared' | 'personal' | 'restricted';
      owner_user_id?: number;
      description?: string;
      required?: boolean;
      value_source: 'inline' | 'vault_ref' | 'external_ref';
      encrypted_value?: string;
    },
  ): Promise<void> {
    await this.request('PUT', `/api/projects/${projectId}/env/${encodeURIComponent(name)}`, body);
  }

  async deleteEnvVariable(
    projectId: number,
    name: string,
    env: string,
    visibility = 'shared',
  ): Promise<void> {
    const qs = new URLSearchParams({ env, visibility }).toString();
    await this.request('DELETE', `/api/projects/${projectId}/env/${encodeURIComponent(name)}?${qs}`);
  }

  async uploadEnvLayerKey(
    projectId: number,
    layerId: string,
    wrappedDekB64: string,
  ): Promise<void> {
    await this.request('POST', `/api/projects/${projectId}/env/keys`, {
      layer_id: layerId,
      wrapped_dek: wrappedDekB64,
    });
  }

  // -------------------------------------------------------------------------
  // Profiles (Wave 2 — assume same patterns as /api/projects)
  // -------------------------------------------------------------------------

  async listProfiles(): Promise<any[]> {
    const out = await this.request<{ profiles: any[] }>('GET', '/api/profiles');
    return out.profiles ?? [];
  }

  async createProfile(body: {
    slug: string;
    name: string;
    description?: string;
    is_default?: boolean;
  }): Promise<any> {
    const out = await this.request<{ profile: any }>('POST', '/api/profiles', body);
    return out.profile;
  }

  async getProfile(id: number): Promise<any> {
    return this.request('GET', `/api/profiles/${id}`);
  }

  async patchProfile(id: number, body: Record<string, unknown>): Promise<any> {
    return this.request('PATCH', `/api/profiles/${id}`, body);
  }

  async deleteProfile(id: number): Promise<void> {
    await this.request('DELETE', `/api/profiles/${id}`);
  }

  async pushProfileVersion(
    id: number,
    ciphertextB64: string,
    contentHash: string,
  ): Promise<{ version: number }> {
    return this.request('POST', `/api/profiles/${id}/versions`, {
      ciphertext: ciphertextB64,
      content_hash: contentHash,
      pushed_from_machine_id: null,
    });
  }

  async getProfileBlob(id: number): Promise<Buffer> {
    const res = await this.requestRaw('GET', `/api/profiles/${id}/blob`);
    if (!res.ok) {
      throw new Error(`GET /api/profiles/${id}/blob failed: ${res.status} ${res.statusText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async upsertProfileKey(id: number, wrappedDekB64: string, userId: number): Promise<void> {
    await this.request('POST', `/api/profiles/${id}/keys`, {
      user_id: userId,
      wrapped_dek: wrappedDekB64,
    });
  }

  async addProfileWorkspace(profileId: number, workspaceId: number): Promise<void> {
    await this.request('POST', `/api/profiles/${profileId}/workspaces`, {
      workspace_id: workspaceId,
    });
  }

  async removeProfileWorkspace(profileId: number, workspaceId: number): Promise<void> {
    await this.request(
      'DELETE',
      `/api/profiles/${profileId}/workspaces/${workspaceId}`,
    );
  }

  async setMachineProfileActive(
    machineId: string,
    profileId: number,
    active: boolean,
  ): Promise<void> {
    await this.request('PATCH', `/api/machines/${machineId}/profiles/${profileId}`, {
      active,
    });
  }

  // -------------------------------------------------------------------------
  // Generic entity helpers (Wave 3)
  //
  // These back the `history`, `diff`, `rollback` and entity-extras CLI
  // commands. They are thin wrappers around the `/api/<entity>/:id/...`
  // routes and use `project | workspace | config | module | profile` as
  // the `entity` path prefix.
  // -------------------------------------------------------------------------

  /** Fetch the full version list for an entity, newest first. */
  async listEntityVersions(
    entity: 'project' | 'workspace' | 'config' | 'module' | 'profile',
    id: number,
  ): Promise<VersionRow[]> {
    const out = await this.request<{ versions: VersionRow[] }>(
      'GET',
      `/api/${entity}s/${id}/versions`,
    );
    return out.versions ?? [];
  }

  /** Fetch and return an entity's current encrypted blob bytes. */
  async getEntityBlob(
    entity: 'project' | 'workspace' | 'config' | 'module' | 'profile',
    id: number,
  ): Promise<Buffer> {
    const res = await this.requestRaw('GET', `/api/${entity}s/${id}/blob`);
    if (!res.ok) {
      throw new Error(
        `GET /api/${entity}s/${id}/blob failed: ${res.status} ${res.statusText}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Fetch a specific historical version's encrypted blob bytes.
   * The route is `GET /api/<entity>s/:id/versions/:n` and returns the
   * raw ciphertext directly (not a JSON wrapper).
   */
  async getEntityVersionBlob(
    entity: 'project' | 'workspace' | 'config' | 'module' | 'profile',
    id: number,
    version: number,
  ): Promise<Buffer> {
    const res = await this.requestRaw(
      'GET',
      `/api/${entity}s/${id}/versions/${version}`,
    );
    if (!res.ok) {
      throw new Error(
        `GET /api/${entity}s/${id}/versions/${version} failed: ${res.status} ${res.statusText}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** Push a new encrypted version for any entity type. */
  async pushEntityVersion(
    entity: 'project' | 'workspace' | 'config' | 'module' | 'profile',
    id: number,
    ciphertextB64: string,
    contentHash: string,
  ): Promise<{ version: number; r2_key?: string; size_bytes?: number }> {
    return this.request('POST', `/api/${entity}s/${id}/versions`, {
      ciphertext: ciphertextB64,
      content_hash: contentHash,
      pushed_from_machine_id: null,
    });
  }

  /** Generic PATCH for renaming an entity (used by workspace/config/module). */
  async patchEntity(
    entity: 'project' | 'workspace' | 'config' | 'module' | 'profile',
    id: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.request('PATCH', `/api/${entity}s/${id}`, body);
  }

  /** Generic DELETE (soft) for any entity. */
  async deleteEntity(
    entity: 'project' | 'workspace' | 'config' | 'module' | 'profile',
    id: number,
  ): Promise<void> {
    await this.request('DELETE', `/api/${entity}s/${id}`);
  }

  /** Fetch an entity row with its wrapped DEK (current user). */
  async getEntity(
    entity: 'project' | 'workspace' | 'config' | 'module' | 'profile',
    id: number,
  ): Promise<{ entity: EntityRow; wrapped_dek: string | null }> {
    const out = await this.request<any>('GET', `/api/${entity}s/${id}`);
    // The project route returns {project, wrapped_dek}; normalise.
    const row = out[entity] ?? out.entity ?? out;
    return { entity: row as EntityRow, wrapped_dek: out.wrapped_dek ?? null };
  }

  /** Upload a wrapped DEK for an entity. */
  async upsertEntityKey(
    entity: 'project' | 'workspace' | 'config' | 'module' | 'profile',
    id: number,
    wrappedDekB64: string,
    userId: number,
  ): Promise<void> {
    await this.request('POST', `/api/${entity}s/${id}/keys`, {
      user_id: userId,
      wrapped_dek: wrappedDekB64,
    });
  }
}

// ---------------------------------------------------------------------------
// Version row shape (matches `entity_versions` table).
// ---------------------------------------------------------------------------

export interface VersionRow {
  id: number;
  version: number;
  r2_key: string;
  size_bytes: number;
  content_hash: string;
  pushed_by_user_id: number | null;
  pushed_from_machine_id: string | null;
  created_at: string;
}

export default CloudV2;
