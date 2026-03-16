import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'node:readline';
import { ConfigManager, EnvironmentDef } from '../lib/config.js';
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
  switch (action.action) {
    case 'add_module':
      return `Add module: ${chalk.cyan(payload.name)}`;
    case 'remove_module':
      return `Remove module: ${chalk.cyan(payload.name)}`;
    case 'add_package': {
      const pkg = payload.item || payload.package;
      return `Add package: ${chalk.cyan(pkg)}`;
    }
    case 'remove_package': {
      const pkg = payload.item || payload.package;
      const name = pkg?.includes(':') ? pkg.split(':').slice(1).join(':') : pkg;
      return `Remove package: ${chalk.cyan(name)}`;
    }
    case 'add_environment': return `Add environment: ${chalk.cyan(payload.name)} (${payload.tier})`;
    case 'update_environment': return `Update environment: ${chalk.cyan(payload.name)}`;
    case 'remove_environment': return `Remove environment: ${chalk.cyan(payload.name)}`;
    default:
      return `Unknown action: ${action.action}`;
  }
}

interface SyncOptions {
  yes?: boolean;
  noDeleteLocal?: boolean;
  noDeleteCloud?: boolean;
  cloudWins?: boolean;
  localWins?: boolean;
}

/**
 * Merge cloud environments into local config based on flags.
 *
 * Returns { added, updated, removed } counts.
 */
function mergeCloudToLocal(
  config: any,
  cloudEnvs: any[],
  opts: SyncOptions,
): { added: number; updated: number; removed: number } {
  if (!config.environments) config.environments = [];
  const localByName = new Map<string, EnvironmentDef>();
  for (const e of config.environments) localByName.set(e.name, e);

  const cloudByName = new Map<string, any>();
  for (const e of cloudEnvs) cloudByName.set(e.name, e);

  let added = 0;
  let updated = 0;
  let removed = 0;

  // Add cloud-only envs to local
  for (const cloudEnv of cloudEnvs) {
    const local = localByName.get(cloudEnv.name);
    if (!local) {
      config.environments.push({
        name: cloudEnv.name,
        tier: cloudEnv.tier,
        color: cloudEnv.color,
        protect: !!cloudEnv.protect,
      });
      added++;
    } else if (opts.cloudWins) {
      // Cloud wins: overwrite local with cloud values
      local.tier = cloudEnv.tier;
      local.color = cloudEnv.color;
      local.protect = !!cloudEnv.protect;
      updated++;
    }
    // Default (local-wins): local values are kept, no update needed
  }

  // Remove local envs that don't exist in cloud (unless --no-delete-local)
  if (!opts.noDeleteLocal) {
    const toRemove = config.environments.filter(
      (e: EnvironmentDef) => !cloudByName.has(e.name)
    );
    for (const env of toRemove) {
      const idx = config.environments.indexOf(env);
      if (idx !== -1) {
        config.environments.splice(idx, 1);
        removed++;
      }
    }
  }

  return { added, updated, removed };
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Bidirectional sync: merge local and cloud environments, then apply pending actions')
    .option('-y, --yes', 'skip confirmation prompt')
    .option('--no-delete-local', 'keep local environments even if deleted on cloud')
    .option('--no-delete-cloud', 'keep cloud environments even if deleted locally')
    .option('--cloud-wins', 'on conflict, prefer cloud version over local')
    .option('--local-wins', 'on conflict, prefer local version (default)')
    .action(async (options: SyncOptions) => {
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

      if (options.cloudWins && options.localWins) {
        console.error(chalk.red('Error: --cloud-wins and --local-wins are mutually exclusive.'));
        process.exit(1);
      }

      const backend = new CloudBackend(apiUrl, apiKey);

      // --- Bidirectional environment sync ---
      const envSpinner = ora('Syncing environments...').start();
      try {
        const localEnvs = (config.environments || []).map(e => ({
          name: e.name,
          tier: e.tier,
          color: e.color || null,
          protect: !!e.protect,
        }));

        // Push local to cloud (cloud-only envs deleted only if !noDeleteCloud)
        const merged = await backend.syncEnvironments(localEnvs, {
          deleteCloudOnly: !options.noDeleteCloud,
        });

        // Merge cloud into local
        const result = mergeCloudToLocal(config, merged, options);

        if (result.added > 0 || result.updated > 0 || result.removed > 0) {
          configManager.save(config);
        }

        const envParts: string[] = [];
        if (result.added > 0) envParts.push(`${result.added} added from cloud`);
        if (result.updated > 0) envParts.push(`${result.updated} updated from cloud`);
        if (result.removed > 0) envParts.push(`${result.removed} removed locally`);
        if (localEnvs.length > 0) envParts.push(`${localEnvs.length} pushed to cloud`);
        envSpinner.succeed(`Environments synced! (${envParts.join(', ') || 'no changes'})`);
      } catch (err: any) {
        envSpinner.warn(`Environment sync failed: ${err.message}`);
      }

      // --- Pending actions (modules, packages, etc.) ---
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

        switch (action.action) {
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

            const pkgItem = payload.item || payload.package;
            let removed = false;
            for (const pkgList of config.packages) {
              const pkgIdx = pkgList.packages.indexOf(pkgItem);
              if (pkgIdx !== -1) {
                pkgList.packages.splice(pkgIdx, 1);
                const displayName = pkgItem.includes(':') ? pkgItem.split(':').slice(1).join(':') : pkgItem;
                console.log(chalk.green(`  Removed ${chalk.bold(displayName)} from ${pkgList.displayName}`));
                removed = true;
                break;
              }
            }

            if (!removed) {
              console.log(chalk.dim(`  Package "${pkgItem}" not found, skipping.`));
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

          case 'add_environment': {
            if (!config.environments) config.environments = [];
            const existing = config.environments.find((e) => e.name === payload.name);
            if (existing) {
              console.log(chalk.dim(`  Environment "${payload.name}" already exists, skipping.`));
              break;
            }
            config.environments.push({
              name: payload.name,
              tier: payload.tier || 'custom',
              label: payload.label,
              color: payload.color,
              api_url: payload.api_url,
              protect: !!payload.protect,
            });
            console.log(chalk.green(`  Added environment ${chalk.bold(payload.name)} (${payload.tier || 'custom'})`));
            applied++;
            break;
          }

          case 'update_environment': {
            if (!config.environments) {
              console.log(chalk.dim(`  No environments configured, skipping.`));
              break;
            }
            const env = config.environments.find((e) => e.name === payload.name);
            if (!env) {
              console.log(chalk.dim(`  Environment "${payload.name}" not found, skipping.`));
              break;
            }
            if (payload.tier !== undefined) env.tier = payload.tier;
            if (payload.color !== undefined) env.color = payload.color;
            if (payload.protect !== undefined) env.protect = payload.protect;
            if (payload.label !== undefined) env.label = payload.label;
            if (payload.api_url !== undefined) env.api_url = payload.api_url;
            console.log(chalk.green(`  Updated environment ${chalk.bold(payload.name)}`));
            applied++;
            break;
          }

          case 'remove_environment': {
            if (!config.environments) {
              console.log(chalk.dim(`  No environments configured, skipping.`));
              break;
            }
            const idx = config.environments.findIndex((e) => e.name === payload.name);
            if (idx === -1) {
              console.log(chalk.dim(`  Environment "${payload.name}" not found, skipping.`));
              break;
            }
            config.environments.splice(idx, 1);
            console.log(chalk.green(`  Removed environment ${chalk.bold(payload.name)}`));
            applied++;
            break;
          }

          default:
            console.log(chalk.yellow(`  Unknown action type: ${action.action}`));
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

      if (applied > 0) {
        console.log(chalk.dim('\nRun "configsync push" to sync the updated config to the cloud.'));
      }
    });
}
