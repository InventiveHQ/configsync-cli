/**
 * Local cache of wrapped DEKs for env variable layers.
 *
 * The server has `POST /api/projects/:id/env/keys` for uploading a
 * wrapped layer DEK but does not currently expose a GET endpoint for
 * fetching it. The structured-variables flow needs to be able to
 * decrypt values it just wrote, so this module persists the wrapped
 * DEK locally keyed by the layer_id.
 *
 * The wrapped DEK is still encrypted to the user's X25519 public key,
 * so it's safe to keep on disk — only a holder of the matching private
 * key (derived from the master password) can unwrap it.
 *
 * Cross-machine note: if a user sets a variable on machine A, the
 * wrapped layer DEK only exists in machine A's cache. On machine B,
 * the CLI will need to fetch it from the server, so a GET endpoint is
 * required (see README_DEFERRED.md for the proposed endpoint).
 */

import fs from 'node:fs';
import path from 'node:path';

export interface WrappedDekRecord {
  layer_id: string;
  wrapped_dek_b64: string;
  stored_at: string;
}

interface DekCacheFile {
  version: 1;
  entries: Record<string, WrappedDekRecord>;
}

export class DekCache {
  readonly file: string;

  constructor(configDir: string) {
    this.file = path.join(configDir, 'env-layer-keys.json');
  }

  private load(): DekCacheFile {
    if (!fs.existsSync(this.file)) {
      return { version: 1, entries: {} };
    }
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      const data = JSON.parse(raw) as DekCacheFile;
      if (data.version !== 1) return { version: 1, entries: {} };
      return data;
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private save(data: DekCacheFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  get(layerId: string): string | undefined {
    return this.load().entries[layerId]?.wrapped_dek_b64;
  }

  put(layerId: string, wrappedDekB64: string): void {
    const data = this.load();
    data.entries[layerId] = {
      layer_id: layerId,
      wrapped_dek_b64: wrappedDekB64,
      stored_at: new Date().toISOString(),
    };
    this.save(data);
  }

  delete(layerId: string): void {
    const data = this.load();
    delete data.entries[layerId];
    this.save(data);
  }
}

/** Build the canonical layer_id for a variable layer. */
export function layerIdForShared(projectId: number, envTier: string): string {
  return `shared:${projectId}:${envTier}`;
}
export function layerIdForPersonal(projectId: number, envTier: string, userId: number): string {
  return `personal:${projectId}:${envTier}:${userId}`;
}
