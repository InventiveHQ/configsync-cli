import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../lib/config.js';

export function registerLogoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Log out from ConfigSync cloud')
    .action(async () => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      if (config.sync.backend !== 'cloud') {
        console.log(chalk.yellow('Not logged in to cloud backend.'));
        return;
      }

      delete config.sync.config.api_key;
      config.sync.backend = 'local';
      configManager.save(config);

      console.log(chalk.green('Logged out from ConfigSync cloud.'));
    });
}
