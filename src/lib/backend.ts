/**
 * Storage backend abstraction for ConfigSync v2.
 *
 * v1 hard-wired every command against the Cloudflare-hosted HTTP API.
 * v2 factors that API surface into a `Backend` interface so the same
 * push/pull/sync code can run against:
 *
 *   - `CloudBackend`      — the hosted configsync.dev API (production)
 *   - `FilesystemBackend` — a local directory tree (testing, BYO storage)
 *   - (future) S3 / GCS / Azure Blob backends for v5+ BYO storage
 *
 * The interface is deliberately small and storage-shaped: it speaks in
 * terms of entity rows, versioned ciphertext blobs, wrapped DEKs, and
 * machine link tables. Business logic (envelope crypto, sync planning,
 * conflict resolution) lives one layer up and is backend-agnostic.
 *
 * See configsync-web/docs/REFACTOR_V2_PLAN.md §M.1 for the original
 * design notes and the file layout used by `FilesystemBackend`.
 */

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

/**
 * The five top-level entity kinds in v2. Every entity lives under one
 * of these namespaces in both the cloud database and the filesystem
 * backend's directory tree.
 */
export type EntityType = 'project' | 'workspace' | 'config' | 'module' | 'profile';

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

/**
 * The per-user keypair record. Mirrors the cloud's `user_keys` row.
 *
 * - `publicKey` is stored plaintext (base64).
 * - `encryptedPrivateKey` is the X25519 secret key wrapped with a KEK
 *   derived from the user's master password + `kekSalt`, using
 *   `kekIterations` rounds of PBKDF2-HMAC-SHA256.
 * - All byte-valued fields are base64-encoded strings for JSON safety.
 */
export interface UserKeypairRecord {
  publicKey: string;            // base64
  encryptedPrivateKey: string;  // base64
  kekSalt: string;              // base64
  kekIterations: number;
  kekAlgorithm?: string;
  keyAlgorithm?: string;
  keyVersion?: number;
  createdAt?: string;
  rotatedAt?: string;
}

/**
 * A single entity row as stored by the backend. This is the metadata
 * envelope — the actual ciphertext payload lives in version records.
 *
 * `id` is the primary key, `slug` is a URL-safe per-user unique
 * identifier, and `currentVersion` points at the latest
 * `EntityVersionRecord`. Extra type-specific fields (e.g. `gitUrl` for
 * projects, `moduleType` for modules) ride along in `fields`.
 */
export interface EntityRecord {
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
  /** Type-specific extra columns (gitUrl, moduleType, is_default, ...). */
  fields: Record<string, unknown>;
}

/**
 * A single versioned ciphertext row. The actual bytes live at
 * `ciphertext`; `contentHash` is a plaintext-hash fingerprint used by
 * the sync planner to detect no-op pushes.
 */
export interface EntityVersionRecord {
  entityId: string;
  version: number;
  ciphertext: Buffer;
  contentHash: string;
  pushedFromMachineId: string | null;
  createdAt: string;
  sizeBytes: number;
}

/**
 * A row in one of the machine link tables
 * (`machine_projects` / `machine_configs` / `machine_modules` / ...).
 *
 * Links are how a machine declares "I track this entity locally" so
 * the sync planner knows which versions to compare.
 */
export interface MachineLinkRecord {
  machineId: string;
  entityType: EntityType;
  entityId: string;
  lastSyncedVersion: number | null;
  localPath: string | null;
  createdAt: string;
  updatedAt: string;
  /** Extra link-table-specific columns (active flag for profiles, ...). */
  fields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * Abstract storage backend. Every method is async; implementations may
 * hit network IO (`CloudBackend`), disk IO (`FilesystemBackend`), or
 * eventually object storage APIs.
 *
 * Errors are surfaced as thrown `Error`s. Implementations should throw
 * clearly-worded messages when an entity or version is missing so
 * callers can distinguish "not found" from "backend is broken".
 */
export interface Backend {
  // -------------------------------------------------------------------------
  // Keypair storage
  // -------------------------------------------------------------------------

  putKeypair(userId: string, record: UserKeypairRecord): Promise<void>;
  getKeypair(userId: string): Promise<UserKeypairRecord | null>;

  // -------------------------------------------------------------------------
  // Entity CRUD
  // -------------------------------------------------------------------------

  createEntity(
    type: EntityType,
    userId: string,
    fields: {
      slug: string;
      name: string;
      description?: string | null;
      [extra: string]: unknown;
    },
  ): Promise<EntityRecord>;

  /** Look up an entity by its numeric/string id or by its slug. */
  getEntity(
    type: EntityType,
    userId: string,
    idOrSlug: string,
  ): Promise<EntityRecord | null>;

  listEntities(type: EntityType, userId: string): Promise<EntityRecord[]>;

  patchEntity(
    type: EntityType,
    userId: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<EntityRecord>;

  deleteEntity(type: EntityType, userId: string, id: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Entity versions (encrypted blob payloads)
  // -------------------------------------------------------------------------

  pushEntityVersion(
    type: EntityType,
    userId: string,
    entityId: string,
    ciphertext: Buffer,
    contentHash: string,
    machineId?: string,
  ): Promise<EntityVersionRecord>;

  pullEntityVersion(
    type: EntityType,
    userId: string,
    entityId: string,
    version: number,
  ): Promise<EntityVersionRecord>;

  pullEntityCurrent(
    type: EntityType,
    userId: string,
    entityId: string,
  ): Promise<EntityVersionRecord>;

  listEntityVersions(
    type: EntityType,
    userId: string,
    entityId: string,
  ): Promise<EntityVersionRecord[]>;

  // -------------------------------------------------------------------------
  // Wrapped DEKs (per-recipient envelope keys)
  // -------------------------------------------------------------------------

  putWrappedDEK(
    type: EntityType,
    userId: string,
    entityId: string,
    recipientUserId: string,
    wrappedDEK: Buffer,
  ): Promise<void>;

  getWrappedDEK(
    type: EntityType,
    userId: string,
    entityId: string,
    recipientUserId: string,
  ): Promise<Buffer | null>;

  // -------------------------------------------------------------------------
  // Machine link tables
  // -------------------------------------------------------------------------

  linkEntityToMachine(
    type: EntityType,
    userId: string,
    machineId: string,
    entityId: string,
    fields: Record<string, unknown>,
  ): Promise<MachineLinkRecord>;

  listMachineLinks(
    type: EntityType,
    userId: string,
    machineId: string,
  ): Promise<MachineLinkRecord[]>;

  unlinkEntityFromMachine(
    type: EntityType,
    userId: string,
    machineId: string,
    entityId: string,
  ): Promise<void>;
}
