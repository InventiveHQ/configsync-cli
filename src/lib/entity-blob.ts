/**
 * Encrypted entity blob format for v2.
 *
 * A project, config, module, or profile blob is a JSON document that
 * lists the tracked files and their contents. The JSON is encrypted
 * with the entity's DEK via AES-256-GCM (AAD bound to entity type, id
 * and version per §4.4 of the plan).
 *
 * The blob format is intentionally simple — just enough to pack a
 * directory of tracked files and restore them on another machine.
 * Future versions can add more fields without breaking old clients
 * because the outer shape carries a `schema_version`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { encryptBlob, decryptBlob } from './envelope-crypto.js';

export interface BlobFileEntry {
  /** Path relative to the entity root (for projects, relative to the
   *  git checkout; for configs, just a filename). */
  rel_path: string;
  /** File mode (octal, e.g. 0o644). */
  mode: number;
  /** base64-encoded raw file contents. */
  content_b64: string;
  /** SHA-256 of the raw content, hex-encoded. */
  sha256: string;
}

export interface EntityBlob {
  schema_version: 1;
  entity_type: 'project' | 'config' | 'module' | 'profile' | 'workspace';
  slug: string;
  captured_at: string;
  /** Optional git metadata for projects. */
  git?: {
    url?: string;
    branch?: string;
    commit?: string;
  };
  /** List of tracked files. */
  files: BlobFileEntry[];
  /** Arbitrary extra metadata (profile packages, module extras, ...) */
  extras?: Record<string, unknown>;
}

export function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

/** Walk a directory recursively. Returns absolute file paths. Ignores .git. */
export function walkFiles(root: string, opts: { includeHidden?: boolean } = {}): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // Always skip VCS and node_modules by default; keep blobs small.
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (!opts.includeHidden && e.name.startsWith('.') && e.name !== '.env' && !e.name.startsWith('.env.')) {
        // skip hidden dotfiles except .env*
        if (e.isDirectory()) continue;
      }
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Build a project blob from a directory, capturing .env* files and any
 * explicitly listed tracked paths. Keeps the blob tiny — the blob is
 * NOT a full repo mirror; that's what the git URL is for. The blob is
 * for the bits git doesn't track (secrets, local overrides, etc.).
 */
export function buildProjectBlob(params: {
  slug: string;
  rootPath: string;
  trackedFiles?: string[]; // additional rel paths to include
  gitUrl?: string;
  gitBranch?: string;
  gitCommit?: string;
}): EntityBlob {
  const { slug, rootPath, trackedFiles = [], gitUrl, gitBranch, gitCommit } = params;
  const files: BlobFileEntry[] = [];

  // Always capture .env, .env.local, .env.*.local, .dev.vars, .mcp.json
  // from the project root.
  const rootEntries = fs.existsSync(rootPath) ? fs.readdirSync(rootPath) : [];
  const defaultSecrets = rootEntries.filter((n) => {
    return (
      n === '.env' ||
      n.startsWith('.env.') ||
      n === '.dev.vars' ||
      n === '.mcp.json'
    );
  });

  const relSet = new Set<string>([...defaultSecrets, ...trackedFiles]);
  for (const rel of relSet) {
    const abs = path.join(rootPath, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const content = fs.readFileSync(abs);
    files.push({
      rel_path: rel,
      mode: fs.statSync(abs).mode & 0o777,
      content_b64: content.toString('base64'),
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    });
  }

  return {
    schema_version: 1,
    entity_type: 'project',
    slug,
    captured_at: new Date().toISOString(),
    git: gitUrl ? { url: gitUrl, branch: gitBranch, commit: gitCommit } : undefined,
    files,
  };
}

/** Serialize a blob to JSON bytes. */
export function blobToBytes(blob: EntityBlob): Buffer {
  return Buffer.from(JSON.stringify(blob));
}
export function bytesToBlob(bytes: Buffer): EntityBlob {
  return JSON.parse(bytes.toString('utf-8')) as EntityBlob;
}

/** Compute a SHA-256 hash of a serialized blob (matches D1 content_hash). */
export function hashBlob(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build the AAD for entity blob AEAD. The plan's §4.4 recommends
 * `entity_type|entity_id|version`, but including the version creates a
 * race between the CLI's local prediction and the server's assigned
 * version. For v2's solo-user model we drop the version component to
 * sidestep the race; `entity_type|entity_id` is still enough to
 * prevent cross-entity and cross-type swap attacks.
 *
 * The `version` parameter is kept in the signature for forward-compat
 * in case a future iteration adopts an atomic reservation endpoint.
 */
export function aadFor(entityType: string, entityId: number, _version: number): Buffer {
  return Buffer.from(`${entityType}|${entityId}`);
}

/** Encrypt a blob with a DEK. AAD binds to {type, id, version}. */
export function encryptEntityBlob(
  bytes: Buffer,
  dek: Buffer,
  entityType: string,
  entityId: number,
  version: number,
): Buffer {
  return encryptBlob(bytes, dek, aadFor(entityType, entityId, version));
}

export function decryptEntityBlob(
  ciphertext: Buffer,
  dek: Buffer,
  entityType: string,
  entityId: number,
  version: number,
): Buffer {
  const aad = aadFor(entityType, entityId, version);
  try {
    return decryptBlob(ciphertext, dek, aad);
  } catch (err: any) {
    const msg = err.message ?? String(err);
    const detailedError = 
      `Decryption failed for ${entityType} (id=${entityId}, v${version})\n` +
      `  Error: ${msg}\n` +
      `  AAD: ${aad.toString('utf-8')}\n` +
      `  DEK size: ${dek.length} bytes\n` +
      `  Ciphertext size: ${ciphertext.length} bytes\n` +
      `  This usually indicates a master password mismatch or a corrupted keypair on this machine.`;
    
    // Log directly to stderr to bypass any possible catch-and-silence logic
    process.stderr.write(`\n--- DECRYPTION ERROR ---\n${detailedError}\n-----------------------\n\n`);
    
    throw new Error(detailedError);
  }
}

/** Apply a blob's file list to a target directory (used by pull). */
export function applyBlobFiles(blob: EntityBlob, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const f of blob.files) {
    const abs = path.join(targetDir, f.rel_path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = Buffer.from(f.content_b64, 'base64');
    fs.writeFileSync(abs, content, { mode: f.mode || 0o644 });
  }
}
