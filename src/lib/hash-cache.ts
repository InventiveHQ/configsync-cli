/**
 * Content-hash caching for push operations.
 * Tracks SHA-256 hashes of tracked files to skip re-encrypting unchanged content.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface HashEntry {
  sha256: string;
  size: number;
  mtime: number;
  encryptedBase64: string;
}

export interface HashCache {
  version: 1;
  lastPush: string;
  entries: Record<string, HashEntry>;
}

export class HashCacheManager {
  private cacheFile: string;

  constructor(stateDir: string) {
    this.cacheFile = path.join(stateDir, 'hashes.json');
  }

  load(): HashCache {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
        if (data.version === 1) return data;
      }
    } catch {
      // Corrupted cache, start fresh
    }
    return { version: 1, lastPush: '', entries: {} };
  }

  save(cache: HashCache): void {
    cache.lastPush = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify(cache));
  }

  /**
   * Check if a file has changed since last push.
   * Fast path: if mtime matches, skip hashing.
   * Slow path: compute SHA-256 and compare.
   */
  check(filePath: string, sourceKey: string, cache: HashCache): { changed: boolean; cachedContent?: string; sha256: string; size: number; mtime: number } {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;
    const size = stat.size;
    const entry = cache.entries[sourceKey];

    // Fast path: mtime and size unchanged
    if (entry && entry.mtime === mtime && entry.size === size) {
      return { changed: false, cachedContent: entry.encryptedBase64, sha256: entry.sha256, size, mtime };
    }

    // Slow path: compute hash
    const content = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

    if (entry && entry.sha256 === sha256) {
      // Content unchanged despite mtime change — update mtime in cache
      entry.mtime = mtime;
      entry.size = size;
      return { changed: false, cachedContent: entry.encryptedBase64, sha256, size, mtime };
    }

    return { changed: true, sha256, size, mtime };
  }

  update(cache: HashCache, sourceKey: string, sha256: string, size: number, mtime: number, encryptedBase64: string): void {
    cache.entries[sourceKey] = { sha256, size, mtime, encryptedBase64 };
  }

  /**
   * Remove entries from cache that are no longer tracked.
   */
  prune(cache: HashCache, activeKeys: Set<string>): void {
    for (const key of Object.keys(cache.entries)) {
      if (!activeKeys.has(key)) {
        delete cache.entries[key];
      }
    }
  }
}

/**
 * Merge current (changed) items with previous (unchanged) items from last push.
 * Used by --changed flag to build a complete state from partial capture.
 */
export function mergeWithPrevious<T extends Record<string, any>>(
  current: T[],
  previous: T[],
  keyField: string,
): T[] {
  const currentKeys = new Set(current.map(item => item[keyField]));
  const fromPrevious = (previous || []).filter(item => !currentKeys.has(item[keyField]));
  return [...current, ...fromPrevious];
}
