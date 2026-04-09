/**
 * v2 `vars` command group — structured per-project env variables.
 *
 *   configsync vars set KEY=VALUE --project <slug> --env <tier> [--visibility shared|personal]
 *   configsync vars unset KEY --project <slug> --env <tier>
 *   configsync vars list --project <slug> --env <tier> [--show]
 *   configsync vars render --project <slug> --env <tier>
 *   configsync vars push --from-file .env --project <slug> --env <tier>
 *
 * Cryptography (plan §5.4, §4.3):
 *   - Each (project, env_tier, visibility) layer has its own DEK.
 *   - The DEK is wrapped with the user's X25519 public key and uploaded
 *     to POST /api/projects/:id/env/keys. The wrapped DEK is also
 *     cached locally under ~/.configsync/env-layer-keys.json so the
 *     CLI can decrypt values on read (no server GET endpoint exists
 *     yet for layer DEKs).
 *   - Each variable's value is encrypted with that layer DEK using
 *     AES-256-GCM (no AAD — the variable row itself carries the
 *     project/env/visibility binding).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import { ConfigManager } from '../lib/config.js';
import { promptPassword } from '../lib/prompt.js';
import { CloudV2, ProjectRow } from '../lib/cloud-v2.js';
import { SessionManager } from '../lib/session.js';
import {
  DekCache,
  layerIdForPersonal,
  layerIdForShared,
} from '../lib/dek-cache.js';
import {
  generateDEK,
  unwrapDEK,
  wrapDEK,
  encryptWithKey,
  decryptWithKey,
  UserKeypair,
} from '../lib/envelope-crypto.js';

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface Context {
  configManager: ConfigManager;
  sessionMgr: SessionManager;
  cloud: CloudV2;
  keypair: UserKeypair;
  userId: number;
  dekCache: DekCache;
}

async function loadContext(options: { prompt?: boolean } = {}): Promise<Context> {
  const configManager = new ConfigManager();
  if (!configManager.exists()) {
    console.error(chalk.red("Run 'configsync login' first."));
    process.exit(1);
  }
  const sessionMgr = new SessionManager(configManager.configDir);
  if (!sessionMgr.exists()) {
    console.error(chalk.red("No v2 session. Run 'configsync login' first."));
    process.exit(1);
  }
  const session = sessionMgr.load();
  const config = configManager.load();
  const apiUrl = (config.sync?.config?.api_url as string) ?? session.api_url;
  const apiKey = (config.sync?.config?.api_key as string) ?? '';
  if (!apiKey) {
    console.error(chalk.red('No API key configured. Run `configsync login`.'));
    process.exit(3);
  }

  const password = await promptPassword('Enter master password: ');
  let keypair: UserKeypair;
  try {
    keypair = sessionMgr.unlockKeypair(password);
  } catch {
    console.error(chalk.red('Incorrect master password.'));
    process.exit(3);
  }

  return {
    configManager,
    sessionMgr,
    cloud: new CloudV2(apiUrl, apiKey, session.machine_id),
    keypair,
    userId: session.user_id,
    dekCache: new DekCache(configManager.configDir),
  };
}

async function findProject(cloud: CloudV2, slug: string): Promise<ProjectRow> {
  const projects = await cloud.listProjects();
  const p = projects.find((x) => x.slug === slug);
  if (!p) {
    console.error(chalk.red(`Project '${slug}' not found.`));
    process.exit(1);
  }
  return p;
}

function layerIdFor(
  projectId: number,
  envTier: string,
  visibility: 'shared' | 'personal',
  userId: number,
): string {
  return visibility === 'personal'
    ? layerIdForPersonal(projectId, envTier, userId)
    : layerIdForShared(projectId, envTier);
}

/**
 * Return the layer DEK for a (project, env, visibility), creating and
 * uploading a new one if none exists.
 *
 * Because the server has no GET endpoint for env layer keys yet, we
 * rely on the local cache. If the cache is empty AND we haven't seen
 * this layer on this machine, a brand-new DEK is generated. The caller
 * should avoid creating a second DEK for an existing layer — the first
 * `set` creates the DEK, subsequent operations reuse the cached copy.
 */
async function getOrCreateLayerDek(
  ctx: Context,
  projectId: number,
  envTier: string,
  visibility: 'shared' | 'personal',
): Promise<Buffer> {
  const layerId = layerIdFor(projectId, envTier, visibility, ctx.userId);
  const cached = ctx.dekCache.get(layerId);
  if (cached) {
    return unwrapDEK(Buffer.from(cached, 'base64'), ctx.keypair);
  }
  const dek = generateDEK();
  const wrapped = wrapDEK(dek, ctx.keypair.publicKey);
  const wrappedB64 = wrapped.toString('base64');
  await ctx.cloud.uploadEnvLayerKey(projectId, layerId, wrappedB64);
  ctx.dekCache.put(layerId, wrappedB64);
  return dek;
}

/** Fetch an existing layer DEK (no creation). Throws if not cached. */
function readLayerDek(
  ctx: Context,
  projectId: number,
  envTier: string,
  visibility: 'shared' | 'personal',
): Buffer {
  const layerId = layerIdFor(projectId, envTier, visibility, ctx.userId);
  const cached = ctx.dekCache.get(layerId);
  if (!cached) {
    throw new Error(
      `No local DEK cached for layer '${layerId}'. ` +
        'This layer may have been created on another machine; ' +
        'the env layer keys GET endpoint is not yet implemented.',
    );
  }
  return unwrapDEK(Buffer.from(cached, 'base64'), ctx.keypair);
}

function parseKeyValue(input: string): { key: string; value: string } {
  const idx = input.indexOf('=');
  if (idx < 0) {
    console.error(chalk.red(`Error: expected KEY=VALUE, got '${input}'`));
    process.exit(1);
  }
  return { key: input.slice(0, idx), value: input.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerVarsCommand(program: Command): void {
  const cmd = program
    .command('vars')
    .description('Manage structured per-project env variables (v2)');

  cmd
    .command('set <keyValue>')
    .description('Set a variable (KEY=VALUE)')
    .requiredOption('--project <slug>', 'project slug')
    .requiredOption('--env <tier>', 'environment tier (dev, staging, prod, ...)')
    .option('--visibility <v>', 'shared | personal', 'shared')
    .option('--description <text>', 'optional human description')
    .option('--required', 'mark the variable as required')
    .action(async (keyValue: string, opts: any) => {
      const { key, value } = parseKeyValue(keyValue);
      const ctx = await loadContext();
      const project = await findProject(ctx.cloud, opts.project);
      const visibility = opts.visibility as 'shared' | 'personal';

      const dek = await getOrCreateLayerDek(ctx, project.id, opts.env, visibility);
      const ciphertext = encryptWithKey(Buffer.from(value, 'utf-8'), dek);

      await ctx.cloud.upsertEnvVariable(project.id, key, {
        environment_tier: opts.env,
        visibility,
        description: opts.description,
        required: !!opts.required,
        value_source: 'inline',
        encrypted_value: ciphertext.toString('base64'),
      });

      console.log(chalk.green(`Set ${key} on ${project.slug}/${opts.env}/${visibility}`));
    });

  cmd
    .command('unset <key>')
    .description('Delete a variable')
    .requiredOption('--project <slug>', 'project slug')
    .requiredOption('--env <tier>', 'environment tier')
    .option('--visibility <v>', 'shared | personal', 'shared')
    .action(async (key: string, opts: any) => {
      const ctx = await loadContext();
      const project = await findProject(ctx.cloud, opts.project);
      await ctx.cloud.deleteEnvVariable(project.id, key, opts.env, opts.visibility);
      console.log(chalk.green(`Unset ${key}`));
    });

  cmd
    .command('list')
    .description('List variables in a project/env')
    .requiredOption('--project <slug>', 'project slug')
    .requiredOption('--env <tier>', 'environment tier')
    .option('--visibility <v>', 'filter by visibility')
    .option('--show', 'decrypt and print values instead of masking')
    .action(async (opts: any) => {
      const ctx = await loadContext();
      const project = await findProject(ctx.cloud, opts.project);
      const variables = await ctx.cloud.listEnvVariables(project.id, {
        env: opts.env,
        visibility: opts.visibility,
      });
      if (variables.length === 0) {
        console.log(chalk.dim('No variables.'));
        return;
      }
      for (const v of variables) {
        let display = chalk.dim('•••••');
        if (opts.show) {
          try {
            const dek = readLayerDek(ctx, project.id, opts.env, v.visibility as any);
            const ct = Buffer.from(v.encrypted_value ?? '', 'base64');
            const plain = decryptWithKey(ct, dek).toString('utf-8');
            display = plain;
          } catch (err: any) {
            display = chalk.red(`<decrypt failed: ${err.message ?? err}>`);
          }
        }
        console.log(
          `${chalk.cyan(v.name.padEnd(30))} ${chalk.dim(v.visibility.padEnd(9))} ${display}`,
        );
      }
    });

  cmd
    .command('render')
    .description('Output a composed .env file (stdout)')
    .requiredOption('--project <slug>', 'project slug')
    .requiredOption('--env <tier>', 'environment tier')
    .action(async (opts: any) => {
      const ctx = await loadContext();
      const project = await findProject(ctx.cloud, opts.project);
      const variables = await ctx.cloud.listEnvVariables(project.id, { env: opts.env });
      // Layered composition: shared first, then personal (personal overrides shared).
      const ordered = [
        ...variables.filter((v) => v.visibility === 'shared'),
        ...variables.filter((v) => v.visibility === 'personal'),
      ];
      const seen = new Set<string>();
      for (let i = ordered.length - 1; i >= 0; i--) {
        if (seen.has(ordered[i].name)) ordered.splice(i, 1);
        else seen.add(ordered[i].name);
      }
      ordered.sort((a, b) => a.name.localeCompare(b.name));
      for (const v of ordered) {
        try {
          const dek = readLayerDek(ctx, project.id, opts.env, v.visibility as any);
          const ct = Buffer.from(v.encrypted_value ?? '', 'base64');
          const plain = decryptWithKey(ct, dek).toString('utf-8');
          process.stdout.write(`${v.name}=${formatEnvValue(plain)}\n`);
        } catch (err: any) {
          process.stderr.write(
            chalk.red(`# ${v.name}: decrypt failed (${err.message ?? err})\n`),
          );
        }
      }
    });

  cmd
    .command('push')
    .description('Bulk-import a .env file')
    .requiredOption('--from-file <file>', '.env file to import')
    .requiredOption('--project <slug>', 'project slug')
    .requiredOption('--env <tier>', 'environment tier')
    .option('--visibility <v>', 'shared | personal', 'shared')
    .action(async (opts: any) => {
      if (!fs.existsSync(opts.fromFile)) {
        console.error(chalk.red(`File not found: ${opts.fromFile}`));
        process.exit(1);
      }
      const content = fs.readFileSync(opts.fromFile, 'utf-8');
      const entries = parseDotenv(content);
      if (entries.length === 0) {
        console.log(chalk.yellow('No KEY=VALUE entries found; nothing to push.'));
        return;
      }
      const ctx = await loadContext();
      const project = await findProject(ctx.cloud, opts.project);
      const visibility = opts.visibility as 'shared' | 'personal';
      const dek = await getOrCreateLayerDek(ctx, project.id, opts.env, visibility);

      for (const { key, value } of entries) {
        const ct = encryptWithKey(Buffer.from(value, 'utf-8'), dek);
        await ctx.cloud.upsertEnvVariable(project.id, key, {
          environment_tier: opts.env,
          visibility,
          value_source: 'inline',
          encrypted_value: ct.toString('base64'),
        });
        console.log(chalk.dim(`  ${key}`));
      }
      console.log(chalk.green(`Pushed ${entries.length} variable(s).`));
    });
}

// ---------------------------------------------------------------------------
// .env parsing
// ---------------------------------------------------------------------------

function parseDotenv(content: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
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

function formatEnvValue(v: string): string {
  if (/[\s#"'`$]/.test(v)) {
    return `"${v.replace(/"/g, '\\"')}"`;
  }
  return v;
}
