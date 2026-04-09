/**
 * Backend factory and re-exports.
 *
 * Callers should depend on `Backend` from `../backend.js` and pick an
 * implementation via `createBackend` rather than instantiating
 * concrete classes directly. That keeps command code symmetric across
 * cloud and filesystem storage and makes it trivial to swap in a new
 * backend (S3, GCS, ...) in the future.
 */

import type { Backend } from '../backend.js';
import type { CloudV2 } from '../cloud-v2.js';

import { CloudBackend } from './cloud.js';
import { FilesystemBackend } from './filesystem.js';

export { CloudBackend } from './cloud.js';
export { FilesystemBackend } from './filesystem.js';
export type { FilesystemBackendOptions } from './filesystem.js';

/**
 * Discriminated union of backend configurations accepted by
 * `createBackend`. New backend kinds add a new variant here and a
 * matching branch in `createBackend`.
 */
export type BackendConfig =
  | { kind: 'filesystem'; path: string }
  | { kind: 'cloud'; cloudClient: CloudV2 };

/**
 * Build a `Backend` from a config object. Throws on unknown kinds so
 * typos in environment-variable plumbing surface loudly instead of
 * silently falling back to a default.
 */
export function createBackend(config: BackendConfig): Backend {
  if (config.kind === 'filesystem') {
    return new FilesystemBackend({ rootPath: config.path });
  }
  if (config.kind === 'cloud') {
    return new CloudBackend(config.cloudClient);
  }
  throw new Error(`Unknown backend kind: ${(config as { kind: string }).kind}`);
}
