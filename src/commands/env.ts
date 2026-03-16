import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { ConfigManager, EnvironmentDef } from '../lib/config.js';
import { EnvironmentManager, isValidEnvName } from '../lib/environment.js';
import { ProfileManager } from '../lib/profiles.js';
import { renderBanner } from '../lib/banner.js';
import { generateShellHook, setBackgroundTint, setTabTitle, setStatusBar, resetBackground, resetStatusBar, shouldApplyEffect } from '../lib/terminal.js';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('Manage environments (dev, staging, prod)');

  // --- list -----------------------------------------------------------

  env
    .command('list')
    .description('List environments and mark the active one')
    .action(() => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const envs = config.environments || [];
      const envManager = new EnvironmentManager(configManager.configDir);
      const activeName = envManager.resolve(program.opts().env);

      if (envs.length === 0) {
        console.log(chalk.dim('No environments defined.'));
        console.log(chalk.dim('Run "configsync env create <name>" to create one.'));
        return;
      }

      console.log(chalk.bold('Environments:\n'));
      for (const e of envs) {
        const isActive = e.name === activeName;
        const label = e.label || EnvironmentManager.tierLabel(e.tier, e.name);
        const color = e.color || EnvironmentManager.tierColor(e.tier);
        const protectBadge = e.protect ? chalk.red(' [protected]') : '';
        const activeBadge = isActive ? chalk.green(' ← active') : '';

        console.log(`  ${isActive ? chalk.green('●') : chalk.dim('○')} ${chalk.bold(e.name)} ${chalk.dim(`(${e.tier})`)}${protectBadge}${activeBadge}`);
        if (e.api_url) console.log(chalk.dim(`    API: ${e.api_url}`));
      }
    });

  // --- create ---------------------------------------------------------

  env
    .command('create <name>')
    .description('Create a new environment')
    .option('--tier <tier>', 'environment tier (development, staging, production, custom)', 'custom')
    .option('--color <hex>', 'color override (hex)')
    .option('--protect', 'require type-name confirmation for destructive ops')
    .option('--api-url <url>', 'per-env API URL')
    .action(async (name: string, options: { tier: string; color?: string; protect?: boolean; apiUrl?: string }) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      if (!config.environments) config.environments = [];

      if (config.environments.find(e => e.name === name)) {
        console.error(chalk.red(`Environment "${name}" already exists.`));
        process.exit(1);
      }

      if (!isValidEnvName(name)) {
        console.error(chalk.red('Invalid environment name. Use lowercase letters, numbers, hyphens, and underscores only.'));
        process.exit(1);
      }

      // If no tier specified interactively, prompt
      let tier = options.tier as EnvironmentDef['tier'];
      if (tier === 'custom' && !process.argv.includes('--tier')) {
        const answer = await ask('Tier (development/staging/production/custom) [custom]: ');
        if (answer) tier = answer as EnvironmentDef['tier'];
      }

      const envDef: EnvironmentDef = {
        name,
        tier,
        color: options.color || EnvironmentManager.tierColor(tier),
        protect: options.protect ?? tier === 'production',
      };

      if (options.apiUrl) envDef.api_url = options.apiUrl;

      config.environments.push(envDef);
      configManager.save(config);

      console.log(chalk.green(`Created environment "${name}" (${tier}).`));
      if (envDef.protect) {
        console.log(chalk.yellow('  Protection enabled — push/pull will require typing the env name.'));
      }
    });

  // --- activate -------------------------------------------------------

  env
    .command('activate <name>')
    .description('Persistently activate an environment')
    .action((name: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      if (!isValidEnvName(name)) {
        console.error(chalk.red('Invalid environment name. Use lowercase letters, numbers, hyphens, and underscores only.'));
        process.exit(1);
      }

      const config = configManager.load();
      const envDef = (config.environments || []).find(e => e.name === name);
      if (!envDef) {
        console.error(chalk.red(`Environment "${name}" not found.`));
        const names = (config.environments || []).map(e => e.name);
        if (names.length > 0) console.log(chalk.dim(`  Available: ${names.join(', ')}`));
        process.exit(1);
      }

      const envManager = new EnvironmentManager(configManager.configDir);
      envManager.activate(envDef);

      console.log(renderBanner(envDef));
      console.log(chalk.green(`\nEnvironment "${name}" activated.`));

      // Apply terminal effects if configured
      const effects = config.terminal_effects || {};
      if (effects.background && shouldApplyEffect('background')) {
        process.stdout.write(setBackgroundTint(envDef.tier));
      }
      if (effects.status_bar && shouldApplyEffect('status_bar')) {
        const label = envDef.label || EnvironmentManager.tierLabel(envDef.tier, name);
        process.stdout.write(setStatusBar(` ■ ${label} | ${os.hostname()}`, envDef.tier));
      }

      process.stdout.write(setTabTitle(`[${EnvironmentManager.tierLabel(envDef.tier, name)}] ${os.hostname()}`));
    });

  // --- deactivate -----------------------------------------------------

  env
    .command('deactivate')
    .description('Clear the active environment')
    .action(() => {
      const configManager = new ConfigManager();
      const envManager = new EnvironmentManager(configManager.configDir);
      envManager.deactivate();

      // Reset terminal effects
      process.stdout.write(resetBackground());
      process.stdout.write(resetStatusBar());
      process.stdout.write(setTabTitle(os.hostname()));

      console.log(chalk.green('Environment deactivated.'));
    });

  // --- current --------------------------------------------------------

  env
    .command('current')
    .description('Show the currently active environment')
    .action(() => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const envManager = new EnvironmentManager(configManager.configDir);
      const active = envManager.getActive(config, program.opts().env);

      if (!active) {
        console.log(chalk.dim('No environment active.'));
        return;
      }

      console.log(renderBanner(active));
    });

  // --- shell ----------------------------------------------------------

  env
    .command('shell <name>')
    .description('Spawn a subshell with an environment activated (resets on exit)')
    .action((name: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const envDef = (config.environments || []).find(e => e.name === name);
      if (!envDef) {
        console.error(chalk.red(`Environment "${name}" not found.`));
        process.exit(1);
      }

      const label = envDef.label || EnvironmentManager.tierLabel(envDef.tier, name);
      console.log(renderBanner(envDef));
      console.log(chalk.dim(`\nSpawning subshell with ${name} active. Type "exit" to return.\n`));

      const shell = process.env.SHELL || '/bin/sh';
      try {
        execSync(shell, {
          stdio: 'inherit',
          env: {
            ...process.env,
            CONFIGSYNC_ENV: name,
            CONFIGSYNC_ENV_TIER: envDef.tier,
          },
        });
      } catch {
        // Shell exited — that's normal
      }

      console.log(chalk.dim('\nExited environment subshell.'));
    });

  // --- hook -----------------------------------------------------------

  env
    .command('hook <shell>')
    .description('Print shell hook code for prompt integration')
    .action((shell: string) => {
      const validShells = ['bash', 'zsh', 'fish'];
      if (!validShells.includes(shell)) {
        console.error(chalk.red(`Unsupported shell: ${shell}. Use one of: ${validShells.join(', ')}`));
        process.exit(1);
      }

      console.log(generateShellHook(shell as 'bash' | 'zsh' | 'fish'));

      const addTo: Record<string, string> = {
        zsh: '~/.zshrc',
        bash: '~/.bashrc',
        fish: '~/.config/fish/conf.d/configsync.fish',
      };
      console.error(chalk.dim(`\n# Add to your ${addTo[shell]}:`));
      console.error(chalk.dim(`#   eval "$(configsync env hook ${shell})"`));
    });

  // --- delete ---------------------------------------------------------

  env
    .command('delete <name>')
    .description('Delete an environment definition')
    .action(async (name: string) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();
      const envs = config.environments || [];
      const idx = envs.findIndex(e => e.name === name);

      if (idx === -1) {
        console.error(chalk.red(`Environment "${name}" not found.`));
        process.exit(1);
      }

      const envDef = envs[idx];
      if (envDef.protect) {
        const answer = await ask(chalk.yellow(`"${name}" is protected. Type the name to confirm deletion: `));
        if (answer !== name) {
          console.log(chalk.dim('Cancelled.'));
          return;
        }
      }

      envs.splice(idx, 1);
      configManager.save(config);

      // Deactivate if this was the active env
      const envManager = new EnvironmentManager(configManager.configDir);
      if (envManager.resolve() === name) {
        envManager.deactivate();
      }

      console.log(chalk.green(`Deleted environment "${name}".`));
    });

  // --- vars -----------------------------------------------------------

  env
    .command('vars')
    .description('Output export statements for the current project/environment')
    .option('--for-shell', 'output in shell-eval-friendly format')
    .action((options: { forShell?: boolean }) => {
      const configManager = new ConfigManager();
      if (!configManager.exists()) {
        if (!options.forShell) {
          console.error(chalk.red("Error: Run 'configsync init' first."));
        }
        process.exit(options.forShell ? 0 : 1);
      }

      const injectDir = path.join(configManager.configDir, 'env_inject');
      if (!fs.existsSync(injectDir)) {
        if (!options.forShell) {
          console.log(chalk.dim('No injected env vars found. Run "configsync pull" with inject_as_env projects first.'));
        }
        return;
      }

      const cwd = process.cwd();
      const files = fs.readdirSync(injectDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(injectDir, file), 'utf-8'));
          const projectPath = data.project_path?.replace(/^~/, os.homedir());
          if (!projectPath || !cwd.startsWith(path.resolve(projectPath))) continue;

          const vars = data.vars || {};

          // Apply profile env_overrides
          let mergedVars = vars;
          try {
            const config = configManager.load();
            const profileManager = new ProfileManager(configManager.configDir);
            const activeProfile = profileManager.getActive(config, program.opts().profile);
            mergedVars = activeProfile?.env_overrides
              ? { ...vars, ...activeProfile.env_overrides }
              : vars;
          } catch {
            // Config may not be loadable in --for-shell path; fall back to base vars
          }

          for (const [key, value] of Object.entries(mergedVars)) {
            if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)) continue;
            console.log(`export ${key}=${JSON.stringify(value)}`);
          }
          return;
        } catch {
          // Skip malformed files
        }
      }

      if (!options.forShell) {
        console.log(chalk.dim('No matching project env vars for current directory.'));
      }
    });
}
