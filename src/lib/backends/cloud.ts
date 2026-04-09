/**
 * Thin adapter that maps the `Backend` interface onto the existing
 * `CloudV2` HTTP client (`src/lib/cloud-v2.ts`).
 *
 * The cloud API authenticates by bearer token, so the `userId`
 * argument on every `Backend` method is effectively ignored here —
 * the remote server decides which user the token belongs to. It is
 * still accepted so the call signatures stay interchangeable with
 * `FilesystemBackend`.
 *
 * Not every `CloudV2` endpoint has a one-to-one mapping today (some
 * routes like `patchEntity` and `deleteEntity` are only implemented
 * for a subset of entity types); in those cases this wrapper throws
 * a clear "unsupported" error. Those gaps are not a blocker for the
 * Wave 3 abstraction because the filesystem backend is the target for
 * the headline cross-machine test — the cloud adapter only needs to
 * compile against the interface and handle the methods the existing
 * commands already use.
 */

import type {
  Backend,
  EntityRecord,
  EntityType,
  EntityVersionRecord,
  MachineLinkRecord,
  UserKeypairRecord,
} from '../backend.js';
import type { CloudV2, EntityRow, KeypairPayload } from '../cloud-v2.js';

function rowToRecord(type: EntityType, row: EntityRow): EntityRecord {
  const {
    id,
    user_id,
    slug,
    name,
    description,
    current_version,
    deleted_at,
    created_at,
    updated_at,
    r2_key_prefix: _r2,
    ...extras
  } = row;

  return {
    id: String(id),
    userId: String(user_id),
    type,
    slug,
    name,
    description: description ?? null,
    currentVersion: current_version ?? 0,
    createdAt: created_at,
    updatedAt: updated_at,
    deletedAt: deleted_at ?? null,
    fields: extras as Record<string, unknown>,
  };
}

function keypairPayloadToRecord(p: KeypairPayload): UserKeypairRecord {
  return {
    publicKey: p.public_key,
    encryptedPrivateKey: p.encrypted_private_key,
    kekSalt: p.kek_salt,
    kekIterations: p.kek_iterations,
    kekAlgorithm: p.kek_algorithm,
    keyAlgorithm: p.key_algorithm,
    keyVersion: p.key_version,
    createdAt: p.created_at,
    rotatedAt: p.rotated_at,
  };
}

function recordToKeypairPayload(r: UserKeypairRecord): KeypairPayload {
  return {
    public_key: r.publicKey,
    encrypted_private_key: r.encryptedPrivateKey,
    kek_salt: r.kekSalt,
    kek_iterations: r.kekIterations,
    kek_algorithm: r.kekAlgorithm,
    key_algorithm: r.keyAlgorithm,
    key_version: r.keyVersion,
    created_at: r.createdAt,
    rotated_at: r.rotatedAt,
  };
}

function unsupported(method: string, type: EntityType): never {
  throw new Error(`CloudBackend.${method} is not supported for entity type "${type}"`);
}

export class CloudBackend implements Backend {
  readonly client: CloudV2;

  constructor(client: CloudV2) {
    this.client = client;
  }

  // -------------------------------------------------------------------------
  // Keypair
  // -------------------------------------------------------------------------

  async putKeypair(_userId: string, record: UserKeypairRecord): Promise<void> {
    await this.client.uploadKeypair(recordToKeypairPayload(record));
  }

  async getKeypair(_userId: string): Promise<UserKeypairRecord | null> {
    const payload = await this.client.fetchKeypair();
    return payload ? keypairPayloadToRecord(payload) : null;
  }

  // -------------------------------------------------------------------------
  // Entity CRUD
  // -------------------------------------------------------------------------

  async createEntity(
    type: EntityType,
    _userId: string,
    fields: { slug: string; name: string; description?: string | null; [k: string]: unknown },
  ): Promise<EntityRecord> {
    switch (type) {
      case 'project': {
        const row = await this.client.createProject({
          slug: fields.slug,
          name: fields.name,
          description: fields.description ?? undefined,
          git_url: fields.git_url as string | undefined,
          git_branch: fields.git_branch as string | undefined,
        });
        return rowToRecord('project', row);
      }
      case 'workspace': {
        const row = await this.client.createWorkspace({
          slug: fields.slug,
          name: fields.name,
          description: fields.description ?? undefined,
        });
        return rowToRecord('workspace', row);
      }
      case 'config': {
        const row = await this.client.createConfig({
          slug: fields.slug,
          name: fields.name,
          source_hint: fields.source_hint as string | undefined,
        });
        return rowToRecord('config', row);
      }
      case 'module': {
        const row = await this.client.createModule({
          slug: fields.slug,
          name: fields.name,
          module_type: (fields.module_type as string) ?? 'generic',
        });
        return rowToRecord('module', row);
      }
      case 'profile': {
        const row = (await this.client.createProfile({
          slug: fields.slug,
          name: fields.name,
          description: fields.description ?? undefined,
          is_default: fields.is_default as boolean | undefined,
        })) as EntityRow;
        return rowToRecord('profile', row);
      }
    }
  }

  async getEntity(
    type: EntityType,
    _userId: string,
    idOrSlug: string,
  ): Promise<EntityRecord | null> {
    // The cloud API uses numeric ids for direct fetch; slugs require
    // list-and-filter.
    const numericId = Number.parseInt(idOrSlug, 10);
    if (Number.isFinite(numericId) && String(numericId) === idOrSlug) {
      if (type === 'project') {
        const res = await this.client.getProject(numericId);
        return rowToRecord('project', res.project);
      }
      if (type === 'profile') {
        const res = (await this.client.getProfile(numericId)) as { profile: EntityRow };
        return rowToRecord('profile', res.profile);
      }
    }

    const rows = await this.listEntitiesRaw(type);
    const hit = rows.find((r) => r.slug === idOrSlug || String(r.id) === idOrSlug);
    return hit ? rowToRecord(type, hit) : null;
  }

  async listEntities(type: EntityType, _userId: string): Promise<EntityRecord[]> {
    const rows = await this.listEntitiesRaw(type);
    return rows.map((r) => rowToRecord(type, r));
  }

  private async listEntitiesRaw(type: EntityType): Promise<EntityRow[]> {
    switch (type) {
      case 'project':
        return this.client.listProjects();
      case 'workspace':
        return this.client.listWorkspaces();
      case 'config':
        return this.client.listConfigs();
      case 'module':
        return this.client.listModules();
      case 'profile':
        return (await this.client.listProfiles()) as EntityRow[];
    }
  }

  async patchEntity(
    type: EntityType,
    _userId: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<EntityRecord> {
    if (type === 'profile') {
      const row = (await this.client.patchProfile(Number(id), fields)) as { profile: EntityRow };
      return rowToRecord('profile', row.profile);
    }
    unsupported('patchEntity', type);
  }

  async deleteEntity(type: EntityType, _userId: string, id: string): Promise<void> {
    if (type === 'profile') {
      await this.client.deleteProfile(Number(id));
      return;
    }
    unsupported('deleteEntity', type);
  }

  // -------------------------------------------------------------------------
  // Entity versions
  // -------------------------------------------------------------------------

  async pushEntityVersion(
    type: EntityType,
    _userId: string,
    entityId: string,
    ciphertext: Buffer,
    contentHash: string,
    _machineId?: string,
  ): Promise<EntityVersionRecord> {
    const b64 = ciphertext.toString('base64');
    if (type === 'project') {
      const res = await this.client.pushProjectVersion(Number(entityId), b64, contentHash);
      return {
        entityId,
        version: res.version,
        ciphertext,
        contentHash,
        pushedFromMachineId: null,
        createdAt: new Date().toISOString(),
        sizeBytes: res.size_bytes ?? ciphertext.length,
      };
    }
    if (type === 'profile') {
      const res = await this.client.pushProfileVersion(Number(entityId), b64, contentHash);
      return {
        entityId,
        version: res.version,
        ciphertext,
        contentHash,
        pushedFromMachineId: null,
        createdAt: new Date().toISOString(),
        sizeBytes: ciphertext.length,
      };
    }
    unsupported('pushEntityVersion', type);
  }

  async pullEntityVersion(
    type: EntityType,
    _userId: string,
    _entityId: string,
    _version: number,
  ): Promise<EntityVersionRecord> {
    // The cloud API only exposes a "current" blob endpoint today; a
    // per-version blob endpoint is deferred to Wave 4.
    unsupported('pullEntityVersion', type);
  }

  async pullEntityCurrent(
    type: EntityType,
    _userId: string,
    entityId: string,
  ): Promise<EntityVersionRecord> {
    if (type === 'project') {
      const blob = await this.client.getProjectBlob(Number(entityId));
      const { project } = await this.client.getProject(Number(entityId));
      return {
        entityId,
        version: project.current_version,
        ciphertext: blob,
        contentHash: '',
        pushedFromMachineId: null,
        createdAt: project.updated_at,
        sizeBytes: blob.length,
      };
    }
    if (type === 'profile') {
      const blob = await this.client.getProfileBlob(Number(entityId));
      return {
        entityId,
        version: 0,
        ciphertext: blob,
        contentHash: '',
        pushedFromMachineId: null,
        createdAt: new Date().toISOString(),
        sizeBytes: blob.length,
      };
    }
    unsupported('pullEntityCurrent', type);
  }

  async listEntityVersions(
    type: EntityType,
    _userId: string,
    _entityId: string,
  ): Promise<EntityVersionRecord[]> {
    unsupported('listEntityVersions', type);
  }

  // -------------------------------------------------------------------------
  // Wrapped DEKs
  // -------------------------------------------------------------------------

  async putWrappedDEK(
    type: EntityType,
    _userId: string,
    entityId: string,
    recipientUserId: string,
    wrappedDEK: Buffer,
  ): Promise<void> {
    const b64 = wrappedDEK.toString('base64');
    if (type === 'project') {
      await this.client.upsertProjectKey(Number(entityId), b64, Number(recipientUserId));
      return;
    }
    if (type === 'profile') {
      await this.client.upsertProfileKey(Number(entityId), b64, Number(recipientUserId));
      return;
    }
    unsupported('putWrappedDEK', type);
  }

  async getWrappedDEK(
    type: EntityType,
    _userId: string,
    entityId: string,
    _recipientUserId: string,
  ): Promise<Buffer | null> {
    if (type === 'project') {
      const res = await this.client.getProject(Number(entityId));
      if (!res.wrapped_dek) return null;
      return Buffer.from(res.wrapped_dek, 'base64');
    }
    unsupported('getWrappedDEK', type);
  }

  // -------------------------------------------------------------------------
  // Machine link tables
  // -------------------------------------------------------------------------

  async linkEntityToMachine(
    type: EntityType,
    _userId: string,
    machineId: string,
    entityId: string,
    fields: Record<string, unknown>,
  ): Promise<MachineLinkRecord> {
    if (type === 'project') {
      await this.client.linkMachineProject(
        machineId,
        Number(entityId),
        fields.localPath as string | undefined,
      );
      const now = new Date().toISOString();
      return {
        machineId,
        entityType: type,
        entityId,
        lastSyncedVersion:
          typeof fields.lastSyncedVersion === 'number'
            ? (fields.lastSyncedVersion as number)
            : null,
        localPath: (fields.localPath as string) ?? null,
        createdAt: now,
        updatedAt: now,
        fields: {},
      };
    }
    unsupported('linkEntityToMachine', type);
  }

  async listMachineLinks(
    type: EntityType,
    _userId: string,
    machineId: string,
  ): Promise<MachineLinkRecord[]> {
    const toRec = (row: any): MachineLinkRecord => ({
      machineId,
      entityType: type,
      entityId: String(row.entity_id ?? row.project_id ?? row.config_id ?? row.module_id ?? row.id),
      lastSyncedVersion: row.last_synced_version ?? null,
      localPath: row.local_path ?? null,
      createdAt: row.created_at ?? new Date().toISOString(),
      updatedAt: row.updated_at ?? new Date().toISOString(),
      fields: row,
    });

    switch (type) {
      case 'project':
        return (await this.client.listMachineProjects(machineId)).map(toRec);
      case 'config':
        return (await this.client.listMachineConfigs(machineId)).map(toRec);
      case 'module':
        return (await this.client.listMachineModules(machineId)).map(toRec);
      default:
        unsupported('listMachineLinks', type);
    }
  }

  async unlinkEntityFromMachine(
    type: EntityType,
    _userId: string,
    _machineId: string,
    _entityId: string,
  ): Promise<void> {
    unsupported('unlinkEntityFromMachine', type);
  }
}

export default CloudBackend;
