import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../lib/config.js';

export function registerAddCommand(program: Command): void {
  const addCmd = program
    .command('add')
    .description('Add items to sync');

  addCmd
    .command('config <path>')
    .description('Add a config file or directory to sync')
    .option('--encrypt', 'encrypt this config item', false)
    .option('--exclude <pattern>', 'exclude pattern (can be repeated)', collectPatterns, [])
    .action(async (filePath: string, options: { encrypt: boolean; exclude: string[] }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      // Check for duplicates
      const existing = config.configs.find((c) => c.source === filePath);
      if (existing) {
        console.error(chalk.red(`Error: '${filePath}' is already tracked.`));
        process.exit(1);
      }

      const item: { source: string; encrypt?: boolean; exclude_patterns?: string[] } = {
        source: filePath,
      };

      if (options.encrypt) {
        item.encrypt = true;
      }

      if (options.exclude.length > 0) {
        item.exclude_patterns = options.exclude;
      }

      config.configs.push(item);
      configManager.save(config);

      console.log(chalk.green(`Added '${filePath}' to tracked configs.`));
      if (options.encrypt) {
        console.log(`  ${chalk.dim('(encrypted)')}`);
      }
    });
}

function collectPatterns(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
