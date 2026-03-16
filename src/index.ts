import { Command } from 'commander';
import { registerCommands } from './commands/index.js';
import { ConfigManager } from './lib/config.js';
import { EnvironmentManager } from './lib/environment.js';
import { renderBanner } from './lib/banner.js';
import { setBackgroundTint, setTabTitle, setStatusBar, shouldApplyEffect } from './lib/terminal.js';
import os from 'node:os';

const program = new Command();
program
  .name('configsync')
  .description('ConfigSync - Sync your development environment across machines')
  .version('0.1.0')
  .option('--env <name>', 'set active environment for this command');

// Display environment banner before every command
program.hook('preAction', () => {
  try {
    const configManager = new ConfigManager();
    if (!configManager.exists()) return;

    const config = configManager.load();
    const envManager = new EnvironmentManager(configManager.configDir);
    const activeEnv = envManager.getActive(config, program.opts().env);

    if (activeEnv) {
      console.log(renderBanner(activeEnv));

      // Apply terminal effects if configured
      const effects = config.terminal_effects || {};
      if (effects.background && shouldApplyEffect('background')) {
        process.stdout.write(setBackgroundTint(activeEnv.tier));
      }
      if (effects.status_bar && shouldApplyEffect('status_bar')) {
        const label = activeEnv.label || EnvironmentManager.tierLabel(activeEnv.tier, activeEnv.name);
        process.stdout.write(setStatusBar(` ■ ${label} | ${os.hostname()}`, activeEnv.tier));
      }

      process.stdout.write(setTabTitle(`[${EnvironmentManager.tierLabel(activeEnv.tier, activeEnv.name)}] ${os.hostname()}`));
    }
  } catch {
    // Banner rendering is non-critical — don't block commands
  }
});

registerCommands(program);
program.parse();
