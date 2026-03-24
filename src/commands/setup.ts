import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import CloudBackend from '../lib/cloud.js';
import { promptPassword } from '../lib/prompt.js';
import { EnvironmentManager } from '../lib/environment.js';
import { runBootstrapIfNeeded } from '../lib/bootstrap.js';

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('One-command setup: initialize, connect, and pull')
    .option('--token <token>', 'API token for cloud sync')
    .option('--from <machine>', 'pull from a specific machine')
    .option('--api-url <url>', 'API base URL', 'https://configsync.dev')
    .action(async (options: { token?: string; from?: string; apiUrl: string }) => {
      const configManager = new ConfigManager();

      // Step 1: Initialize if needed
      if (!configManager.exists()) {
        console.log(chalk.bold('Setting up ConfigSync...\n'));

        const password = await promptPassword('Create a master password (min 8 chars): ');
        const confirmPw = await promptPassword('Confirm master password: ');

        if (password !== confirmPw) {
          console.error(chalk.red('Passwords do not match.'));
          process.exit(1);
        }
        if (password.length < 8) {
          console.error(chalk.red('Password must be at least 8 characters.'));
          process.exit(1);
        }

        configManager.init('default', options.token ? 'cloud' : 'local');
        const cryptoManager = new CryptoManager(configManager.configDir);
        cryptoManager.initialize(password);
        console.log(chalk.green('  Initialized!\n'));
      } else {
        console.log(chalk.dim('Already initialized.\n'));
      }

      const config = configManager.load();
      const password = await promptPassword('Enter master password: ');
      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.unlock(password);

      // Step 2: Connect to cloud if token provided
      if (options.token) {
        const spinner = ora('Verifying token...').start();

        const backend = new CloudBackend(options.apiUrl, options.token);
        const valid = await backend.verifyToken();

        if (!valid) {
          spinner.fail('Invalid token.');
          process.exit(1);
        }

        config.sync.backend = 'cloud';
        config.sync.config.api_url = options.apiUrl;
        config.sync.config.api_key = options.token;
        configManager.save(config);

        await backend.registerMachine();
        spinner.succeed('Connected to cloud!');

        // Step 3: Pull state
        spinner.start('Pulling state...');

        let machineId: string | undefined;
        if (options.from) {
          const machines = await backend.listMachines();
          const match = machines.find((m: any) =>
            m.machine_id === options.from || m.name.toLowerCase().includes(options.from!.toLowerCase()));
          if (match) {
            machineId = match.machine_id;
            spinner.text = `Pulling from ${match.name}...`;
          }
        }

        const state = await backend.pull(cryptoManager, machineId);

        if (state) {
          spinner.succeed('State pulled!');

          const counts = [
            state.configs?.length && `${state.configs.length} configs`,
            state.repos?.length && `${state.repos.length} repos`,
            state.modules?.length && `${state.modules.length} modules`,
          ].filter(Boolean);
          if (counts.length) {
            console.log(chalk.dim(`  Found: ${counts.join(', ')}`));
          }

          console.log(chalk.dim('\n  Run "configsync pull" to restore everything.'));
          console.log(chalk.dim('  Run "configsync pull --dry-run" to preview first.'));
        } else {
          spinner.succeed('Connected! No existing state found.');
          console.log(chalk.dim('\n  Start adding your configs:'));
          console.log(chalk.dim('    configsync add module ssh'));
          console.log(chalk.dim('    configsync add config ~/.zshrc'));
          console.log(chalk.dim('    configsync push'));
        }
      } else {
        console.log(chalk.dim('No token provided — using local sync.'));
        console.log(chalk.dim('\n  Start adding your configs:'));
        console.log(chalk.dim('    configsync add module ssh'));
        console.log(chalk.dim('    configsync add config ~/.zshrc'));
        console.log(chalk.dim('    configsync push'));
      }

      // Step 4: Bootstrap if available
      try {
        await runBootstrapIfNeeded(config, configManager);
      } catch {
        // Bootstrap is optional
      }

      console.log(chalk.green('\nSetup complete!'));
    });
}
