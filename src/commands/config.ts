/**
 * v2 `config` command group.
 *
 *   configsync config add <path> [--name <slug>] [--source-hint <text>]
 *   configsync config list
 *   configsync config show <slug>
 *   configsync config rename <old> <new>
 *   configsync config delete <slug> [--force]
 *
 * A "config" entity is a single file (or small file set) whose metadata
 * and encrypted content live in the cloud. The file at <path> is read,
 * wrapped into an EntityBlob, encrypted with a freshly-generated DEK,
 * and pushed as version 1.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
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
import { slugify } from '../lib/git-info.js';

export function registerConfigCommand(program: Command): void {
  const cmd = program
    .command('config')
    .description('Manage config entities (v2)');

  cmd
    .command('add <filePath>')
    .description('Register a config file as a new entity and push v1')
    .option('--name <slug>', 'entity slug (defaults to filename)')
    .option('--source-hint <text>', 'where the config originated (e.g. `~/.zshrc`)')
    .action(async (filePath: string, opts: { name?: string; sourceHint?: string }) => {
      await addConfig(path.resolve(filePath.replace(/^~/, process.env.HOME ?? '~')), opts);
    });

  cmd
    .command('list')
    .description('List config entities')
    .action(async () => {
      const ctx = await loadCtx(false);
      const rows = await ctx.cloud.listConfigs();
      if (rows.length === 0) {
        console.log(chalk.dim('No configs yet.'));
        return;
      }
      for (const c of rows) {
        console.log(`${chalk.cyan(c.slug.padEnd(30))} v${c.current_version}  ${c.name}`);
      }
    });

  cmd
    .command('show <slug>')
    .description('Show a config entity')
    .action(async (slug: string) => {
      const ctx = await loadCtx(false);
      const c = await findConfig(ctx.cloud, slug);
      console.log(JSON.stringify(c, null, 2));
    });

  cmd
    .command('rename <oldSlug> <newName>')
    .description('Rename a config entity')
    .action(async (oldSlug: string, newName: string) => {
      const ctx = await loadCtx(false);
      const c = await findConfig(ctx.cloud, oldSlug);
      await ctx.cloud.patchEntity('config', c.id, { name: newName, slug: slugify(newName) });
      console.log(chalk.green(`Config renamed: ${oldSlug} -> ${newName}`));
    });

  cmd
    .command('delete <slug>')
    .description('Soft-delete a config entity')
    .option('--force', 'skip confirmation')
    .action(async (slug: string, opts: { force?: boolean }) => {
      const ctx = await loadCtx(false);
      if (!opts.force) {
        console.error(chalk.yellow(`Re-run with --force to delete config '${slug}'.`));
        process.exit(2);
      }
      const c = await findConfig(ctx.cloud, slug);
      await ctx.cloud.deleteEntity('config', c.id);
      console.log(chalk.green(`Config '${slug}' deleted.`));
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

async function findConfig(cloud: CloudV2, slug: string): Promise<EntityRow> {
  const rows = await cloud.listConfigs();
  const c = rows.find((x) => x.slug === slug);
  if (!c) {
    console.error(chalk.red(`Config '${slug}' not found.`));
    process.exit(1);
  }
  return c;
}

async function addConfig(
  filePath: string,
  opts: { name?: string; sourceHint?: string },
): Promise<void> {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    console.error(chalk.red(`File not found: ${filePath}`));
    process.exit(1);
  }

  const ctx = await loadCtx(true);
  const base = path.basename(filePath);
  const slug = opts.name ?? slugify(base);
  const sourceHint = opts.sourceHint ?? filePath;

  // Create the config entity.
  const entity = await ctx.cloud.createConfig({
    slug,
    name: base,
    source_hint: sourceHint,
  });
  console.log(chalk.green(`Created config '${entity.slug}' (id=${entity.id})`));

  // Generate a DEK and upload it wrapped to the user's public key.
  const dek = generateDEK();
  const wrapped = wrapDEK(dek, ctx.keypair.publicKey);
  await ctx.cloud.upsertEntityKey('config', entity.id, wrapped.toString('base64'), ctx.userId);
  console.log(chalk.dim('  Wrapped DEK uploaded'));

  // Build a single-file blob and push v1.
  const content = fs.readFileSync(filePath);
  const file: BlobFileEntry = {
    rel_path: base,
    mode: fs.statSync(filePath).mode & 0o777,
    content_b64: content.toString('base64'),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
  const blob: EntityBlob = {
    schema_version: 1,
    entity_type: 'config',
    slug: entity.slug,
    captured_at: new Date().toISOString(),
    files: [file],
    extras: { source_hint: sourceHint },
  };
  const bytes = blobToBytes(blob);
  const ct = encryptEntityBlob(bytes, dek, 'config', entity.id, 1);
  const pushed = await ctx.cloud.pushEntityVersion(
    'config',
    entity.id,
    ct.toString('base64'),
    hashBlob(bytes),
  );
  console.log(chalk.green(`  Pushed v${pushed.version} (${content.length} bytes)`));
}
