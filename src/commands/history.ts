import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigManager } from '../lib/config.js';
import CloudBackend from '../lib/cloud.js';

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('List past sync snapshots')
    .option('-n, --limit <n>', 'number of snapshots to show', '20')
    .option('--from <machine>', 'filter by machine name or ID')
    .action(async (options: { limit: string; from?: string }) => {
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
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
