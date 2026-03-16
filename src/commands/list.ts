import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../lib/config.js';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('Show all tracked items organized by type')
    .action(async () => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      console.log(chalk.bold('ConfigSync — tracked items'));
      console.log();

      // Configs
      if (config.configs.length > 0) {
        console.log(chalk.bold(`Configs (${config.configs.length}):`));
        for (const item of config.configs) {
          console.log(`  ${chalk.cyan(item.source)}`);
        }
        console.log();
      }

      // Projects
      const projects = config.projects ?? [];
      if (projects.length > 0) {
        console.log(chalk.bold(`Projects (${projects.length}):`));
        for (const project of projects) {
          console.log(`  ${project.name} ${chalk.dim(`(${project.path})`)}`);
          if (project.repo) {
            console.log(`    repo: ${project.repo.url} ${chalk.dim(`(${project.repo.branch})`)}`);
          }
          if (project.secrets.length > 0) {
            console.log(`    secrets: ${project.secrets.join(', ')}`);
          }
          if (project.configs.length > 0) {
            console.log(`    configs: ${project.configs.join(', ')}`);
          }
        }
        console.log();
      }

      // Groups
      const groups = config.groups ?? [];
      if (groups.length > 0) {
        console.log(chalk.bold(`Groups (${groups.length}):`));
        for (const group of groups) {
          const projectCount = group.projects.length;
          console.log(`  ${group.name} ${chalk.dim(`(${group.path})`)} — ${projectCount} project${projectCount !== 1 ? 's' : ''}`);
          if (projectCount > 0) {
            console.log(`    ${group.projects.map(p => p.name).join(', ')}`);
          }
        }
        console.log();
      }

      // Packages
      const packages = config.packages ?? [];
      if (packages.length > 0) {
        const totalPackages = packages.reduce((sum, p) => sum + p.packages.length, 0);
        console.log(chalk.bold(`Packages (${totalPackages}):`));
        for (const pkg of packages) {
          console.log(`  ${pkg.displayName}: ${pkg.packages.length} packages`);
        }
        console.log();
      }

      // Standalone Repos
      if (config.repos.length > 0) {
        console.log(chalk.bold(`Standalone Repos (${config.repos.length}):`));
        for (const repo of config.repos) {
          console.log(`  ${repo.url} -> ${chalk.dim(repo.path)}`);
        }
        console.log();
      }

      // Standalone Env Files
      if (config.env_files.length > 0) {
        console.log(chalk.bold(`Standalone Env Files (${config.env_files.length}):`));
        for (const env of config.env_files) {
          const filename = env.filename || '.env';
          console.log(`  ${chalk.cyan(`${env.project_path}/${filename}`)}`);
        }
        console.log();
      }
    });
}
