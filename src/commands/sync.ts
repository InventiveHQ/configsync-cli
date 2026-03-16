import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'node:readline';
import { ConfigManager } from '../lib/config.js';
import CloudBackend from '../lib/cloud.js';
import { getModule } from '../lib/modules.js';

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y') || answer === '');
    });
  });
}

function describeAction(action: any): string {
  const payload = action.payload || {};
  switch (action.type) {
    case 'add_module':
      return `Add module ${chalk.cyan(payload.name)}`;
    case 'remove_module':
      return `Remove module ${chalk.cyan(payload.name)}`;
    case 'add_package':
      return `Add package ${chalk.cyan(payload.package)} to ${chalk.cyan(payload.manager)}`;
    case 'remove_package':
      return `Remove package ${chalk.cyan(payload.package)} from ${chalk.cyan(payload.manager)}`;
    default:
      return `Unknown action: ${action.type}`;
  }
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Check for and apply pending actions from the dashboard')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options: { yes?: boolean }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      if (config.sync.backend !== 'cloud') {
        console.error(chalk.red('Error: sync command requires the cloud backend. Run "configsync login" first.'));
        process.exit(1);
      }

      const apiUrl = config.sync.config.api_url;
      const apiKey = config.sync.config.api_key;

      if (!apiUrl || !apiKey) {
        console.error(chalk.red('Error: Cloud backend not configured. Run "configsync login" first.'));
        process.exit(1);
      }

      const backend = new CloudBackend(apiUrl, apiKey);

      const spinner = ora('Checking for pending actions...').start();

      let actions: any[];
      try {
        actions = await backend.getActions();
      } catch (err: any) {
        spinner.fail(`Failed to fetch actions: ${err.message}`);
        process.exit(1);
      }

      if (actions.length === 0) {
        spinner.succeed('No pending changes.');
        return;
      }

      spinner.stop();

      console.log(chalk.bold(`\n${actions.length} pending action${actions.length !== 1 ? 's' : ''}:\n`));
      for (const action of actions) {
        console.log(`  ${chalk.yellow('*')} ${describeAction(action)}`);
      }
      console.log();

      if (!options.yes) {
        const ok = await confirm('Apply these changes? [Y/n] ');
        if (!ok) {
          console.log(chalk.dim('Cancelled.'));
          return;
        }
      }

      let applied = 0;

      for (const action of actions) {
        const payload = action.payload || {};

        switch (action.type) {
          case 'add_module': {
            const mod = getModule(payload.name);
            if (!mod) {
              console.log(chalk.yellow(`  Skipped: unknown module "${payload.name}"`));
              break;
            }

            const existing = (config.modules || []).find((m) => m.name === mod.name);
            if (existing) {
              console.log(chalk.dim(`  Module "${mod.name}" already in config, skipping.`));
              break;
            }

            if (!config.modules) config.modules = [];
            config.modules.push({
              name: mod.name,
              files: mod.files.map((f) => ({ path: f.relative, encrypt: f.encrypt })),
              extras: mod.extras,
            });

            console.log(chalk.green(`  Added module ${chalk.bold(mod.displayName)}`));
            if (mod.files.length > 0) {
              for (const f of mod.files) {
                console.log(chalk.dim(`    ${f.relative}${f.encrypt ? ' (encrypted)' : ''}`));
              }
            }
            applied++;
            break;
          }

          case 'remove_module': {
            if (!config.modules) {
              console.log(chalk.dim(`  No modules configured, skipping.`));
              break;
            }

            const idx = config.modules.findIndex((m) => m.name === payload.name);
            if (idx === -1) {
              console.log(chalk.dim(`  Module "${payload.name}" not found in config, skipping.`));
              break;
            }

            config.modules.splice(idx, 1);
            console.log(chalk.green(`  Removed module ${chalk.bold(payload.name)}`));
            applied++;
            break;
          }

          case 'remove_package': {
            if (!config.packages) {
              console.log(chalk.dim(`  No packages configured, skipping.`));
              break;
            }

            let removed = false;
            for (const pkgList of config.packages) {
              if (payload.manager && pkgList.manager !== payload.manager) continue;
              const pkgIdx = pkgList.packages.indexOf(payload.package);
              if (pkgIdx !== -1) {
                pkgList.packages.splice(pkgIdx, 1);
                console.log(chalk.green(`  Removed ${chalk.bold(payload.package)} from ${pkgList.displayName}`));
                removed = true;
                break;
              }
            }

            if (!removed) {
              console.log(chalk.dim(`  Package "${payload.package}" not found, skipping.`));
            } else {
              applied++;
            }
            break;
          }

          case 'add_package': {
            if (!config.packages) config.packages = [];

            let pkgList = config.packages.find((p) => p.manager === payload.manager);
            if (!pkgList) {
              pkgList = {
                manager: payload.manager,
                displayName: payload.displayName || payload.manager,
                packages: [],
              };
              config.packages.push(pkgList);
            }

            if (pkgList.packages.includes(payload.package)) {
              console.log(chalk.dim(`  Package "${payload.package}" already in ${pkgList.displayName}, skipping.`));
              break;
            }

            pkgList.packages.push(payload.package);
            console.log(chalk.green(`  Added ${chalk.bold(payload.package)} to ${pkgList.displayName}`));

            // Show the install command
            const installCmds: Record<string, string> = {
              brew: `brew install ${payload.package}`,
              'brew-cask': `brew install --cask ${payload.package}`,
              npm: `npm install -g ${payload.package}`,
              pip: `pip install ${payload.package}`,
              cargo: `cargo install ${payload.package}`,
              apt: `sudo apt install ${payload.package}`,
            };
            const cmd = installCmds[payload.manager];
            if (cmd) {
              console.log(chalk.dim(`    Install with: ${cmd}`));
            }
            applied++;
            break;
          }

          default:
            console.log(chalk.yellow(`  Unknown action type: ${action.type}`));
        }
      }

      if (applied > 0) {
        configManager.save(config);
        console.log(chalk.green(`\nConfig saved. ${applied} action${applied !== 1 ? 's' : ''} applied.`));
      }

      // Clear pending actions
      const clearSpinner = ora('Clearing pending actions...').start();
      try {
        await backend.clearActions();
        clearSpinner.succeed('Pending actions cleared.');
      } catch (err: any) {
        clearSpinner.fail(`Failed to clear actions: ${err.message}`);
      }

      // Auto-push the updated state
      if (applied > 0) {
        console.log(chalk.dim('\nRun "configsync push" to sync the updated config to the cloud.'));
      }
    });
}
