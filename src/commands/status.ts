import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigManager } from '../lib/config.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current sync status')
    .action(async () => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      console.log(chalk.bold('ConfigSync Status'));
      console.log();
      console.log(`  Profile:   ${chalk.cyan(config.profile)}`);
      console.log(`  Backend:   ${chalk.cyan(config.sync.backend)}`);
      console.log(`  Config:    ${chalk.dim(configManager.configDir)}`);
      console.log();

      // Tracked configs
      console.log(chalk.bold(`Tracked Configs (${config.configs.length}):`));
      for (const item of config.configs) {
        const sourcePath = item.source.replace(/^~/, os.homedir());
        const resolvedPath = path.resolve(sourcePath);
        const exists = fs.existsSync(resolvedPath);

        const icon = exists ? chalk.green('\u2713') : chalk.red('\u2717');
        const label = item.encrypt ? `${item.source} ${chalk.dim('(encrypted)')}` : item.source;
        console.log(`  ${icon} ${label}`);
      }

      // Tracked repos
      if (config.repos.length > 0) {
        console.log();
        console.log(chalk.bold(`Tracked Repos (${config.repos.length}):`));
        for (const repo of config.repos) {
          const repoPath = repo.path.replace(/^~/, os.homedir());
          const resolvedPath = path.resolve(repoPath);
          const exists = fs.existsSync(resolvedPath);

          const icon = exists ? chalk.green('\u2713') : chalk.red('\u2717');
          console.log(`  ${icon} ${repo.url} -> ${repo.path}`);
        }
      }

      // Env files
      if (config.env_files.length > 0) {
        console.log();
        console.log(chalk.bold(`Tracked Env Files (${config.env_files.length}):`));
        for (const env of config.env_files) {
          const envPath = env.project_path.replace(/^~/, os.homedir());
          const filename = env.filename || '.env';
          const resolvedPath = path.resolve(path.join(envPath, filename));
          const exists = fs.existsSync(resolvedPath);

          const icon = exists ? chalk.green('\u2713') : chalk.red('\u2717');
          console.log(`  ${icon} ${env.project_path}/${filename}`);
        }
      }
    });
}
