/**
 * Filesystem implementation of the `Backend` interface.
 *
 * Persists every backend call as plain files under a configurable
 * root directory. The layout mirrors configsync-web's D1 + R2 storage
 * so the shape of the data is identical regardless of where it lives:
 *
 *   <root>/
 *     users/<userId>/keypair.json
 *     entities/<type>/<userId>/<entityId>/
 *       metadata.json
 *       versions/v{n}.enc
 *       keys/<recipientUserId>.bin
 *     machines/<machineId>/
 *       info.json
 *       links/{projects,configs,modules,profiles,workspaces}.json
 *     snapshots/<userId>/s{n}.json
 *
 * `metadata.json` is plaintext JSON (entity rows carry no secrets —
 * the only thing that should ever be encrypted is the versioned blob).
 * `v{n}.enc` files hold raw ciphertext bytes exactly as produced by
 * `envelope-crypto.encryptBlob`. `keys/<recipientUserId>.bin` holds the
 * raw wrapped-DEK bytes (see `envelope-crypto.wrapDEK`).
 *
 * Writes that could race with concurrent reads (metadata, link tables,
 * snapshot manifests) go through `atomicWriteFile`, which writes to a
 * sibling `.tmp` file and then renames atomically. Version blobs and
 * wrapped DEKs are content-addressed once written, so they use plain
 * writes.
 *
 * This backend is primarily used by:
 *   1. The full cross-machine integration test (push on "machine A",
 *      pull on "machine B" — the headline v2 bug regression test).
 *   2. Local debugging of the encrypted wire format.
 *   3. Future BYO storage (swap the fs calls for an object-store SDK).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type {
  Backend,
  EntityRecord,
  EntityType,
  EntityVersionRecord,
  MachineLinkRecord,
  UserKeypairRecord,
} from '../backend.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Names used when bucketing machine link tables to disk. */
const LINK_TABLE_NAMES: Record<EntityType, string> = {
  project: 'projects',
  workspace: 'workspaces',
  config: 'configs',
  module: 'modules',
  profile: 'profiles',
};

interface PersistedEntity {
  id: string;
  userId: string;
  type: EntityType;
  slug: string;
  name: string;
  description: string | null;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  fields: Record<string, unknown>;
}

interface PersistedVersion {
  entityId: string;
  version: number;
  contentHash: string;
  pushedFromMachineId: string | null;
  createdAt: string;
  sizeBytes: number;
}

interface PersistedLink {
  machineId: string;
  entityType: EntityType;
  entityId: string;
  lastSyncedVersion: number | null;
  localPath: string | null;
  createdAt: string;
  updatedAt: string;
  fields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// FilesystemBackend
// ---------------------------------------------------------------------------

export interface FilesystemBackendOptions {
  rootPath: string;
}

export class FilesystemBackend implements Backend {
  readonly rootPath: string;

  constructor(options: FilesystemBackendOptions) {
    if (!options?.rootPath) {
      throw new Error('FilesystemBackend requires a rootPath');
    }
    this.rootPath = options.rootPath;
  }

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  private userDir(userId: string): string {
    return path.join(this.rootPath, 'users', userId);
  }

  private keypairPath(userId: string): string {
    return path.join(this.userDir(userId), 'keypair.json');
  }

  private entityTypeDir(type: EntityType, userId: string): string {
    return path.join(this.rootPath, 'entities', type, userId);
  }

  private entityDir(type: EntityType, userId: string, entityId: string): string {
    return path.join(this.entityTypeDir(type, userId), entityId);
  }

  private entityMetadataPath(type: EntityType, userId: string, entityId: string): string {
    return path.join(this.entityDir(type, userId, entityId), 'metadata.json');
  }

  private entityVersionsDir(type: EntityType, userId: string, entityId: string): string {
    return path.join(this.entityDir(type, userId, entityId), 'versions');
  }

  private entityVersionBlobPath(
    type: EntityType,
    userId: string,
    entityId: string,
    version: number,
  ): string {
    return path.join(this.entityVersionsDir(type, userId, entityId), `v${version}.enc`);
  }

  private entityVersionMetaPath(
    type: EntityType,
    userId: string,
    entityId: string,
    version: number,
  ): string {
    return path.join(this.entityVersionsDir(type, userId, entityId), `v${version}.json`);
  }

  private entityKeysDir(type: EntityType, userId: string, entityId: string): string {
    return path.join(this.entityDir(type, userId, entityId), 'keys');
  }

  private wrappedDekPath(
    type: EntityType,
    userId: string,
    entityId: string,
    recipientUserId: string,
  ): string {
    return path.join(this.entityKeysDir(type, userId, entityId), `${recipientUserId}.bin`);
  }

  private machineLinksPath(userId: string, machineId: string, type: EntityType): string {
    const tableName = LINK_TABLE_NAMES[type];
    return path.join(
      this.rootPath,
      'machines',
      machineId,
      'users',
      userId,
      'links',
      `${tableName}.json`,
    );
  }

  // -------------------------------------------------------------------------
  // Low-level IO helpers
  // -------------------------------------------------------------------------

  private async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * Write `data` to `filePath` via a temporary sibling + rename, so
   * concurrent readers never observe a partially-written file.
   */
  private async atomicWriteFile(filePath: string, data: Buffer | string): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  }

  private async readJsonIfExists<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async readBytesIfExists(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Keypair
  // -------------------------------------------------------------------------

  async putKeypair(userId: string, record: UserKeypairRecord): Promise<void> {
    await this.atomicWriteFile(this.keypairPath(userId), JSON.stringify(record, null, 2));
  }

  async getKeypair(userId: string): Promise<UserKeypairRecord | null> {
    return this.readJsonIfExists<UserKeypairRecord>(this.keypairPath(userId));
  }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  async createEntity(
    type: EntityType,
    userId: string,
    fields: {
      slug: string;
      name: string;
      description?: string | null;
      [extra: string]: unknown;
    },
  ): Promise<EntityRecord> {
    if (!fields.slug) throw new Error('createEntity: slug is required');
    if (!fields.name) throw new Error('createEntity: name is required');

    // Ensure slug uniqueness per (type, userId).
    const existing = await this.listEntities(type, userId);
    if (existing.some((e) => e.slug === fields.slug)) {
      throw new Error(`Entity with slug "${fields.slug}" already exists for ${type}`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const { slug, name, description, ...extras } = fields;

    const record: PersistedEntity = {
      id,
      userId,
      type,
      slug,
      name,
      description: description ?? null,
      currentVersion: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      fields: extras,
    };

    await this.atomicWriteFile(
      this.entityMetadataPath(type, userId, id),
      JSON.stringify(record, null, 2),
    );

    return this.persistedToRecord(record);
  }

  async getEntity(
    type: EntityType,
    userId: string,
    idOrSlug: string,
  ): Promise<EntityRecord | null> {
    // Try as id (direct metadata path) first.
    const direct = await this.readJsonIfExists<PersistedEntity>(
      this.entityMetadataPath(type, userId, idOrSlug),
    );
    if (direct && !direct.deletedAt) return this.persistedToRecord(direct);

    // Fall back to slug lookup.
    const all = await this.listEntities(type, userId);
    const bySlug = all.find((e) => e.slug === idOrSlug);
    return bySlug ?? null;
  }

  async listEntities(type: EntityType, userId: string): Promise<EntityRecord[]> {
    const dir = this.entityTypeDir(type, userId);
    let entryNames: string[];
    try {
      entryNames = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const out: EntityRecord[] = [];
    for (const name of entryNames) {
      const meta = await this.readJsonIfExists<PersistedEntity>(
        this.entityMetadataPath(type, userId, name),
      );
      if (meta && !meta.deletedAt) out.push(this.persistedToRecord(meta));
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async patchEntity(
    type: EntityType,
    userId: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<EntityRecord> {
    const metaPath = this.entityMetadataPath(type, userId, id);
    const existing = await this.readJsonIfExists<PersistedEntity>(metaPath);
    if (!existing) {
      throw new Error(`Entity not found: ${type}/${userId}/${id}`);
    }

    // Recognise top-level mutable fields, route the rest into `fields`.
    const topLevel: (keyof PersistedEntity)[] = [
      'slug',
      'name',
      'description',
      'currentVersion',
      'deletedAt',
    ];

    const next: PersistedEntity = {
      ...existing,
      fields: { ...existing.fields },
      updatedAt: new Date().toISOString(),
    };

    for (const [k, v] of Object.entries(fields)) {
      if ((topLevel as string[]).includes(k)) {
        (next as any)[k] = v;
      } else {
        next.fields[k] = v;
      }
    }

    await this.atomicWriteFile(metaPath, JSON.stringify(next, null, 2));
    return this.persistedToRecord(next);
  }

  async deleteEntity(type: EntityType, userId: string, id: string): Promise<void> {
    const metaPath = this.entityMetadataPath(type, userId, id);
    const existing = await this.readJsonIfExists<PersistedEntity>(metaPath);
    if (!existing) {
      throw new Error(`Entity not found: ${type}/${userId}/${id}`);
    }
    const next: PersistedEntity = {
      ...existing,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.atomicWriteFile(metaPath, JSON.stringify(next, null, 2));
  }

  private persistedToRecord(p: PersistedEntity): EntityRecord {
    return {
      id: p.id,
      userId: p.userId,
      type: p.type,
      slug: p.slug,
      name: p.name,
      description: p.description,
      currentVersion: p.currentVersion,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      deletedAt: p.deletedAt,
      fields: p.fields ?? {},
    };
  }

  // -------------------------------------------------------------------------
  // Entity versions
  // -------------------------------------------------------------------------

  async pushEntityVersion(
    type: EntityType,
    userId: string,
    entityId: string,
    ciphertext: Buffer,
    contentHash: string,
    machineId?: string,
  ): Promise<EntityVersionRecord> {
    const metaPath = this.entityMetadataPath(type, userId, entityId);
    const meta = await this.readJsonIfExists<PersistedEntity>(metaPath);
    if (!meta) {
      throw new Error(`Entity not found: ${type}/${userId}/${entityId}`);
    }

    const nextVersion = meta.currentVersion + 1;
    const blobPath = this.entityVersionBlobPath(type, userId, entityId, nextVersion);
    const sidecarPath = this.entityVersionMetaPath(type, userId, entityId, nextVersion);

    await this.ensureDir(path.dirname(blobPath));
    // Content-addressed (version numbers never repeat), so plain write.
    await fs.writeFile(blobPath, ciphertext);

    const now = new Date().toISOString();
    const sidecar: PersistedVersion = {
      entityId,
      version: nextVersion,
      contentHash,
      pushedFromMachineId: machineId ?? null,
      createdAt: now,
      sizeBytes: ciphertext.length,
    };
    await this.atomicWriteFile(sidecarPath, JSON.stringify(sidecar, null, 2));

    // Bump current_version in metadata atomically.
    const nextMeta: PersistedEntity = {
      ...meta,
      currentVersion: nextVersion,
      updatedAt: now,
    };
    await this.atomicWriteFile(metaPath, JSON.stringify(nextMeta, null, 2));

    return {
      entityId,
      version: nextVersion,
      ciphertext,
      contentHash,
      pushedFromMachineId: sidecar.pushedFromMachineId,
      createdAt: now,
      sizeBytes: ciphertext.length,
    };
  }

  async pullEntityVersion(
    type: EntityType,
    userId: string,
    entityId: string,
    version: number,
  ): Promise<EntityVersionRecord> {
    const blobPath = this.entityVersionBlobPath(type, userId, entityId, version);
    const sidecarPath = this.entityVersionMetaPath(type, userId, entityId, version);

    const ciphertext = await this.readBytesIfExists(blobPath);
    if (!ciphertext) {
      throw new Error(`Version not found: ${type}/${userId}/${entityId}@v${version}`);
    }
    const sidecar = await this.readJsonIfExists<PersistedVersion>(sidecarPath);
    if (!sidecar) {
      throw new Error(
        `Version metadata missing: ${type}/${userId}/${entityId}@v${version}`,
      );
    }

    return {
      entityId,
      version,
      ciphertext,
      contentHash: sidecar.contentHash,
      pushedFromMachineId: sidecar.pushedFromMachineId,
      createdAt: sidecar.createdAt,
      sizeBytes: sidecar.sizeBytes,
    };
  }

  async pullEntityCurrent(
    type: EntityType,
    userId: string,
    entityId: string,
  ): Promise<EntityVersionRecord> {
    const meta = await this.readJsonIfExists<PersistedEntity>(
      this.entityMetadataPath(type, userId, entityId),
    );
    if (!meta) {
      throw new Error(`Entity not found: ${type}/${userId}/${entityId}`);
    }
    if (meta.currentVersion === 0) {
      throw new Error(`Entity has no versions yet: ${type}/${userId}/${entityId}`);
    }
    return this.pullEntityVersion(type, userId, entityId, meta.currentVersion);
  }

  async listEntityVersions(
    type: EntityType,
    userId: string,
    entityId: string,
  ): Promise<EntityVersionRecord[]> {
    const dir = this.entityVersionsDir(type, userId, entityId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const versions: EntityVersionRecord[] = [];
    for (const name of names) {
      const match = /^v(\d+)\.enc$/.exec(name);
      if (!match) continue;
      const version = Number.parseInt(match[1]!, 10);
      versions.push(await this.pullEntityVersion(type, userId, entityId, version));
    }
    return versions.sort((a, b) => a.version - b.version);
  }

  // -------------------------------------------------------------------------
  // Wrapped DEKs
  // -------------------------------------------------------------------------

  async putWrappedDEK(
    type: EntityType,
    userId: string,
    entityId: string,
    recipientUserId: string,
    wrappedDEK: Buffer,
  ): Promise<void> {
    // Make sure the parent entity exists — if not we'd be writing
    // orphan keys.
    const meta = await this.readJsonIfExists<PersistedEntity>(
      this.entityMetadataPath(type, userId, entityId),
    );
    if (!meta) {
      throw new Error(`Entity not found: ${type}/${userId}/${entityId}`);
    }

    const target = this.wrappedDekPath(type, userId, entityId, recipientUserId);
    await this.atomicWriteFile(target, wrappedDEK);
  }

  async getWrappedDEK(
    type: EntityType,
    userId: string,
    entityId: string,
    recipientUserId: string,
  ): Promise<Buffer | null> {
    return this.readBytesIfExists(
      this.wrappedDekPath(type, userId, entityId, recipientUserId),
    );
  }

  // -------------------------------------------------------------------------
  // Machine link tables
  // -------------------------------------------------------------------------

  async linkEntityToMachine(
    type: EntityType,
    userId: string,
    machineId: string,
    entityId: string,
    fields: Record<string, unknown>,
  ): Promise<MachineLinkRecord> {
    const linkPath = this.machineLinksPath(userId, machineId, type);
    const existing = (await this.readJsonIfExists<PersistedLink[]>(linkPath)) ?? [];

    const now = new Date().toISOString();
    const topLevel = new Set(['lastSyncedVersion', 'localPath']);

    const lastSyncedVersion =
      typeof fields.lastSyncedVersion === 'number' ? (fields.lastSyncedVersion as number) : null;
    const localPath =
      typeof fields.localPath === 'string' ? (fields.localPath as string) : null;
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!topLevel.has(k)) extras[k] = v;
    }

    const idx = existing.findIndex((l) => l.entityId === entityId);
    let next: PersistedLink;
    if (idx >= 0) {
      const prev = existing[idx]!;
      next = {
        ...prev,
        lastSyncedVersion: fields.lastSyncedVersion !== undefined
          ? lastSyncedVersion
          : prev.lastSyncedVersion,
        localPath: fields.localPath !== undefined ? localPath : prev.localPath,
        fields: { ...prev.fields, ...extras },
        updatedAt: now,
      };
      existing[idx] = next;
    } else {
      next = {
        machineId,
        entityType: type,
        entityId,
        lastSyncedVersion,
        localPath,
        createdAt: now,
        updatedAt: now,
        fields: extras,
      };
      existing.push(next);
    }

    await this.atomicWriteFile(linkPath, JSON.stringify(existing, null, 2));
    return next;
  }

  async listMachineLinks(
    type: EntityType,
    userId: string,
    machineId: string,
  ): Promise<MachineLinkRecord[]> {
    const linkPath = this.machineLinksPath(userId, machineId, type);
    const existing = await this.readJsonIfExists<PersistedLink[]>(linkPath);
    return existing ?? [];
  }

  async unlinkEntityFromMachine(
    type: EntityType,
    userId: string,
    machineId: string,
    entityId: string,
  ): Promise<void> {
    const linkPath = this.machineLinksPath(userId, machineId, type);
    const existing = await this.readJsonIfExists<PersistedLink[]>(linkPath);
    if (!existing) return;
    const next = existing.filter((l) => l.entityId !== entityId);
    if (next.length === existing.length) return;
    await this.atomicWriteFile(linkPath, JSON.stringify(next, null, 2));
  }
}

export default FilesystemBackend;
