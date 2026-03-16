import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigManager } from '../lib/config.js';
import { scanPackages, formatPackageSummary } from '../lib/packages.js';

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Scan for installed packages and save to sync state')
    .action(async () => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' or 'configsync login' first."));
        process.exit(1);
      }

      const spinner = ora('Scanning for installed packages...').start();
      const managers = scanPackages();
      spinner.stop();

      if (managers.length === 0) {
        console.log(chalk.yellow('No supported package managers found.'));
        return;
      }

      const totalPackages = managers.reduce((sum, m) => sum + m.packages.length, 0);
      console.log(chalk.green(`Found ${totalPackages} packages across ${managers.length} package manager(s):\n`));
      console.log(formatPackageSummary(managers));
      console.log('');

      // Save to config
      const config = configManager.load();
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
