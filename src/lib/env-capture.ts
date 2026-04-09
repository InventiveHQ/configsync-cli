/**
 * Shared env-variable capture helpers used by both `commands/vars.ts`
 * (the interactive `vars set` / `vars push` flow) and `commands/project.ts`
 * (automatic .env capture when a project is added).
 *
 * These used to live as private helpers inside `commands/vars.ts`; they
 * were extracted when `addProject` gained auto-capture so that
 * `commands/project.ts` would not have to import from another command
 * file (commands importing commands is explicitly discouraged — see
 * configsync-cli/CLAUDE.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { CloudV2 } from './cloud-v2.js';
import { DekCache, layerIdForPersonal, layerIdForShared } from './dek-cache.js';
import {
  encryptWithKey,
  generateDEK,
  unwrapDEK,
  wrapDEK,
  UserKeypair,
} from './envelope-crypto.js';

// ---------------------------------------------------------------------------
// .env file parsing
// ---------------------------------------------------------------------------

export interface DotenvEntry {
  key: string;
  value: string;
}

/**
 * Minimal .env parser: KEY=VALUE, #-comments, optional surrounding
 * single or double quotes. No variable interpolation, no multiline.
 * Good enough for the 95% case; projects that need more should use a
 * real loader at runtime.
 */
export function parseDotenv(content: string): DotenvEntry[] {
  const out: DotenvEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.push({ key: m[1], value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layer DEK management
// ---------------------------------------------------------------------------

export type Visibility = 'shared' | 'personal';

function layerIdFor(
  projectId: number,
  envTier: string,
  visibility: Visibility,
  userId: number,
): string {
  return visibility === 'personal'
    ? layerIdForPersonal(projectId, envTier, userId)
    : layerIdForShared(projectId, envTier);
}

export interface LayerDekContext {
  cloud: CloudV2;
  keypair: UserKeypair;
  dekCache: DekCache;
  userId: number;
}

/**
 * Return the layer DEK for a (project, env, visibility), creating a
 * new one if the local cache is empty. Whether cached or freshly
 * generated, the wrapped DEK is always (re-)uploaded to the server —
 * POST /env/keys is upsert-semantics, so repeated uploads of the same
 * key are a no-op. This guards against the case where the local cache
 * has a DEK from an earlier session but the corresponding
 * `env_layer_keys` row never made it to the server (or was wiped) —
 * without this, the dashboard Reveal flow would 404 forever.
 */
export async function getOrCreateLayerDek(
  ctx: LayerDekContext,
  projectId: number,
  envTier: string,
  visibility: Visibility,
): Promise<Buffer> {
  const layerId = layerIdFor(projectId, envTier, visibility, ctx.userId);
  const cached = ctx.dekCache.get(layerId);
  let wrappedB64: string;
  let dek: Buffer;
  if (cached) {
    wrappedB64 = cached;
    dek = unwrapDEK(Buffer.from(cached, 'base64'), ctx.keypair);
  } else {
    dek = generateDEK();
    wrappedB64 = wrapDEK(dek, ctx.keypair.publicKey).toString('base64');
    ctx.dekCache.put(layerId, wrappedB64);
  }
  // Unconditional upsert — cheap, idempotent server-side.
  await ctx.cloud.uploadEnvLayerKey(projectId, layerId, wrappedB64);
  return dek;
}

// ---------------------------------------------------------------------------
// Auto-capture of .env files from a project directory
// ---------------------------------------------------------------------------

interface EnvFileMapping {
  tier: string;
  visibility: Visibility;
}

/**
 * Map of recognized env filenames to the (tier, visibility) layer they
 * should be captured into. Convention:
 *   - `.env.local` is per-developer (personal visibility).
 *   - Everything else is shared within the project.
 *   - `.dev.vars` is Cloudflare Workers' dev-secrets file; treat as dev/shared.
 */
export const ENV_FILE_LAYERS: Record<string, EnvFileMapping> = {
  '.env': { tier: 'dev', visibility: 'shared' },
  '.env.local': { tier: 'dev', visibility: 'personal' },
  '.env.development': { tier: 'dev', visibility: 'shared' },
  '.env.development.local': { tier: 'dev', visibility: 'personal' },
  '.env.staging': { tier: 'staging', visibility: 'shared' },
  '.env.staging.local': { tier: 'staging', visibility: 'personal' },
  '.env.production': { tier: 'prod', visibility: 'shared' },
  '.env.production.local': { tier: 'prod', visibility: 'personal' },
  '.env.test': { tier: 'test', visibility: 'shared' },
  '.env.test.local': { tier: 'test', visibility: 'personal' },
  '.dev.vars': { tier: 'dev', visibility: 'shared' },
};

export interface CaptureResult {
  files: { file: string; tier: string; visibility: Visibility; count: number }[];
  totalVars: number;
}

/**
 * Scan a project root for known .env* files and upsert every KEY=VALUE
 * into structured env variables under the appropriate (tier, visibility)
 * layer. Idempotent: re-running updates values to the current file
 * contents. Variables already present but absent from the file are
 * left alone (conservative — we don't want `add workspace` to silently
 * delete vars a user set via `vars set`).
 */
export async function captureEnvFilesFromDir(
  ctx: LayerDekContext,
  projectId: number,
  rootDir: string,
): Promise<CaptureResult> {
  const result: CaptureResult = { files: [], totalVars: 0 };
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return result;
  }

  for (const [filename, mapping] of Object.entries(ENV_FILE_LAYERS)) {
    const filePath = path.join(rootDir, filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const entries = parseDotenv(content);
    if (entries.length === 0) continue;

    const dek = await getOrCreateLayerDek(ctx, projectId, mapping.tier, mapping.visibility);
    // For personal variables, owner_user_id MUST match the user whose
    // pubkey wrapped the layer DEK — the dashboard (and `vars list --show`)
    // rebuild the layer_id from the stored row as
    //   `personal:${projectId}:${tier}:${owner_user_id ?? 0}`
    // so a NULL here silently produces the wrong layer_id and Reveal
    // cannot find the wrapped DEK.
    const ownerUserId = mapping.visibility === 'personal' ? ctx.userId : undefined;
    for (const { key, value } of entries) {
      const ciphertext = encryptWithKey(Buffer.from(value, 'utf-8'), dek);
      await ctx.cloud.upsertEnvVariable(projectId, key, {
        environment_tier: mapping.tier,
        visibility: mapping.visibility,
        owner_user_id: ownerUserId,
        value_source: 'inline',
        encrypted_value: ciphertext.toString('base64'),
      });
    }
    result.files.push({
      file: filename,
      tier: mapping.tier,
      visibility: mapping.visibility,
      count: entries.length,
    });
    result.totalVars += entries.length;
  }

  return result;
}
