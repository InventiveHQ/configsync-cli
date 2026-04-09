/**
 * v2 `module` command group.
 *
 *   configsync module add <moduleType>
 *   configsync module list
 *   configsync module show <slug>
 *   configsync module delete <slug> [--force]
 *
 * `<moduleType>` must match a key from the canonical module catalog in
 * `src/lib/modules.ts` (e.g. `ssh`, `vscode`, `claude-code`). The command
 * captures the module's default file set on the current machine, packs
 * it into an encrypted EntityBlob, and pushes it as version 1 of a new
 * module entity.
 *
 * NOTE: there is a legacy `commands/profile.ts` for the directory-
 * overlay profile concept; this file is unrelated.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ConfigManager } from '../lib/config.js';
import { promptPassword } from '../lib/prompt.js';
import { CloudV2, EntityRow } from '../lib/cloud-v2.js';
import { SessionManager } from '../lib/session.js';
import {
  generateDEK,
  wrapDEK,
  UserKeypair,
} from '../lib/envelope-crypto.js';
import {
  blobToBytes,
  hashBlob,
  encryptEntityBlob,
  EntityBlob,
  BlobFileEntry,
} from '../lib/entity-blob.js';
import { getModule, getAvailableModuleNames } from '../lib/modules.js';

export function registerModuleCommand(program: Command): void {
  const cmd = program
    .command('module')
    .description('Manage module entities (v2)');

  cmd
    .command('add <moduleType>')
    .description('Register a module entity and capture its default files')
    .action(async (moduleType: string) => {
      await addModule(moduleType);
    });

  cmd
    .command('list')
    .description('List module entities')
    .action(async () => {
      const ctx = await loadCtx(false);
      const rows = await ctx.cloud.listModules();
      if (rows.length === 0) {
        console.log(chalk.dim('No modules yet.'));
        return;
      }
      for (const m of rows) {
        console.log(`${chalk.cyan(m.slug.padEnd(30))} v${m.current_version}  ${m.name}`);
      }
    });

  cmd
    .command('show <slug>')
    .description('Show a module entity')
    .action(async (slug: string) => {
      const ctx = await loadCtx(false);
      const m = await findModule(ctx.cloud, slug);
      console.log(JSON.stringify(m, null, 2));
    });

  cmd
    .command('delete <slug>')
    .description('Soft-delete a module entity')
    .option('--force', 'skip confirmation')
    .action(async (slug: string, opts: { force?: boolean }) => {
      const ctx = await loadCtx(false);
      if (!opts.force) {
        console.error(chalk.yellow(`Re-run with --force to delete module '${slug}'.`));
        process.exit(2);
      }
      const m = await findModule(ctx.cloud, slug);
      await ctx.cloud.deleteEntity('module', m.id);
      console.log(chalk.green(`Module '${slug}' deleted.`));
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Ctx {
  cloud: CloudV2;
  keypair: UserKeypair;
  userId: number;
}

async function loadCtx(unlock: boolean): Promise<Ctx> {
  const configManager = new ConfigManager();
  if (!configManager.exists()) {
    console.error(chalk.red("Run 'configsync login' first."));
    process.exit(1);
  }
  const config = configManager.load();
  const apiUrl = (config.sync?.config?.api_url as string) ?? 'https://configsync.dev';
  const apiKey = (config.sync?.config?.api_key as string) ?? '';
  if (!apiKey) {
    console.error(chalk.red('No API key configured. Run `configsync login`.'));
    process.exit(3);
  }
  const sessionMgr = new SessionManager(configManager.configDir);
  if (!sessionMgr.exists()) {
    console.error(chalk.red("No v2 session. Run 'configsync login' first."));
    process.exit(1);
  }
  const session = sessionMgr.load();
  const cloud = new CloudV2(apiUrl, apiKey, session.machine_id);

  let keypair: UserKeypair = { publicKey: Buffer.alloc(0), privateKey: Buffer.alloc(0) };
  if (unlock) {
    const password = await promptPassword('Enter master password: ');
    try {
      keypair = sessionMgr.unlockKeypair(password);
    } catch {
      console.error(chalk.red('Incorrect master password.'));
      process.exit(3);
    }
  }

  return { cloud, keypair, userId: session.user_id };
}

async function findModule(cloud: CloudV2, slug: string): Promise<EntityRow> {
  const rows = await cloud.listModules();
  const m = rows.find((x) => x.slug === slug);
  if (!m) {
    console.error(chalk.red(`Module '${slug}' not found.`));
    process.exit(1);
  }
  return m;
}

async function addModule(moduleType: string): Promise<void> {
  const def = getModule(moduleType);
  if (!def) {
    console.error(
      chalk.red(`Unknown module type: ${moduleType}`) +
        chalk.dim(`\nAvailable: ${getAvailableModuleNames().join(', ')}`),
    );
    process.exit(1);
  }

  const ctx = await loadCtx(true);
  const entity = await ctx.cloud.createModule({
    slug: def.name,
    name: def.displayName,
    module_type: def.name,
  });
  console.log(chalk.green(`Created module '${entity.slug}' (id=${entity.id})`));

  const dek = generateDEK();
  const wrapped = wrapDEK(dek, ctx.keypair.publicKey);
  await ctx.cloud.upsertEntityKey('module', entity.id, wrapped.toString('base64'), ctx.userId);
  console.log(chalk.dim('  Wrapped DEK uploaded'));

  // Capture all existing module files into blob entries.
  const files: BlobFileEntry[] = [];
  for (const f of def.files) {
    if (!f.exists) continue;
    try {
      const stat = fs.statSync(f.path);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(f.path);
      files.push({
        rel_path: f.relative,
        mode: stat.mode & 0o777,
        content_b64: content.toString('base64'),
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      });
    } catch {
      // skip unreadable files
    }
  }

  const blob: EntityBlob = {
    schema_version: 1,
    entity_type: 'module',
    slug: entity.slug,
    captured_at: new Date().toISOString(),
    files,
    extras: def.extras,
  };
  const bytes = blobToBytes(blob);
  const ct = encryptEntityBlob(bytes, dek, 'module', entity.id, 1);
  const pushed = await ctx.cloud.pushEntityVersion(
    'module',
    entity.id,
    ct.toString('base64'),
    hashBlob(bytes),
  );
  console.log(
    chalk.green(`  Pushed v${pushed.version} (${files.length} file(s), ${bytes.length} bytes)`),
  );
}
