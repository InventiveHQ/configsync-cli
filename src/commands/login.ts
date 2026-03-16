import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../lib/config.js';
import CloudBackend from '../lib/cloud.js';
import { promptPassword } from '../lib/prompt.js';

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Log in to ConfigSync cloud')
    .option('--token <token>', 'API token')
    .option('--api-url <url>', 'API base URL', 'https://configsync.dev')
    .action(async (options: { token?: string; apiUrl: string }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const token = options.token || await promptPassword('Enter API token: ');

      if (!token) {
        console.error(chalk.red('Error: Token is required.'));
        process.exit(1);
      }

      const backend = new CloudBackend(options.apiUrl, token);
      const valid = await backend.verifyToken();

      if (!valid) {
        console.error(chalk.red('Error: Invalid token.'));
        process.exit(1);
      }

      const config = configManager.load();
      config.sync.backend = 'cloud';
      config.sync.config.api_url = options.apiUrl;
      config.sync.config.api_key = token;
      configManager.save(config);

      console.log(chalk.green('Logged in to ConfigSync cloud successfully!'));
      console.log(`  API URL:  ${chalk.cyan(options.apiUrl)}`);
    });
}
