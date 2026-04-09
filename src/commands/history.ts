import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigManager } from '../lib/config.js';
import CloudBackend from '../lib/cloud.js';
import { CloudV2, VersionRow } from '../lib/cloud-v2.js';
import { SessionManager } from '../lib/session.js';

type EntityKind = 'project' | 'workspace' | 'config' | 'module' | 'profile';

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('List past sync snapshots or per-entity version history')
    .option('-n, --limit <n>', 'number of snapshots to show', '20')
    .option('--from <machine>', 'filter by machine name or ID')
    .option('--project <slug>', 'show version history for a project entity')
    .option('--workspace <slug>', 'show version history for a workspace entity')
    .option('--config <slug>', 'show version history for a config entity')
    .option('--module <slug>', 'show version history for a module entity')
    .option('--profile <slug>', 'show version history for a profile entity')
    .action(async (options: {
      limit: string;
      from?: string;
      project?: string;
      workspace?: string;
      config?: string;
      module?: string;
      profile?: string;
    }) => {
      // Per-entity branch: exactly one of the entity flags may be set.
      const entityFlags: [EntityKind, string | undefined][] = [
        ['project', options.project],
        ['workspace', options.workspace],
        ['config', options.config],
        ['module', options.module],
        ['profile', options.profile],
      ];
      const active = entityFlags.filter(([, v]) => !!v);
      if (active.length > 1) {
        console.error(chalk.red('Specify at most one entity flag.'));
        process.exit(1);
      }
      if (active.length === 1) {
        const [kind, slug] = active[0] as [EntityKind, string];
        await showEntityHistory(kind, slug, parseInt(options.limit, 10) || 20);
        return;
      }

      // Fall through to legacy snapshot history:
      await showSnapshotHistory(options);
    });
}

async function showSnapshotHistory(options: { limit: string; from?: string }): Promise<void> {
  const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      if (config.sync.backend !== 'cloud') {
        console.error(chalk.red('History is only available with cloud backend.'));
        process.exit(1);
      }

      const apiUrl = config.sync.config.api_url;
      const apiKey = config.sync.config.api_key;

      if (!apiUrl || !apiKey) {
        console.error(chalk.red('Cloud backend not configured. Run "configsync login" first.'));
        process.exit(1);
      }

      const spinner = ora('Fetching history...').start();

      try {
        const backend = new CloudBackend(apiUrl, apiKey);
        const limit = parseInt(options.limit, 10) || 20;

        let machineId: string | undefined;
        if (options.from) {
          const machines = await backend.listMachines();
          const match = machines.find((m: any) =>
            m.machine_id === options.from ||
            m.name.toLowerCase().includes(options.from!.toLowerCase())
          );
          if (match) machineId = match.machine_id;
        }

        const snapshots = await backend.getHistory(machineId, limit);
        spinner.stop();

        if (!snapshots || snapshots.length === 0) {
          console.log(chalk.dim('No snapshots found.'));
          return;
        }

        console.log(chalk.bold(`\nSnapshot history (${snapshots.length}):\n`));
        console.log(
          chalk.dim('  ID'.padEnd(8)) +
          chalk.dim('Timestamp'.padEnd(24)) +
          chalk.dim('Machine'.padEnd(20)) +
          chalk.dim('Size'),
        );
        console.log(chalk.dim('  ' + '─'.repeat(60)));

        for (const snap of snapshots) {
          const id = String(snap.id).padEnd(6);
          const time = (snap.created_at || '').slice(0, 19).padEnd(22);
          const machine = (snap.machine_name || snap.machine_id || '').slice(0, 18).padEnd(18);
          const size = snap.size_bytes ? formatBytes(snap.size_bytes) : '?';

          console.log(`  ${chalk.cyan(id)}${time}${machine}${chalk.dim(size)}`);
        }

        console.log(chalk.dim(`\n  Restore with: configsync pull --snapshot=<ID>`));
      } catch (err: any) {
        spinner.fail(`Failed to fetch history: ${err.message}`);
        process.exit(1);
      }
}

async function showEntityHistory(
  kind: EntityKind,
  slug: string,
  limit: number,
): Promise<void> {
  const configManager = new ConfigManager();
  if (!configManager.exists()) {
    console.error(chalk.red("Error: Run 'configsync init' first."));
    process.exit(1);
  }
  const config = configManager.load();
  const apiUrl = (config.sync?.config?.api_url as string) ?? 'https://configsync.dev';
  const apiKey = (config.sync?.config?.api_key as string) ?? '';
  if (!apiKey) {
    console.error(chalk.red('Cloud backend not configured. Run "configsync login" first.'));
    process.exit(1);
  }
  const sessionMgr = new SessionManager(configManager.configDir);
  const machineId = sessionMgr.exists() ? sessionMgr.load().machine_id : CloudV2.generateMachineId();
  const cloud = new CloudV2(apiUrl, apiKey, machineId);

  const spinner = ora(`Fetching ${kind} '${slug}' history...`).start();
  try {
    const rows =
      kind === 'project'
        ? await cloud.listProjects()
        : kind === 'workspace'
        ? await cloud.listWorkspaces()
        : kind === 'config'
        ? await cloud.listConfigs()
        : kind === 'module'
        ? await cloud.listModules()
        : ((await cloud.listProfiles()) as any[]);
    const entity = rows.find((r: any) => r.slug === slug);
    if (!entity) {
      spinner.fail(`${kind} '${slug}' not found.`);
      process.exit(1);
    }
    const versions: VersionRow[] = await cloud.listEntityVersions(kind, (entity as any).id);
    spinner.stop();

    if (versions.length === 0) {
      console.log(chalk.dim('No versions found.'));
      return;
    }
    const trimmed = versions.slice(0, limit);

    console.log(
      chalk.bold(`\n${kind} '${slug}' versions (${trimmed.length}/${versions.length}):\n`),
    );
    console.log(
      chalk.dim('  Ver'.padEnd(7)) +
        chalk.dim('Timestamp'.padEnd(24)) +
        chalk.dim('Machine'.padEnd(20)) +
        chalk.dim('Size'),
    );
    console.log(chalk.dim('  ' + '─'.repeat(60)));
    for (const v of trimmed) {
      const ver = `v${v.version}`.padEnd(5);
      const time = (v.created_at || '').slice(0, 19).padEnd(22);
      const machine = (v.pushed_from_machine_id || '').slice(0, 18).padEnd(18);
      const size = v.size_bytes ? formatBytes(v.size_bytes) : '?';
      console.log(`  ${chalk.cyan(ver)}  ${time}${machine}${chalk.dim(size)}`);
    }
    console.log(
      chalk.dim(
        `\n  Diff with: configsync diff --${kind} ${slug} --version <n>\n` +
          `  Rollback with: configsync rollback --${kind} ${slug} --version <n>`,
      ),
    );
  } catch (err: any) {
    spinner.fail(`Failed to fetch ${kind} history: ${err.message}`);
    process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
