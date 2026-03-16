import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'node:readline';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import CloudBackend from '../lib/cloud.js';
import { promptPassword } from '../lib/prompt.js';
import { detectPackageManagers, scanPackages, formatPackageSummary } from '../lib/packages.js';

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

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
      console.log(`  API URL:  ${chalk.cyan(options.apiUrl)}\n`);

      // Offer to scan for packages
      const detected = detectPackageManagers();
      if (detected.length > 0) {
        console.log(`Found package managers: ${chalk.cyan(detected.join(', '))}`);
        const shouldScan = await confirm('Scan for installed packages? (Y/n) ');

        if (shouldScan) {
          const spinner = ora('Scanning installed packages...').start();
          const managers = scanPackages();
          spinner.stop();

          if (managers.length > 0) {
            const totalPackages = managers.reduce((sum, m) => sum + m.packages.length, 0);
            console.log(chalk.green(`\nFound ${totalPackages} packages:\n`));
            console.log(formatPackageSummary(managers));

            const updatedConfig = configManager.load();
            updatedConfig.packages = managers.map(m => ({
              manager: m.name,
              displayName: m.displayName,
              packages: m.packages,
            }));
            configManager.save(updatedConfig);
            console.log(chalk.dim('\nPackage list saved to config.'));
          }
        }
      }

      console.log(chalk.dim('\nNext steps:'));
      console.log(chalk.dim('  configsync add config ~/.zshrc'));
      console.log(chalk.dim('  configsync add config ~/.gitconfig'));
      console.log(chalk.dim('  configsync push'));
    });
}
