import { Command } from 'commander';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
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
import { HashCacheManager, mergeWithPrevious, type HashCache } from '../lib/hash-cache.js';
import { parseFilters, shouldInclude, type Filter } from '../lib/filter.js';

function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

// --- Capture functions (extracted for parallelism) ---

function encryptFile(
  filePath: string,
  sourceKey: string,
  cryptoManager: CryptoManager,
  cache: HashCache,
  hashCacheManager: HashCacheManager,
  noCache: boolean,
): { content: string; encrypted: true } {
  if (!noCache) {
    const result = hashCacheManager.check(filePath, sourceKey, cache);
    if (!result.changed && result.cachedContent) {
      return { content: result.cachedContent, encrypted: true };
    }
    // Changed or no cache entry — encrypt and update cache
    const raw = fs.readFileSync(filePath);
    const encrypted = Buffer.from(cryptoManager.encrypt(raw));
    const base64 = encrypted.toString('base64');
    hashCacheManager.update(cache, sourceKey, result.sha256, result.size, result.mtime, base64);
    return { content: base64, encrypted: true };
  }
  // No cache mode — always encrypt
  const raw = fs.readFileSync(filePath);
  const encrypted = Buffer.from(cryptoManager.encrypt(raw));
  return { content: encrypted.toString('base64'), encrypted: true };
}

async function captureConfigs(
  configs: any[],
  cryptoManager: CryptoManager,
  cache: HashCache,
  hashCacheManager: HashCacheManager,
  noCache: boolean,
): Promise<Record<string, any>[]> {
  const results: Record<string, any>[] = [];
  for (const item of configs) {
    const resolvedPath = resolveHome(item.source);
    if (!fs.existsSync(resolvedPath)) continue;
    if (!fs.statSync(resolvedPath).isFile()) continue;

    const { content, encrypted } = encryptFile(resolvedPath, `config:${item.source}`, cryptoManager, cache, hashCacheManager, noCache);
    results.push({ source: item.source, content, encrypted });
  }
  return results;
}

async function captureRepos(repos: any[]): Promise<Record<string, any>[]> {
  const results: Record<string, any>[] = [];
  for (const repo of repos) {
    const repoPath = resolveHome(repo.path);
    const repoState: Record<string, any> = {
      url: repo.url,
      path: repo.path,
      branch: repo.branch || 'main',
      auto_pull: repo.auto_pull !== false,
    };

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

    results.push(repoState);
  }
  return results;
}

async function captureEnvFiles(
  envFiles: any[],
  cryptoManager: CryptoManager,
  cache: HashCache,
  hashCacheManager: HashCacheManager,
  noCache: boolean,
): Promise<Record<string, any>[]> {
  const results: Record<string, any>[] = [];
  for (const env of envFiles) {
    const envPath = path.join(resolveHome(env.project_path), env.filename || '.env.local');
    if (!fs.existsSync(envPath)) continue;

    const sourceKey = `env:${env.project_path}/${env.filename || '.env.local'}`;
    const { content, encrypted } = encryptFile(envPath, sourceKey, cryptoManager, cache, hashCacheManager, noCache);
    results.push({
      project_path: env.project_path,
      filename: env.filename || '.env.local',
      content,
      encrypted,
    });
  }
  return results;
}

function captureProjectFiles(
  project: any,
  cryptoManager: CryptoManager,
  cache: HashCache,
  hashCacheManager: HashCacheManager,
  noCache: boolean,
): Record<string, any> {
  const projectPath = resolveHome(project.path);
  const capturedProject: Record<string, any> = {
    name: project.name,
    path: project.path,
    repo: project.repo || null,
    secrets: [],
    configs: [],
  };

  for (const secretName of project.secrets) {
    const secretPath = path.join(projectPath, secretName);
    if (!fs.existsSync(secretPath)) continue;
    const sourceKey = `project:${project.name}:secret:${secretName}`;
    const { content, encrypted } = encryptFile(secretPath, sourceKey, cryptoManager, cache, hashCacheManager, noCache);
    capturedProject.secrets.push({ filename: secretName, content, encrypted });
  }

  for (const configName of project.configs) {
    const configPath = path.join(projectPath, configName);
    if (!fs.existsSync(configPath)) continue;
    const sourceKey = `project:${project.name}:config:${configName}`;
    const { content, encrypted } = encryptFile(configPath, sourceKey, cryptoManager, cache, hashCacheManager, noCache);
    capturedProject.configs.push({ filename: configName, content, encrypted });
  }

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

  return capturedProject;
}

async function captureProjects(
  projects: any[],
  cryptoManager: CryptoManager,
  cache: HashCache,
  hashCacheManager: HashCacheManager,
  noCache: boolean,
): Promise<Record<string, any>[]> {
  return projects.map(p => captureProjectFiles(p, cryptoManager, cache, hashCacheManager, noCache));
}

async function captureGroups(
  groups: any[],
  cryptoManager: CryptoManager,
  cache: HashCache,
  hashCacheManager: HashCacheManager,
  noCache: boolean,
): Promise<Record<string, any>[]> {
  return groups.map(group => ({
    name: group.name,
    path: group.path,
    projects: group.projects.map((p: any) => captureProjectFiles(p, cryptoManager, cache, hashCacheManager, noCache)),
  }));
}

async function captureModules(
  modules: any[],
  cryptoManager: CryptoManager,
  cache: HashCache,
  hashCacheManager: HashCacheManager,
  noCache: boolean,
): Promise<Record<string, any>[]> {
  const results: Record<string, any>[] = [];
  for (const mod of modules) {
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

      const sourceKey = `module:${mod.name}:${file.path}`;
      const { content, encrypted } = encryptFile(resolvedPath, sourceKey, cryptoManager, cache, hashCacheManager, noCache);
      capturedMod.files.push({ path: file.path, content, encrypted });
    }

    results.push(capturedMod);
  }
  return results;
}

function captureEnvVars(envVarNames: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const varName of envVarNames) {
    const value = process.env[varName];
    if (value !== undefined) {
      result[varName] = value;
    }
  }
  return result;
}

// --- Core push logic (exported for watch mode) ---

export interface PushOptions {
  message?: string;
  yes?: boolean;
  noDelete?: boolean;
  iKnowWhatImDoing?: boolean;
  noCache?: boolean;
  filter?: string[];
  changed?: boolean;
}

export interface PushStats {
  configs: number;
  repos: number;
  envFiles: number;
  projects: number;
  groups: number;
  modules: number;
}

export async function performPush(
  config: any,
  configManager: ConfigManager,
  cryptoManager: CryptoManager,
  envManager: EnvironmentManager,
  program: Command,
  options: PushOptions,
  spinner?: Ora,
): Promise<PushStats> {
  const hashCacheManager = new HashCacheManager(configManager.stateDir);
  const cache = hashCacheManager.load();
  const noCache = !!options.noCache;
  const filters = parseFilters(options.filter || []);

  // Parallel capture of independent sections
  const [capturedConfigs, capturedEnvFiles, capturedModules] = await Promise.all([
    shouldInclude('configs', undefined, filters)
      ? captureConfigs(config.configs, cryptoManager, cache, hashCacheManager, noCache)
      : Promise.resolve([]),
    shouldInclude('env_files', undefined, filters)
      ? captureEnvFiles(config.env_files, cryptoManager, cache, hashCacheManager, noCache)
      : Promise.resolve([]),
    shouldInclude('modules', undefined, filters)
      ? captureModules(config.modules || [], cryptoManager, cache, hashCacheManager, noCache)
      : Promise.resolve([]),
  ]);

  // Repos use execSync (blocking) — run after parallel batch
  const capturedRepos = shouldInclude('repos', undefined, filters)
    ? await captureRepos(config.repos)
    : [];

  // Projects and groups can run in parallel with each other
  const [capturedProjects, capturedGroups] = await Promise.all([
    shouldInclude('projects', undefined, filters)
      ? captureProjects(config.projects || [], cryptoManager, cache, hashCacheManager, noCache)
      : Promise.resolve([]),
    shouldInclude('groups', undefined, filters)
      ? captureGroups(config.groups || [], cryptoManager, cache, hashCacheManager, noCache)
      : Promise.resolve([]),
  ]);

  const capturedEnvVars = captureEnvVars(config.env_vars || []);

  // Environment-scoped secrets
  const activeEnv = envManager.getActive(config, program.opts().env);
  const activeEnvName = activeEnv?.name || envManager.resolve(program.opts().env);
  const envFilesByEnvironment: Record<string, any[]> = {};
  if (activeEnvName) {
    envFilesByEnvironment[activeEnvName] = capturedEnvFiles;
  }

  let state: Record<string, any> = {
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
    profiles: config.profiles || [],
  };

  // --changed: merge with previous state for unchanged items
  if (options.changed) {
    let previousState: Record<string, any> | null = null;
    if (config.sync.backend === 'cloud') {
      const apiUrl = config.sync.config.api_url;
      const apiKey = config.sync.config.api_key;
      if (apiUrl && apiKey) {
        const backend = new CloudBackend(apiUrl, apiKey);
        previousState = await backend.pull(cryptoManager);
      }
    } else {
      const stateFile = path.join(configManager.stateDir, 'state.json');
      if (fs.existsSync(stateFile)) {
        previousState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      }
    }
    if (previousState) {
      state.configs = mergeWithPrevious(capturedConfigs, previousState.configs || [], 'source');
      state.repos = mergeWithPrevious(capturedRepos, previousState.repos || [], 'path');
      state.env_files = mergeWithPrevious(
        activeEnvName ? [] : capturedEnvFiles,
        previousState.env_files || [],
        'project_path',
      );
      state.modules = mergeWithPrevious(capturedModules, previousState.modules || [], 'name');
      state.projects = mergeWithPrevious(capturedProjects, previousState.projects || [], 'name');
      state.groups = mergeWithPrevious(capturedGroups, previousState.groups || [], 'name');
    }
  }

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
    profiles: (config.profiles || []).map((p: any) => ({
      name: p.name,
      environment: p.environment || null,
      paths: p.paths || [],
      vars: p.vars || {},
      env_overrides: p.env_overrides ? Object.keys(p.env_overrides).reduce((acc: Record<string, string>, k: string) => { acc[k] = '***'; return acc; }, {}) : {},
      description: p.description || null,
    })),
  };

  if (config.sync.backend === 'cloud') {
    const apiUrl = config.sync.config.api_url;
    const apiKey = config.sync.config.api_key;

    if (!apiUrl || !apiKey) {
      throw new Error('Cloud backend not configured. Run "configsync login" first.');
    }

    const backend = new CloudBackend(apiUrl, apiKey);
    await backend.registerMachine();
    await backend.push(state, cryptoManager, metadata);

    // Sync environments: push local → cloud, merge cloud-only back to local
    if (config.environments && config.environments.length > 0) {
      const merged = await backend.syncEnvironments(
        config.environments.map((e: any) => ({
          name: e.name,
          tier: e.tier,
          color: e.color || null,
          protect: !!e.protect,
        })),
        { deleteCloudOnly: !options.noDelete },
      );
      const localNames = new Set((config.environments || []).map((e: any) => e.name));
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

  // Save hash cache after successful push
  hashCacheManager.save(cache);

  return {
    configs: capturedConfigs.length,
    repos: capturedRepos.length,
    envFiles: capturedEnvFiles.length,
    projects: capturedProjects.length,
    groups: capturedGroups.length,
    modules: capturedModules.length,
  };
}

// --- Command registration ---

export function registerPushCommand(program: Command): void {
  program
    .command('push')
    .description('Push current state to sync backend')
    .option('-m, --message <msg>', 'message describing this snapshot')
    .option('-y, --yes', 'skip confirmation prompt')
    .option('--no-delete', 'push local additions without removing cloud-only environments')
    .option('--no-cache', 'skip hash cache and re-encrypt all files')
    .option('--filter <filters...>', 'only push specific items (e.g. modules:ssh,configs)')
    .option('--changed', 'only push items changed since last push')
    .option('--i-know-what-im-doing', 'override production safety (requires CONFIGSYNC_ALLOW_PROD_SKIP=1)')
    .action(async (options: PushOptions) => {
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
        const stats = await performPush(config, configManager, cryptoManager, envManager, program, options, spinner);

        const parts = [
          `${stats.configs} config${stats.configs !== 1 ? 's' : ''}`,
          `${stats.repos} repo${stats.repos !== 1 ? 's' : ''}`,
          `${stats.envFiles} env file${stats.envFiles !== 1 ? 's' : ''}`,
          `${stats.projects} project${stats.projects !== 1 ? 's' : ''}`,
          `${stats.groups} group${stats.groups !== 1 ? 's' : ''}`,
          `${stats.modules} module${stats.modules !== 1 ? 's' : ''}`,
        ].filter(p => !p.startsWith('0'));

        spinner.succeed(`State pushed! (${parts.join(', ')})`);
      } catch (err: any) {
        spinner.fail(`Push failed: ${err.message}`);
        process.exit(1);
      }
    });
}
