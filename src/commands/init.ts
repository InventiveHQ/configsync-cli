import { Command, Option } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import { promptPassword } from '../lib/prompt.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize ConfigSync on this machine')
    .addOption(
      new Option('--sync-backend <backend>', 'sync backend to use')
        .choices(['local', 'cloud'])
        .default('local')
    )
    .option('--profile <name>', 'profile name', 'default')
    .action(async (options: { syncBackend: string; profile: string }) => {
      const configManager = new ConfigManager();

      if (configManager.exists()) {
        console.error(chalk.red('Error: ConfigSync is already initialized.'));
        console.error(chalk.yellow('Delete ~/.configsync to re-initialize.'));
        process.exit(1);
      }

      const password = await promptPassword('Enter master password: ');
      const confirm = await promptPassword('Confirm master password: ');

      if (password !== confirm) {
        console.error(chalk.red('Error: Passwords do not match.'));
        process.exit(1);
      }

      if (password.length < 8) {
        console.error(chalk.red('Error: Password must be at least 8 characters.'));
        process.exit(1);
      }

      configManager.init(options.profile, options.syncBackend);

      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.initialize(password);

      console.log(chalk.green('ConfigSync initialized successfully!'));
      console.log(`  Profile:  ${chalk.cyan(options.profile)}`);
      console.log(`  Backend:  ${chalk.cyan(options.syncBackend)}`);
      console.log(`  Config:   ${chalk.dim(configManager.configDir)}`);
    });
}
