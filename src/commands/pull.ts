import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import CloudBackend from '../lib/cloud.js';
import { promptPassword } from '../lib/prompt.js';

function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

export function registerPullCommand(program: Command): void {
  program
    .command('pull')
    .description('Pull and restore state from sync backend')
    .option('--force', 'overwrite existing files without backup', false)
    .action(async (options: { force: boolean }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      const password = await promptPassword('Enter master password: ');
      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.unlock(password);

      const spinner = ora('Pulling state...').start();

      try {
        let state: Record<string, any> | null = null;

        if (config.sync.backend === 'cloud') {
          const apiUrl = config.sync.config.api_url;
          const apiKey = config.sync.config.api_key;

          if (!apiUrl || !apiKey) {
            spinner.fail('Cloud backend not configured. Run "configsync login" first.');
            process.exit(1);
          }

          const backend = new CloudBackend(apiUrl, apiKey);
          state = await backend.pull(cryptoManager);
        } else {
          const stateFile = path.join(configManager.stateDir, 'state.json');
          if (fs.existsSync(stateFile)) {
            state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          }
        }

        if (!state) {
          spinner.fail('No state found. Run "configsync push" first.');
          process.exit(1);
        }

        spinner.text = 'Restoring...';

        let configsRestored = 0;
        let reposCloned = 0;
        let reposUpdated = 0;
        let envsRestored = 0;
        const warnings: string[] = [];

        // Restore config files
        for (const entry of state.configs || []) {
          const resolvedPath = resolveHome(entry.source);

          if (fs.existsSync(resolvedPath) && !options.force) {
            const backupName = `${path.basename(resolvedPath)}.${Date.now()}.bak`;
            fs.copyFileSync(resolvedPath, path.join(configManager.backupDir, backupName));
          }

          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
          let content: Buffer = Buffer.from(entry.content, 'base64');
          if (entry.encrypted) {
            content = Buffer.from(cryptoManager.decrypt(content));
          }
          fs.writeFileSync(resolvedPath, content);
          configsRestored++;
        }

        // Restore repos (clone or update)
        for (const repo of state.repos || []) {
          const repoPath = resolveHome(repo.path);

          if (!fs.existsSync(repoPath)) {
            // Clone
            try {
              fs.mkdirSync(path.dirname(repoPath), { recursive: true });
              execSync(`git clone ${repo.url} ${repoPath}`, {
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 120000,
              });
              if (repo.branch && repo.branch !== 'main' && repo.branch !== 'master') {
                execSync(`git checkout ${repo.branch}`, {
                  cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'],
                });
              }
              reposCloned++;
            } catch (err: any) {
              warnings.push(`Failed to clone ${repo.url}: ${err.message}`);
            }
          } else if (repo.auto_pull !== false && fs.existsSync(path.join(repoPath, '.git'))) {
            // Pull latest
            try {
              execSync('git pull', {
                cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
              });
              reposUpdated++;
            } catch {
              warnings.push(`Failed to pull ${repoPath}`);
            }
          }

          if (repo.has_uncommitted) {
            warnings.push(`${repo.path} had uncommitted changes on source machine`);
          }
        }

        // Restore env files
        for (const env of state.env_files || []) {
          const envPath = path.join(resolveHome(env.project_path), env.filename || '.env.local');

          if (fs.existsSync(envPath) && !options.force) {
            const backupName = `${path.basename(envPath)}.${Date.now()}.bak`;
            fs.copyFileSync(envPath, path.join(configManager.backupDir, backupName));
          }

          fs.mkdirSync(path.dirname(envPath), { recursive: true });
          let content: Buffer = Buffer.from(env.content, 'base64');
          if (env.encrypted) {
            content = Buffer.from(cryptoManager.decrypt(content));
          }
          fs.writeFileSync(envPath, content, { mode: 0o600 });
          envsRestored++;
        }

        // Build summary
        const parts: string[] = [];
        if (configsRestored) parts.push(`${configsRestored} config${configsRestored !== 1 ? 's' : ''}`);
        if (reposCloned) parts.push(`${reposCloned} repo${reposCloned !== 1 ? 's' : ''} cloned`);
        if (reposUpdated) parts.push(`${reposUpdated} repo${reposUpdated !== 1 ? 's' : ''} updated`);
        if (envsRestored) parts.push(`${envsRestored} env file${envsRestored !== 1 ? 's' : ''}`);

        spinner.succeed(`Restored! (${parts.join(', ') || 'no changes'})`);

        if (state.timestamp) console.log(`  ${chalk.dim('Snapshot from:')} ${state.timestamp}`);
        if (state.message) console.log(`  ${chalk.dim('Message:')} ${state.message}`);

        // Show package info if available
        if (state.packages?.length) {
          const totalPkgs = state.packages.reduce((s: number, m: any) => s + m.packages.length, 0);
          console.log(`\n  ${chalk.dim('Packages:')} ${totalPkgs} packages from ${state.packages.length} manager(s)`);
          console.log(chalk.dim('  Run "configsync scan" to compare with this machine'));
        }

        if (warnings.length > 0) {
          console.log(chalk.yellow('\nWarnings:'));
          for (const w of warnings) console.log(chalk.yellow(`  - ${w}`));
        }
      } catch (err: any) {
        spinner.fail(`Pull failed: ${err.message}`);
        process.exit(1);
      }
    });
}
