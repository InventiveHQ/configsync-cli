import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import CloudBackend from '../lib/cloud.js';
import { promptPassword } from '../lib/prompt.js';

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Log in to ConfigSync cloud (auto-initializes if needed)')
    .option('--token <token>', 'API token')
    .option('--api-url <url>', 'API base URL', 'https://configsync.dev')
    .action(async (options: { token?: string; apiUrl: string }) => {
      const configManager = new ConfigManager();

      const token = options.token || await promptPassword('Enter API token: ');

      if (!token) {
        console.error(chalk.red('Error: Token is required.'));
        process.exit(1);
      }

      // Verify token first
      const backend = new CloudBackend(options.apiUrl, token);
      const valid = await backend.verifyToken();

      if (!valid) {
        console.error(chalk.red('Error: Invalid token.'));
        process.exit(1);
      }

      // Auto-initialize if not already set up
      if (!configManager.exists()) {
        console.log(chalk.dim('First time setup — initializing ConfigSync...\n'));

        const password = await promptPassword('Create a master password (min 8 chars): ');
        const confirm = await promptPassword('Confirm master password: ');

        if (password !== confirm) {
          console.error(chalk.red('Error: Passwords do not match.'));
          process.exit(1);
        }

        if (password.length < 8) {
          console.error(chalk.red('Error: Password must be at least 8 characters.'));
          process.exit(1);
        }

        configManager.init('default', 'cloud');

        const cryptoManager = new CryptoManager(configManager.configDir);
        cryptoManager.initialize(password);

        console.log(chalk.green('Initialized!\n'));
      }

      const config = configManager.load();
      config.sync.backend = 'cloud';
      config.sync.config.api_url = options.apiUrl;
      config.sync.config.api_key = token;
      configManager.save(config);

      console.log(chalk.green('Logged in to ConfigSync cloud successfully!'));
      console.log(`  API URL:  ${chalk.cyan(options.apiUrl)}`);
      console.log(chalk.dim('\nNext: add configs to track, then push:'));
      console.log(chalk.dim('  configsync add config ~/.zshrc'));
      console.log(chalk.dim('  configsync add config ~/.gitconfig'));
      console.log(chalk.dim('  configsync push'));
    });
}
