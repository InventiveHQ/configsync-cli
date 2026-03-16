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

export function registerPushCommand(program: Command): void {
  program
    .command('push')
    .description('Push current state to sync backend')
    .option('-m, --message <msg>', 'message describing this snapshot')
    .action(async (options: { message?: string }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      const password = await promptPassword('Enter master password: ');
      const cryptoManager = new CryptoManager(configManager.configDir);
      cryptoManager.unlock(password);

      const spinner = ora('Pushing state...').start();

      try {
        // Capture config files
        const capturedConfigs: Record<string, any>[] = [];
        for (const item of config.configs) {
          const resolvedPath = resolveHome(item.source);
          if (!fs.existsSync(resolvedPath)) continue;
          if (!fs.statSync(resolvedPath).isFile()) continue;

          let content: Buffer = Buffer.from(fs.readFileSync(resolvedPath));
          if (item.encrypt) {
            content = Buffer.from(cryptoManager.encrypt(content));
          }

          capturedConfigs.push({
            source: item.source,
            content: content.toString('base64'),
            encrypted: !!item.encrypt,
          });
        }

        // Capture repo metadata (URL, branch, path — not the actual files)
        const capturedRepos: Record<string, any>[] = [];
        for (const repo of config.repos) {
          const repoPath = resolveHome(repo.path);
          const repoState: Record<string, any> = {
            url: repo.url,
            path: repo.path,
            branch: repo.branch || 'main',
            auto_pull: repo.auto_pull !== false,
          };

          // If the repo exists locally, capture current branch and commit
          if (fs.existsSync(path.join(repoPath, '.git'))) {
            try {
              repoState.current_branch = execSync('git branch --show-current', {
                cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
              }).trim();
              repoState.commit = execSync('git rev-parse HEAD', {
                cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
              }).trim();
              const status = execSync('git status --porcelain', {
                cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
              });
              repoState.has_uncommitted = status.trim().length > 0;
            } catch {
              // Git commands failed, just save the config
            }
          }

          capturedRepos.push(repoState);
        }

        // Capture env files (always encrypted)
        const capturedEnvFiles: Record<string, any>[] = [];
        for (const env of config.env_files) {
          const envPath = path.join(resolveHome(env.project_path), env.filename || '.env.local');
          if (!fs.existsSync(envPath)) continue;

          let content: Buffer = Buffer.from(fs.readFileSync(envPath));
          const shouldEncrypt = env.encrypt !== false;
          if (shouldEncrypt) {
            content = Buffer.from(cryptoManager.encrypt(content));
          }

          capturedEnvFiles.push({
            project_path: env.project_path,
            filename: env.filename || '.env.local',
            content: content.toString('base64'),
            encrypted: shouldEncrypt,
          });
        }

        const state: Record<string, any> = {
          timestamp: new Date().toISOString(),
          message: options.message || '',
          configs: capturedConfigs,
          repos: capturedRepos,
          env_files: capturedEnvFiles,
          packages: config.packages || [],
        };

        if (config.sync.backend === 'cloud') {
          const apiUrl = config.sync.config.api_url;
          const apiKey = config.sync.config.api_key;

          if (!apiUrl || !apiKey) {
            spinner.fail('Cloud backend not configured. Run "configsync login" first.');
            process.exit(1);
          }

          const backend = new CloudBackend(apiUrl, apiKey);
          await backend.registerMachine();
          await backend.push(state, cryptoManager);
        } else {
          const stateFile = path.join(configManager.stateDir, 'state.json');
          fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        }

        const parts = [
          `${capturedConfigs.length} config${capturedConfigs.length !== 1 ? 's' : ''}`,
          `${capturedRepos.length} repo${capturedRepos.length !== 1 ? 's' : ''}`,
          `${capturedEnvFiles.length} env file${capturedEnvFiles.length !== 1 ? 's' : ''}`,
        ].filter(p => !p.startsWith('0'));

        spinner.succeed(`State pushed! (${parts.join(', ')})`);
      } catch (err: any) {
        spinner.fail(`Push failed: ${err.message}`);
        process.exit(1);
      }
    });
}
