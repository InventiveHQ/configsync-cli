import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../lib/config.js';

export function registerMachineCommand(program: Command): void {
  const machine = program
    .command('machine')
    .description('Manage machine-specific tags and variables');

  // --- Tags -----------------------------------------------------------

  const tag = machine.command('tag').description('Manage machine tags');

  tag
    .command('add <tag>')
    .description('Add a tag to this machine')
    .action((tagName: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      if (!config.machine) config.machine = { tags: [], vars: {} };
      if (!config.machine.tags) config.machine.tags = [];

      if (config.machine.tags.includes(tagName)) {
        console.log(chalk.yellow(`Tag "${tagName}" already exists.`));
        return;
      }

      config.machine.tags.push(tagName);
      configManager.save(config);
      console.log(chalk.green(`Added tag "${tagName}".`));
    });

  tag
    .command('remove <tag>')
    .description('Remove a tag from this machine')
    .action((tagName: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const tags = config.machine?.tags || [];
      const idx = tags.indexOf(tagName);

      if (idx === -1) {
        console.log(chalk.yellow(`Tag "${tagName}" not found.`));
        return;
      }

      tags.splice(idx, 1);
      configManager.save(config);
      console.log(chalk.green(`Removed tag "${tagName}".`));
    });

  tag
    .command('list')
    .description('List all tags on this machine')
    .action(() => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const tags = config.machine?.tags || [];

      if (tags.length === 0) {
        console.log(chalk.dim('No tags set.'));
        return;
      }

      console.log(chalk.bold('Machine tags:\n'));
      for (const t of tags) {
        console.log(`  ${chalk.cyan(t)}`);
      }
    });

  // --- Variables ------------------------------------------------------

  const varCmd = machine.command('var').description('Manage machine variables');

  varCmd
    .command('set <key> <value>')
    .description('Set a machine variable')
    .action((key: string, value: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      if (!config.machine) config.machine = { tags: [], vars: {} };
      if (!config.machine.vars) config.machine.vars = {};

      config.machine.vars[key] = value;
      configManager.save(config);
      console.log(chalk.green(`Set ${key} = "${value}".`));
    });

  varCmd
    .command('get <key>')
    .description('Get a machine variable')
    .action((key: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const value = config.machine?.vars?.[key];

      if (value === undefined) {
        console.log(chalk.yellow(`Variable "${key}" not set.`));
        process.exit(1);
      }

      console.log(value);
    });

  varCmd
    .command('list')
    .description('List all machine variables')
    .action(() => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const vars = config.machine?.vars || {};
      const keys = Object.keys(vars);

      if (keys.length === 0) {
        console.log(chalk.dim('No variables set.'));
        return;
      }

      console.log(chalk.bold('Machine variables:\n'));
      for (const k of keys) {
        console.log(`  ${chalk.cyan(k)} = ${vars[k]}`);
      }
    });
}
