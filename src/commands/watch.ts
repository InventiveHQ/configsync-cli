import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import { promptPassword } from '../lib/prompt.js';
import { EnvironmentManager } from '../lib/environment.js';
import { performPush } from './push.js';
import { parseFilters, shouldInclude } from '../lib/filter.js';

function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch tracked files and auto-push on changes')
    .option('--debounce <ms>', 'debounce delay in milliseconds', '5000')
    .option('--filter <filters...>', 'only watch specific items')
    .option('-m, --message <msg>', 'message for auto-pushed snapshots')
    .action(async (options: { debounce: string; filter?: string[]; message?: string }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      const password = await promptPassword('Enter master password: ');
      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.unlock(password);

      const envManager = new EnvironmentManager(configManager.configDir);
      const debounceMs = parseInt(options.debounce, 10) || 5000;
      const filters = parseFilters(options.filter || []);

      // Collect all tracked file paths
      const watchPaths: string[] = [];

      if (shouldInclude('configs', undefined, filters)) {
        for (const item of config.configs || []) {
          const p = resolveHome(item.source);
          if (fs.existsSync(p)) watchPaths.push(p);
        }
      }

      if (shouldInclude('env_files', undefined, filters)) {
        for (const env of config.env_files || []) {
          const p = path.join(resolveHome(env.project_path), env.filename || '.env.local');
          if (fs.existsSync(p)) watchPaths.push(p);
        }
      }

      if (shouldInclude('modules', undefined, filters)) {
        for (const mod of config.modules || []) {
          for (const file of mod.files || []) {
            const p = resolveHome(file.path);
            if (fs.existsSync(p)) watchPaths.push(p);
          }
        }
      }

      if (shouldInclude('projects', undefined, filters)) {
        for (const project of config.projects || []) {
          const projectPath = resolveHome(project.path);
          for (const s of project.secrets || []) {
            const p = path.join(projectPath, s);
            if (fs.existsSync(p)) watchPaths.push(p);
          }
          for (const c of project.configs || []) {
            const p = path.join(projectPath, c);
            if (fs.existsSync(p)) watchPaths.push(p);
          }
        }
      }

      if (shouldInclude('groups', undefined, filters)) {
        for (const group of config.groups || []) {
          for (const project of group.projects || []) {
            const projectPath = resolveHome(project.path);
            for (const s of project.secrets || []) {
              const p = path.join(projectPath, s);
              if (fs.existsSync(p)) watchPaths.push(p);
            }
            for (const c of project.configs || []) {
              const p = path.join(projectPath, c);
              if (fs.existsSync(p)) watchPaths.push(p);
            }
          }
        }
      }

      if (watchPaths.length === 0) {
        console.error(chalk.red('No files to watch.'));
        process.exit(1);
      }

      // Deduplicate
      const uniquePaths = [...new Set(watchPaths)];

      console.log(chalk.bold(`Watching ${uniquePaths.length} file${uniquePaths.length !== 1 ? 's' : ''} for changes...`));
      console.log(chalk.dim(`  Debounce: ${debounceMs}ms`));
      console.log(chalk.dim('  Press Ctrl+C to stop.\n'));

      let debounceTimer: NodeJS.Timeout | null = null;
      let pushing = false;
      let lastPush = '';
      const watchers: fs.FSWatcher[] = [];

      async function doPush(): Promise<void> {
        if (pushing) return;
        pushing = true;

        try {
          const freshConfig = configManager.load();
          const stats = await performPush(
            freshConfig,
            configManager,
            cryptoManager,
            envManager,
            program,
            {
              message: options.message || `auto-push from watch`,
              filter: options.filter,
              changed: true,  // Only push what changed
            },
          );

          lastPush = new Date().toLocaleTimeString();
          const parts = [
            stats.configs && `${stats.configs} configs`,
            stats.repos && `${stats.repos} repos`,
            stats.envFiles && `${stats.envFiles} env files`,
            stats.projects && `${stats.projects} projects`,
            stats.groups && `${stats.groups} groups`,
            stats.modules && `${stats.modules} modules`,
          ].filter(Boolean);

          console.log(chalk.green(`  [${lastPush}] Pushed: ${parts.join(', ') || 'no changes'}`));
        } catch (err: any) {
          console.error(chalk.red(`  [${new Date().toLocaleTimeString()}] Push failed: ${err.message}`));
        } finally {
          pushing = false;
        }
      }

      function onFileChange(filename: string | null): void {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log(chalk.dim(`  Change detected${filename ? `: ${filename}` : ''}...`));
          doPush();
        }, debounceMs);
      }

      // Set up watchers
      for (const filePath of uniquePaths) {
        try {
          const watcher = fs.watch(filePath, (event, filename) => {
            onFileChange(filename || path.basename(filePath));
          });
          watchers.push(watcher);
        } catch {
          // File may have been deleted between check and watch
        }
      }

      // Graceful shutdown
      const cleanup = (): void => {
        console.log(chalk.dim('\n  Stopping watchers...'));
        if (debounceTimer) clearTimeout(debounceTimer);
        for (const w of watchers) {
          try { w.close(); } catch {}
        }
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    });
}
