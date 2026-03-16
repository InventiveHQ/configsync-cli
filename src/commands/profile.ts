import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { ConfigManager, ProfileDef } from '../lib/config.js';
import { ProfileManager } from '../lib/profiles.js';
import { EnvironmentManager, isValidEnvName } from '../lib/environment.js';
import { renderBanner } from '../lib/banner.js';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

export function registerProfileCommand(program: Command): void {
  const profile = program
    .command('profile')
    .description('Manage configuration profiles');

  // --- list -----------------------------------------------------------

  profile
    .command('list')
    .description('List all profiles and mark the active one')
    .action(() => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profiles = config.profiles || [];
      const profileManager = new ProfileManager(configManager.configDir);
      const activeName = profileManager.resolve(config, program.opts().profile);

      if (profiles.length === 0) {
        console.log(chalk.dim('No profiles defined.'));
        console.log(chalk.dim('Run "configsync profile create <name>" to create one.'));
        return;
      }

      console.log(chalk.bold('Profiles:\n'));

      // Calculate column widths for alignment
      const nameWidth = Math.max(...profiles.map(p => p.name.length), 4);

      for (const p of profiles) {
        const isActive = p.name === activeName;
        const envLabel = p.environment ? chalk.dim(` env=${p.environment}`) : '';
        const pathCount = (p.paths || []).length;
        const varCount = Object.keys(p.vars || {}).length;
        const overrideCount = Object.keys(p.env_overrides || {}).length;
        const activeBadge = isActive ? chalk.green(' \u2190 active') : '';

        const stats: string[] = [];
        if (pathCount > 0) stats.push(`${pathCount} path${pathCount !== 1 ? 's' : ''}`);
        if (varCount > 0) stats.push(`${varCount} var${varCount !== 1 ? 's' : ''}`);
        if (overrideCount > 0) stats.push(`${overrideCount} override${overrideCount !== 1 ? 's' : ''}`);
        const statsStr = stats.length > 0 ? chalk.dim(` [${stats.join(', ')}]`) : '';

        const bullet = isActive ? chalk.green('\u25cf') : chalk.dim('\u25cb');
        const name = p.name.padEnd(nameWidth);

        console.log(`  ${bullet} ${chalk.bold(name)}${envLabel}${statsStr}${activeBadge}`);
        for (const pathEntry of p.paths || []) {
          console.log(chalk.dim(`      ${pathEntry}`));
        }
      }
    });

  // --- create ---------------------------------------------------------

  profile
    .command('create <name>')
    .description('Create a new profile')
    .option('--env <environment>', 'auto-activate this environment when profile is active')
    .option('--path <path>', 'associate a directory path (repeatable)', (val: string, acc: string[]) => { acc.push(val); return acc; }, [])
    .option('--copy-from <profile>', 'copy vars and env_overrides from an existing profile')
    .option('--description <text>', 'human-readable description')
    .action(async (name: string, options: { env?: string; path: string[]; copyFrom?: string; description?: string }) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      if (!isValidEnvName(name)) {
        console.error(chalk.red('Invalid profile name. Use lowercase letters, numbers, hyphens, and underscores (must start with letter or number).'));
        process.exit(1);
      }

      const config = configManager.load();
      if (!config.profiles) config.profiles = [];

      if (config.profiles.find(p => p.name === name)) {
        console.error(chalk.red(`Profile "${name}" already exists.`));
        process.exit(1);
      }

      // Prompt for environment if not provided
      let environment = options.env;
      if (!environment && !process.argv.includes('--env')) {
        const envs = (config.environments || []).map(e => e.name);
        if (envs.length > 0) {
          const answer = await ask(`Environment to auto-activate (${envs.join('/')}) [none]: `);
          if (answer) environment = answer;
        }
      }

      // Validate environment name if provided
      if (environment) {
        const envDef = (config.environments || []).find(e => e.name === environment);
        if (!envDef) {
          console.error(chalk.red(`Environment "${environment}" not found.`));
          const names = (config.environments || []).map(e => e.name);
          if (names.length > 0) console.log(chalk.dim(`  Available: ${names.join(', ')}`));
          process.exit(1);
        }
      }

      const profileDef: ProfileDef = { name };
      if (environment) profileDef.environment = environment;
      if (options.path.length > 0) profileDef.paths = options.path;
      if (options.description) profileDef.description = options.description;

      // Copy from source profile
      if (options.copyFrom) {
        const source = config.profiles.find(p => p.name === options.copyFrom);
        if (!source) {
          console.error(chalk.red(`Source profile "${options.copyFrom}" not found.`));
          process.exit(1);
        }
        if (source.vars) profileDef.vars = { ...source.vars };
        if (source.env_overrides) profileDef.env_overrides = { ...source.env_overrides };
      }

      config.profiles.push(profileDef);
      configManager.save(config);

      console.log(chalk.green(`Created profile "${name}".`));
      if (environment) console.log(chalk.dim(`  Environment: ${environment}`));
      if (options.copyFrom) console.log(chalk.dim(`  Copied vars/overrides from "${options.copyFrom}".`));
    });

  // --- switch ---------------------------------------------------------

  profile
    .command('switch <name>')
    .description('Switch to a profile (persists in ~/.configsync/active-profile)')
    .action((name: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profileDef = (config.profiles || []).find(p => p.name === name);
      if (!profileDef) {
        console.error(chalk.red(`Profile "${name}" not found.`));
        const names = (config.profiles || []).map(p => p.name);
        if (names.length > 0) console.log(chalk.dim(`  Available: ${names.join(', ')}`));
        process.exit(1);
      }

      const profileManager = new ProfileManager(configManager.configDir);
      profileManager.activate(name);

      console.log(chalk.green(`Switched to profile "${name}".`));

      // Auto-activate the linked environment
      if (profileDef.environment) {
        const envDef = (config.environments || []).find(e => e.name === profileDef.environment);
        if (envDef) {
          const envManager = new EnvironmentManager(configManager.configDir);
          envManager.activate(envDef);
          console.log(renderBanner(envDef));
          console.log(chalk.green(`\nEnvironment "${envDef.name}" activated.`));
        } else {
          console.log(chalk.yellow(`  Warning: linked environment "${profileDef.environment}" not found.`));
        }
      }
    });

  // --- delete ---------------------------------------------------------

  profile
    .command('delete <name>')
    .description('Delete a profile')
    .action(async (name: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profiles = config.profiles || [];
      const idx = profiles.findIndex(p => p.name === name);

      if (idx === -1) {
        console.error(chalk.red(`Profile "${name}" not found.`));
        process.exit(1);
      }

      const answer = await ask(chalk.yellow(`Delete profile "${name}"? Type the name to confirm: `));
      if (answer !== name) {
        console.log(chalk.dim('Cancelled.'));
        return;
      }

      profiles.splice(idx, 1);
      configManager.save(config);

      // Deactivate if this was the active profile
      const profileManager = new ProfileManager(configManager.configDir);
      const activeName = profileManager.resolve(config);
      if (activeName === name) {
        profileManager.deactivate();
      }

      console.log(chalk.green(`Deleted profile "${name}".`));
    });

  // --- show -----------------------------------------------------------

  profile
    .command('show [name]')
    .description('Show details of a profile (defaults to active profile)')
    .action((name?: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profileManager = new ProfileManager(configManager.configDir);

      let profileDef: ProfileDef | null | undefined;
      if (name) {
        profileDef = (config.profiles || []).find(p => p.name === name);
        if (!profileDef) {
          console.error(chalk.red(`Profile "${name}" not found.`));
          process.exit(1);
        }
      } else {
        profileDef = profileManager.getActive(config, program.opts().profile);
        if (!profileDef) {
          console.log(chalk.dim('No active profile. Specify a name or switch to a profile first.'));
          return;
        }
      }

      const activeName = profileManager.resolve(config, program.opts().profile);
      const isActive = profileDef.name === activeName;

      console.log(chalk.bold(`\nProfile: ${profileDef.name}`) + (isActive ? chalk.green(' (active)') : ''));

      if (profileDef.description) {
        console.log(chalk.dim(`  ${profileDef.description}`));
      }

      if (profileDef.environment) {
        console.log(`\n${chalk.bold('Environment:')} ${chalk.cyan(profileDef.environment)}`);
      }

      const paths = profileDef.paths || [];
      if (paths.length > 0) {
        console.log(`\n${chalk.bold('Paths:')}`);
        for (const p of paths) {
          const display = p.replace(/^~/, os.homedir());
          console.log(`  ${chalk.dim(display)}`);
        }
      }

      const vars = profileDef.vars || {};
      const varKeys = Object.keys(vars);
      if (varKeys.length > 0) {
        console.log(`\n${chalk.bold('Variables:')}`);
        for (const k of varKeys) {
          console.log(`  ${chalk.cyan(k)} = ${vars[k]}`);
        }
      }

      const overrides = profileDef.env_overrides || {};
      const overrideKeys = Object.keys(overrides);
      if (overrideKeys.length > 0) {
        console.log(`\n${chalk.bold('Env Overrides:')}`);
        for (const k of overrideKeys) {
          console.log(`  ${chalk.cyan(k)} = ${overrides[k]}`);
        }
      }

      console.log();
    });

  // --- set-path -------------------------------------------------------

  profile
    .command('set-path <name> <path>')
    .description('Add a directory path to a profile')
    .action((name: string, dirPath: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profileDef = (config.profiles || []).find(p => p.name === name);
      if (!profileDef) {
        console.error(chalk.red(`Profile "${name}" not found.`));
        process.exit(1);
      }

      if (!profileDef.paths) profileDef.paths = [];

      if (profileDef.paths.includes(dirPath)) {
        console.log(chalk.yellow(`Path already associated with profile "${name}".`));
        return;
      }

      profileDef.paths.push(dirPath);
      configManager.save(config);

      const display = dirPath.replace(/^~/, os.homedir());
      console.log(chalk.green(`Added path "${display}" to profile "${name}".`));
    });

  // --- remove-path ----------------------------------------------------

  profile
    .command('remove-path <name> <path>')
    .description('Remove a directory path from a profile')
    .action((name: string, dirPath: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profileDef = (config.profiles || []).find(p => p.name === name);
      if (!profileDef) {
        console.error(chalk.red(`Profile "${name}" not found.`));
        process.exit(1);
      }

      const paths = profileDef.paths || [];
      const idx = paths.indexOf(dirPath);

      if (idx === -1) {
        console.error(chalk.red(`Path "${dirPath}" not found on profile "${name}".`));
        process.exit(1);
      }

      paths.splice(idx, 1);
      configManager.save(config);

      console.log(chalk.green(`Removed path "${dirPath}" from profile "${name}".`));
    });

  // --- set-var --------------------------------------------------------

  profile
    .command('set-var <name> <key> <value>')
    .description('Set a variable on a profile')
    .action((name: string, key: string, value: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profileDef = (config.profiles || []).find(p => p.name === name);
      if (!profileDef) {
        console.error(chalk.red(`Profile "${name}" not found.`));
        process.exit(1);
      }

      if (!profileDef.vars) profileDef.vars = {};
      profileDef.vars[key] = value;
      configManager.save(config);

      console.log(chalk.green(`Set ${key} = "${value}" on profile "${name}".`));
    });

  // --- set-env-override -----------------------------------------------

  profile
    .command('set-env-override <name> <key> <value>')
    .description('Set an env override on a profile')
    .action((name: string, key: string, value: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profileDef = (config.profiles || []).find(p => p.name === name);
      if (!profileDef) {
        console.error(chalk.red(`Profile "${name}" not found.`));
        process.exit(1);
      }

      if (!profileDef.env_overrides) profileDef.env_overrides = {};
      profileDef.env_overrides[key] = value;
      configManager.save(config);

      console.log(chalk.green(`Set env override ${key} = "${value}" on profile "${name}".`));
    });

  // --- unset-var ------------------------------------------------------

  profile
    .command('unset-var <name> <key>')
    .description('Remove a variable from a profile')
    .action((name: string, key: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profileDef = (config.profiles || []).find(p => p.name === name);
      if (!profileDef) {
        console.error(chalk.red(`Profile "${name}" not found.`));
        process.exit(1);
      }

      const vars = profileDef.vars || {};
      if (!(key in vars)) {
        console.error(chalk.red(`Variable "${key}" not found on profile "${name}".`));
        process.exit(1);
      }

      delete vars[key];
      configManager.save(config);

      console.log(chalk.green(`Removed variable "${key}" from profile "${name}".`));
    });

  // --- unset-env-override ---------------------------------------------

  profile
    .command('unset-env-override <name> <key>')
    .description('Remove an env override from a profile')
    .action((name: string, key: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const profileDef = (config.profiles || []).find(p => p.name === name);
      if (!profileDef) {
        console.error(chalk.red(`Profile "${name}" not found.`));
        process.exit(1);
      }

      const overrides = profileDef.env_overrides || {};
      if (!(key in overrides)) {
        console.error(chalk.red(`Env override "${key}" not found on profile "${name}".`));
        process.exit(1);
      }

      delete overrides[key];
      configManager.save(config);

      console.log(chalk.green(`Removed env override "${key}" from profile "${name}".`));
    });
}
