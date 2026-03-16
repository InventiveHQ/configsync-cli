import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../lib/config.js';

export function registerRemoveCommand(program: Command): void {
  const removeCmd = program
    .command('remove')
    .description('Remove tracked items from config');

  // configsync remove config <path>
  removeCmd
    .command('config <path>')
    .description('Remove a tracked config file by its source path')
    .action(async (sourcePath: string) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      const index = config.configs.findIndex(
        c => c.source.toLowerCase() === sourcePath.toLowerCase()
      );

      if (index === -1) {
        console.error(chalk.red(`Config '${sourcePath}' is not tracked.`));
        process.exit(1);
      }

      const removed = config.configs.splice(index, 1)[0];
      configManager.save(config);
      console.log(chalk.green(`Removed config: ${removed.source}`));
    });

  // configsync remove project <name>
  removeCmd
    .command('project <name>')
    .description('Remove a tracked project by name')
    .action(async (name: string) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      if (!config.projects) config.projects = [];

      const index = config.projects.findIndex(
        p => p.name.toLowerCase() === name.toLowerCase()
      );

      if (index === -1) {
        console.error(chalk.red(`Project '${name}' is not tracked.`));
        process.exit(1);
      }

      const removed = config.projects.splice(index, 1)[0];
      configManager.save(config);
      console.log(chalk.green(`Removed project: ${removed.name} (${removed.path})`));
    });

  // configsync remove group <name>
  removeCmd
    .command('group <name>')
    .description('Remove a tracked group by name')
    .action(async (name: string) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      if (!config.groups) config.groups = [];

      const index = config.groups.findIndex(
        g => g.name.toLowerCase() === name.toLowerCase()
      );

      if (index === -1) {
        console.error(chalk.red(`Group '${name}' is not tracked.`));
        process.exit(1);
      }

      const removed = config.groups.splice(index, 1)[0];
      configManager.save(config);
      console.log(chalk.green(`Removed group: ${removed.name} (${removed.projects.length} project${removed.projects.length !== 1 ? 's' : ''})`));
    });

  // configsync remove repo <url>
  removeCmd
    .command('repo <url>')
    .description('Remove a standalone repo by URL')
    .action(async (url: string) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      const index = config.repos.findIndex(
        r => r.url.toLowerCase() === url.toLowerCase()
      );

      if (index === -1) {
        console.error(chalk.red(`Repo '${url}' is not tracked.`));
        process.exit(1);
      }

      const removed = config.repos.splice(index, 1)[0];
      configManager.save(config);
      console.log(chalk.green(`Removed repo: ${removed.url}`));
    });

  // configsync remove env <project_path>
  removeCmd
    .command('env <project_path>')
    .description('Remove a tracked env file by project path')
    .action(async (projectPath: string) => {
      const configManager = new ConfigManager();
      ensureInit(configManager);
      const config = configManager.load();

      const index = config.env_files.findIndex(
        e => e.project_path.toLowerCase() === projectPath.toLowerCase()
      );

      if (index === -1) {
        console.error(chalk.red(`Env file for '${projectPath}' is not tracked.`));
        process.exit(1);
      }

      const removed = config.env_files.splice(index, 1)[0];
      const filename = removed.filename || '.env';
      configManager.save(config);
      console.log(chalk.green(`Removed env file: ${removed.project_path}/${filename}`));
    });
}

function ensureInit(configManager: ConfigManager): void {
  if (!configManager.exists()) {
    console.error(chalk.red("Error: Run 'configsync init' or 'configsync login' first."));
    process.exit(1);
  }
}
