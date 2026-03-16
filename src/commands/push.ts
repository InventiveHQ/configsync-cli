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
import { EnvironmentManager } from '../lib/environment.js';
import { requireConfirmation } from '../lib/safety.js';
import { renderBanner } from '../lib/banner.js';

function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

export function registerPushCommand(program: Command): void {
  program
    .command('push')
    .description('Push current state to sync backend')
    .option('-m, --message <msg>', 'message describing this snapshot')
    .option('-y, --yes', 'skip confirmation prompt')
    .option('--i-know-what-im-doing', 'override production safety (requires CONFIGSYNC_ALLOW_PROD_SKIP=1)')
    .action(async (options: { message?: string; yes?: boolean; iKnowWhatImDoing?: boolean }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      // Environment safety check
      const envManager = new EnvironmentManager(configManager.configDir);
      const activeEnv = envManager.getActive(config, program.opts().env);
      if (activeEnv) {
        console.log(renderBanner(activeEnv));
        const confirmed = await requireConfirmation(activeEnv, 'push', options);
        if (!confirmed) {
          process.exit(1);
        }
      }

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
          content = Buffer.from(cryptoManager.encrypt(content));

          capturedConfigs.push({
            source: item.source,
            content: content.toString('base64'),
            encrypted: true,
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
          content = Buffer.from(cryptoManager.encrypt(content));

          capturedEnvFiles.push({
            project_path: env.project_path,
            filename: env.filename || '.env.local',
            content: content.toString('base64'),
            encrypted: true,
          });
        }

        // Capture projects
        const capturedProjects: Record<string, any>[] = [];
        for (const project of config.projects || []) {
          const projectPath = resolveHome(project.path);
          const capturedProject: Record<string, any> = {
            name: project.name,
            path: project.path,
            repo: project.repo || null,
            secrets: [],
            configs: [],
          };

          // Capture project secrets (encrypted)
          for (const secretName of project.secrets) {
            const secretPath = path.join(projectPath, secretName);
            if (!fs.existsSync(secretPath)) continue;
            let content: Buffer = Buffer.from(fs.readFileSync(secretPath));
            content = Buffer.from(cryptoManager.encrypt(content));
            capturedProject.secrets.push({
              filename: secretName,
              content: content.toString('base64'),
              encrypted: true,
            });
          }

          // Capture project configs (all encrypted)
          for (const configName of project.configs) {
            const configPath = path.join(projectPath, configName);
            if (!fs.existsSync(configPath)) continue;
            let content: Buffer = Buffer.from(fs.readFileSync(configPath));
            content = Buffer.from(cryptoManager.encrypt(content));
            capturedProject.configs.push({
              filename: configName,
              content: content.toString('base64'),
              encrypted: true,
            });
          }

          // Capture repo state if exists
          if (project.repo && fs.existsSync(path.join(projectPath, '.git'))) {
            try {
              capturedProject.repo.current_branch = execSync('git branch --show-current', {
                cwd: projectPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
              }).trim();
              capturedProject.repo.commit = execSync('git rev-parse HEAD', {
                cwd: projectPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
              }).trim();
            } catch {}
          }

          capturedProjects.push(capturedProject);
        }

        // Capture groups (each group contains multiple projects)
        const capturedGroups: Record<string, any>[] = [];
        for (const group of config.groups || []) {
          const capturedGroup: Record<string, any> = {
            name: group.name,
            path: group.path,
            projects: [],
          };

          for (const project of group.projects) {
            const projectPath = resolveHome(project.path);
            const cp: Record<string, any> = {
              name: project.name,
              path: project.path,
              repo: project.repo || null,
              secrets: [],
              configs: [],
            };

            for (const secretName of project.secrets) {
              const secretPath = path.join(projectPath, secretName);
              if (!fs.existsSync(secretPath)) continue;
              let content: Buffer = Buffer.from(fs.readFileSync(secretPath));
              content = Buffer.from(cryptoManager.encrypt(content));
              cp.secrets.push({ filename: secretName, content: content.toString('base64'), encrypted: true });
            }

            for (const configName of project.configs) {
              const configPath = path.join(projectPath, configName);
              if (!fs.existsSync(configPath)) continue;
              cp.configs.push({ filename: configName, content: Buffer.from(cryptoManager.encrypt(Buffer.from(fs.readFileSync(configPath)))).toString('base64'), encrypted: true });
            }

            if (project.repo && fs.existsSync(path.join(projectPath, '.git'))) {
              try {
                cp.repo.current_branch = execSync('git branch --show-current', { cwd: projectPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                cp.repo.commit = execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
              } catch {}
            }

            capturedGroup.projects.push(cp);
          }

          capturedGroups.push(capturedGroup);
        }

        // Capture modules
        const capturedModules: Record<string, any>[] = [];
        for (const mod of config.modules || []) {
          const capturedMod: Record<string, any> = {
            name: mod.name,
            files: [],
            extras: mod.extras || null,
          };

          for (const file of mod.files) {
            const filePath = file.path.replace(/^~/, os.homedir());
            const resolvedPath = path.resolve(filePath);
            if (!fs.existsSync(resolvedPath)) continue;
            if (!fs.statSync(resolvedPath).isFile()) continue;

            let content: Buffer = Buffer.from(fs.readFileSync(resolvedPath));
            content = Buffer.from(cryptoManager.encrypt(content));

            capturedMod.files.push({
              path: file.path,
              content: content.toString('base64'),
              encrypted: true,
            });
          }

          capturedModules.push(capturedMod);
        }

        // Capture tracked env vars
        const capturedEnvVars: Record<string, string> = {};
        for (const varName of config.env_vars || []) {
          const value = process.env[varName];
          if (value !== undefined) {
            capturedEnvVars[varName] = value;
          }
        }

        // Environment-scoped secrets
        const activeEnvName = activeEnv?.name || envManager.resolve(program.opts().env);
        const envFilesByEnvironment: Record<string, any[]> = {};
        if (activeEnvName) {
          envFilesByEnvironment[activeEnvName] = capturedEnvFiles;
        }

        const state: Record<string, any> = {
          timestamp: new Date().toISOString(),
          message: options.message || '',
          active_environment: activeEnvName || null,
          configs: capturedConfigs,
          repos: capturedRepos,
          env_files: activeEnvName ? [] : capturedEnvFiles,
          env_files_by_environment: envFilesByEnvironment,
          packages: config.packages || [],
          projects: capturedProjects,
          groups: capturedGroups,
          modules: capturedModules,
          env_vars: capturedEnvVars,
          machine_vars: config.machine || null,
        };

        const metadata = {
          timestamp: state.timestamp,
          configs: capturedConfigs.map((c: any) => ({ source: c.source, encrypted: !!c.encrypted })),
          repos: capturedRepos.map((r: any) => ({ url: r.url, path: r.path, branch: r.branch || r.current_branch })),
          env_files: capturedEnvFiles.map((e: any) => ({ project_path: e.project_path, filename: e.filename })),
          packages: (config.packages || []).map((p: any) => ({
            manager: p.manager,
            displayName: p.displayName,
            count: p.packages.length,
            items: p.packages,
          })),
          projects: (config.projects || []).map((p: any) => ({
            name: p.name,
            path: p.path,
            repo: p.repo || null,
            secrets: p.secrets,
            configs: p.configs,
          })),
          groups: (config.groups || []).map((g: any) => ({
            name: g.name,
            path: g.path,
            projects: g.projects.map((p: any) => ({
              name: p.name,
              path: p.path,
              repo: p.repo || null,
              secrets: p.secrets,
              configs: p.configs,
            })),
          })),
          modules: (config.modules || []).map((m: any) => ({
            name: m.name,
            files: m.files.map((f: any) => ({ path: f.path, encrypt: f.encrypt })),
            extras: m.extras || null,
          })),
          environments: (config.environments || []).map((e: any) => ({
            name: e.name,
            tier: e.tier,
            label: e.label || null,
            color: e.color || null,
            api_url: e.api_url || null,
            protect: !!e.protect,
          })),
          env_vars: Object.keys(capturedEnvVars),
          machine_vars: config.machine || null,
          active_environment: activeEnvName || null,
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
          await backend.push(state, cryptoManager, metadata);

          // Sync environments: push local → cloud, merge cloud-only back to local
          if (config.environments && config.environments.length > 0) {
            const merged = await backend.syncEnvironments(
              config.environments.map(e => ({
                name: e.name,
                tier: e.tier,
                color: e.color || null,
                protect: !!e.protect,
              }))
            );
            // Merge cloud-only environments back into local config
            const localNames = new Set((config.environments || []).map(e => e.name));
            let newFromCloud = 0;
            for (const cloudEnv of merged) {
              if (!localNames.has(cloudEnv.name)) {
                config.environments.push({
                  name: cloudEnv.name,
                  tier: cloudEnv.tier,
                  color: cloudEnv.color,
                  protect: !!cloudEnv.protect,
                });
                newFromCloud++;
              }
            }
            if (newFromCloud > 0) {
              configManager.save(config);
            }
          }
        } else {
          const stateFile = path.join(configManager.stateDir, 'state.json');
          fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        }

        const parts = [
          `${capturedConfigs.length} config${capturedConfigs.length !== 1 ? 's' : ''}`,
          `${capturedRepos.length} repo${capturedRepos.length !== 1 ? 's' : ''}`,
          `${capturedEnvFiles.length} env file${capturedEnvFiles.length !== 1 ? 's' : ''}`,
          `${capturedProjects.length} project${capturedProjects.length !== 1 ? 's' : ''}`,
          `${capturedGroups.length} group${capturedGroups.length !== 1 ? 's' : ''}`,
          `${capturedModules.length} module${capturedModules.length !== 1 ? 's' : ''}`,
        ].filter(p => !p.startsWith('0'));

        spinner.succeed(`State pushed! (${parts.join(', ')})`);
      } catch (err: any) {
        spinner.fail(`Push failed: ${err.message}`);
        process.exit(1);
      }
    });
}
