import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigManager } from '../lib/config.js';
import { scanPackages, formatPackageSummary } from '../lib/packages.js';
import { diffPackages, formatDiff } from '../lib/package-diff.js';
import { loadMappings } from '../lib/package-mappings.js';
import CloudBackend from '../lib/cloud.js';
import CryptoManager from '../lib/crypto.js';
import { promptPassword } from '../lib/prompt.js';

function applyExclusions(
  managers: { name: string; displayName: string; available: boolean; packages: string[] }[],
  excludePatterns: string[],
): typeof managers {
  if (excludePatterns.length === 0) return managers;

  const regexes = excludePatterns.map(pattern => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
  });

  return managers.map(mgr => ({
    ...mgr,
    packages: mgr.packages.filter(pkg => {
      const name = pkg.includes(':') ? pkg.split(':').slice(1).join(':') : pkg;
      return !regexes.some(re => re.test(name) || re.test(pkg));
    }),
  })).filter(mgr => mgr.packages.length > 0);
}

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Scan for installed packages and save to sync state')
    .option('--diff', 'Show diff against remote packages without installing')
    .action(async (options: { diff?: boolean }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' or 'configsync login' first."));
        process.exit(1);
      }

      const config = configManager.load();

      const spinner = ora('Scanning for installed packages...').start();
      let managers = scanPackages();
      spinner.stop();

      // Apply exclusion globs
      managers = applyExclusions(managers, config.package_exclude || []);

      if (managers.length === 0) {
        console.log(chalk.yellow('No supported package managers found.'));
        return;
      }

      const totalPackages = managers.reduce((sum, m) => sum + m.packages.length, 0);
      console.log(chalk.green(`Found ${totalPackages} packages across ${managers.length} package manager(s):\n`));
      console.log(formatPackageSummary(managers));
      console.log('');

      if (options.diff) {
        // Diff mode: compare local with remote
        if (config.sync.backend !== 'cloud') {
          console.log(chalk.yellow('Diff mode requires cloud backend. Run "configsync login" first.'));
          return;
        }

        const apiUrl = config.sync.config.api_url;
        const apiKey = config.sync.config.api_key;
        if (!apiUrl || !apiKey) {
          console.log(chalk.yellow('Cloud backend not configured. Run "configsync login" first.'));
          return;
        }

        const password = await promptPassword('Enter master password: ');
        const cryptoManager = new CryptoManager(configManager.configDir);
        cryptoManager.unlock(password);

        const diffSpinner = ora('Fetching remote packages...').start();
        try {
          const backend = new CloudBackend(apiUrl, apiKey);
          const state = await backend.pull(cryptoManager);

          if (!state || !state.packages || state.packages.length === 0) {
            diffSpinner.fail('No remote package data found. Run "configsync push" on another machine first.');
            return;
          }

          diffSpinner.stop();

          const mappings = loadMappings(config);
          const diff = diffPackages(managers, state.packages, mappings);
          console.log(formatDiff(diff));

          let totalMissing = 0;
          for (const pkgs of diff.missing.values()) totalMissing += pkgs.length;
          if (totalMissing > 0) {
            console.log('');
            console.log(chalk.dim('Run "configsync pull --install" to install missing packages.'));
          }
        } catch (err: any) {
          diffSpinner.fail(`Diff failed: ${err.message}`);
        }

        return;
      }

      // Normal mode: save to config
      config.packages = managers.map(m => ({
        manager: m.name,
        displayName: m.displayName,
        packages: m.packages,
      }));
      configManager.save(config);

      console.log(chalk.green('Package list saved!'));
      console.log(chalk.dim('Run "configsync push" to sync to the cloud.'));
    });
}
