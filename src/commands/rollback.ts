/**
 * v2 `rollback` command.
 *
 *   configsync rollback --project <slug>   --version <n>
 *   configsync rollback --workspace <slug> --version <n>
 *   configsync rollback --config <slug>    --version <n>
 *   configsync rollback --module <slug>    --version <n>
 *   configsync rollback --profile <slug>   --version <n>
 *   configsync rollback --snapshot <n>                   (legacy snapshot restore)
 *
 * Rolling back to version n fetches that historical blob, re-encrypts
 * it as a NEW version (current_version + 1), and pushes it. The
 * original history is preserved. The CLI does NOT mutate the local
 * working copy; run `configsync pull` afterwards to apply.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigManager } from '../lib/config.js';
import { promptPassword } from '../lib/prompt.js';
import { CloudV2, EntityRow } from '../lib/cloud-v2.js';
import { SessionManager } from '../lib/session.js';
import CloudBackend from '../lib/cloud.js';
import CryptoManager from '../lib/crypto.js';
import {
  unwrapDEK,
  UserKeypair,
} from '../lib/envelope-crypto.js';
import {
  hashBlob,
  encryptEntityBlob,
  decryptEntityBlob,
} from '../lib/entity-blob.js';

type EntityKind = 'project' | 'workspace' | 'config' | 'module' | 'profile';

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback')
    .description('Roll an entity (or snapshot) back to a previous version')
    .option('--project <slug>', 'roll back a project')
    .option('--workspace <slug>', 'roll back a workspace')
    .option('--config <slug>', 'roll back a config')
    .option('--module <slug>', 'roll back a module')
    .option('--profile <slug>', 'roll back a profile')
    .option('--version <n>', 'target version number')
    .option('--snapshot <n>', 'legacy whole-state snapshot ID')
    .action(async (opts: {
      project?: string;
      workspace?: string;
      config?: string;
      module?: string;
      profile?: string;
      version?: string;
      snapshot?: string;
    }) => {
      if (opts.snapshot) {
        await restoreSnapshot(opts.snapshot);
        return;
      }

      const kinds: [EntityKind, string | undefined][] = [
        ['project', opts.project],
        ['workspace', opts.workspace],
        ['config', opts.config],
        ['module', opts.module],
        ['profile', opts.profile],
      ];
      const selected = kinds.filter(([, slug]) => !!slug);
      if (selected.length !== 1) {
        console.error(
          chalk.red('Specify exactly one of --project / --workspace / --config / --module / --profile / --snapshot'),
        );
        process.exit(1);
      }
      if (!opts.version) {
        console.error(chalk.red('Missing --version <n>'));
        process.exit(1);
      }
      const [kind, slug] = selected[0] as [EntityKind, string];
      const version = parseInt(opts.version, 10);
      if (!Number.isFinite(version) || version < 1) {
        console.error(chalk.red(`Invalid version: ${opts.version}`));
        process.exit(1);
      }
      await rollbackEntity(kind, slug, version);
    });
}

// ---------------------------------------------------------------------------
// Entity rollback
// ---------------------------------------------------------------------------

async function rollbackEntity(
  kind: EntityKind,
  slug: string,
  version: number,
): Promise<void> {
  const { cloud, keypair, sessionMgr } = await loadV2Ctx();
  const row = await findEntityBySlug(cloud, kind, slug);
  if (version > (row.current_version ?? 0)) {
    console.error(
      chalk.red(`Version ${version} is newer than current v${row.current_version}`),
    );
    process.exit(1);
  }

  const spinner = ora(`Fetching ${kind} '${slug}' v${version}...`).start();

  // Fetch the wrapped DEK and the historical blob.
  const info = await cloud.getEntity(kind, row.id);
  if (!info.wrapped_dek) {
    spinner.fail(`No wrapped DEK for ${kind} '${slug}'`);
    process.exit(1);
  }
  const dek = unwrapDEK(Buffer.from(info.wrapped_dek, 'base64'), keypair);

  const historicalCt = await cloud.getEntityVersionBlob(kind, row.id, version);
  const plainBytes = decryptEntityBlob(historicalCt, dek, kind, row.id, version);

  // Re-encrypt at the next version number and push.
  const nextVersion = (row.current_version ?? 0) + 1;
  const reEncrypted = encryptEntityBlob(plainBytes, dek, kind, row.id, nextVersion);
  spinner.text = `Pushing new version v${nextVersion}...`;
  const pushed = await cloud.pushEntityVersion(
    kind,
    row.id,
    reEncrypted.toString('base64'),
    hashBlob(plainBytes),
  );
  spinner.succeed(
    `Rolled back ${kind} '${slug}' to contents of v${version}; pushed as v${pushed.version}`,
  );
  console.log(chalk.dim('  Run `configsync pull` to apply on this machine.'));
  // Touch sessionMgr so unused-import TS doesn't bite.
  void sessionMgr;
}

// ---------------------------------------------------------------------------
// Legacy snapshot restore
// ---------------------------------------------------------------------------

async function restoreSnapshot(snapshotId: string): Promise<void> {
  const n = parseInt(snapshotId, 10);
  if (!Number.isFinite(n)) {
    console.error(chalk.red(`Invalid snapshot id: ${snapshotId}`));
    process.exit(1);
  }
  const configManager = new ConfigManager();
  if (!configManager.exists()) {
    console.error(chalk.red("Run 'configsync init' first."));
    process.exit(1);
  }
  const config = configManager.load();
  if (config.sync.backend !== 'cloud') {
    console.error(chalk.red('Snapshot rollback is only available with cloud backend.'));
    process.exit(1);
  }
  const apiUrl = config.sync.config.api_url;
  const apiKey = config.sync.config.api_key;
  if (!apiUrl || !apiKey) {
    console.error(chalk.red('Cloud backend not configured.'));
    process.exit(1);
  }
  const password = await promptPassword('Enter master password: ');
  const cryptoManager = new CryptoManager(configManager.configDir);
  cryptoManager.unlock(password);

  const spinner = ora(`Restoring snapshot ${n}...`).start();
  try {
    const backend = new CloudBackend(apiUrl, apiKey);
    const state = await backend.pullSnapshot(n, cryptoManager);
    if (!state) {
      spinner.fail(`Snapshot ${n} not found.`);
      process.exit(1);
    }
    // Push the restored state back as a new snapshot so it becomes "current".
    await backend.push(state, cryptoManager);
    spinner.succeed(`Restored snapshot ${n} and pushed as new current state.`);
    console.log(chalk.dim('  Run `configsync pull` to apply on this machine.'));
  } catch (err: any) {
    spinner.fail(`Rollback failed: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadV2Ctx(): Promise<{
  cloud: CloudV2;
  keypair: UserKeypair;
  userId: number;
  sessionMgr: SessionManager;
}> {
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

  const password = await promptPassword('Enter master password: ');
  let keypair: UserKeypair;
  try {
    keypair = sessionMgr.unlockKeypair(password);
  } catch {
    console.error(chalk.red('Incorrect master password.'));
    process.exit(3);
  }

  return { cloud, keypair, userId: session.user_id, sessionMgr };
}

async function findEntityBySlug(
  cloud: CloudV2,
  kind: EntityKind,
  slug: string,
): Promise<EntityRow> {
  const rows =
    kind === 'project'
      ? await cloud.listProjects()
      : kind === 'workspace'
      ? await cloud.listWorkspaces()
      : kind === 'config'
      ? await cloud.listConfigs()
      : kind === 'module'
      ? await cloud.listModules()
      : ((await cloud.listProfiles()) as EntityRow[]);
  const row = rows.find((r: any) => r.slug === slug);
  if (!row) {
    console.error(chalk.red(`${kind} '${slug}' not found.`));
    process.exit(1);
  }
  return row as EntityRow;
}
