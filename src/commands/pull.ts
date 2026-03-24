import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import CloudBackend from '../lib/cloud.js';
import { promptPassword } from '../lib/prompt.js';
import { EnvironmentManager } from '../lib/environment.js';
import { requireConfirmation } from '../lib/safety.js';
import { renderBanner } from '../lib/banner.js';
import { renderTemplate, buildContext } from '../lib/template.js';
import { ProfileManager } from '../lib/profiles.js';
import { scanPackages, scanPackagesAsync } from '../lib/packages.js';
import { diffPackages, formatDiff } from '../lib/package-diff.js';
import { loadMappings } from '../lib/package-mappings.js';
import { parseFilters, shouldInclude, isFilterActive, type Filter } from '../lib/filter.js';
import { getRestoreLevels } from '../lib/dependency-graph.js';

function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

function cloneOrPullRepo(
  repo: { url: string; branch?: string },
  repoPath: string,
  stats: { cloned: number; updated: number },
  warnings: string[],
): void {
  if (!fs.existsSync(repoPath)) {
    try {
      fs.mkdirSync(path.dirname(repoPath), { recursive: true });
      execFileSync('git', ['clone', repo.url, repoPath], {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000,
      });
      if (repo.branch && repo.branch !== 'main' && repo.branch !== 'master') {
        execFileSync('git', ['checkout', repo.branch!], {
          cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
      stats.cloned++;
    } catch (err: any) {
      warnings.push(`Failed to clone ${repo.url}: ${err.message}`);
    }
  } else if (fs.existsSync(path.join(repoPath, '.git'))) {
    try {
      execFileSync('git', ['pull'], {
        cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
      });
      stats.updated++;
    } catch {
      warnings.push(`Failed to pull ${repoPath}`);
    }
  }
}

function restoreFiles(
  files: any[],
  basePath: string,
  cryptoManager: CryptoManager,
  backupDir: string,
  force: boolean,
  mode?: number,
  templateContext?: any,
): number {
  let count = 0;
  for (const file of files) {
    const filePath = path.join(basePath, file.filename);
    if (fs.existsSync(filePath) && !force) {
      const backupName = `${file.filename}.${Date.now()}.bak`;
      fs.copyFileSync(filePath, path.join(backupDir, backupName));
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let content: Buffer = Buffer.from(file.content, 'base64');
    if (file.encrypted) content = Buffer.from(cryptoManager.decrypt(content));

    // Apply template rendering if context provided and file is not encrypted (templates stored as plaintext)
    if (templateContext && file.template && !file.encrypted) {
      const rendered = renderTemplate(content.toString('utf-8'), templateContext);
      content = Buffer.from(rendered, 'utf-8');
    }

    fs.writeFileSync(filePath, content, mode ? { mode } : undefined);
    count++;
  }
  return count;
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y') || answer === '');
    });
  });
}

const INSTALL_CMDS: Record<string, (pkg: string) => string> = {
  brew: (pkg) => `brew install ${pkg}`,
  'brew-cask': (pkg) => `brew install --cask ${pkg}`,
  apt: (pkg) => `sudo apt install ${pkg}`,
  dnf: (pkg) => `sudo dnf install ${pkg}`,
  pacman: (pkg) => `sudo pacman -S ${pkg}`,
  snap: (pkg) => `sudo snap install ${pkg}`,
  npm: (pkg) => `npm install -g ${pkg}`,
  pip: (pkg) => `pip3 install --user ${pkg}`,
  cargo: (pkg) => `cargo install ${pkg}`,
  choco: (pkg) => `choco install ${pkg}`,
  winget: (pkg) => `winget install ${pkg}`,
};

// --- Dry-run preview ---

async function printDryRun(
  state: Record<string, any>,
  config: any,
  filters: Filter[],
  envFilesToRestore: any[],
  options: { packages?: boolean },
): Promise<void> {
  console.log(chalk.bold('\nDry run — no changes will be made.\n'));

  if (shouldInclude('configs', undefined, filters) && state.configs?.length) {
    console.log(chalk.bold(`  Configs (${state.configs.length}):`));
    for (const c of state.configs) {
      const exists = fs.existsSync(resolveHome(c.source));
      console.log(`    ${c.source}  ${chalk.dim(exists ? '(overwrite)' : '(create)')}`);
    }
  }

  if (shouldInclude('repos', undefined, filters) && state.repos?.length) {
    console.log(chalk.bold(`\n  Repos (${state.repos.length}):`));
    for (const r of state.repos) {
      const exists = fs.existsSync(resolveHome(r.path));
      console.log(`    ${r.path}  ${chalk.dim(exists ? '(pull)' : `(clone from ${r.url})`)}`);
    }
  }

  if (shouldInclude('env_files', undefined, filters) && envFilesToRestore?.length) {
    console.log(chalk.bold(`\n  Env files (${envFilesToRestore.length}):`));
    for (const e of envFilesToRestore) {
      const envPath = path.join(resolveHome(e.project_path), e.filename || '.env.local');
      const exists = fs.existsSync(envPath);
      console.log(`    ${e.project_path}/${e.filename || '.env.local'}  ${chalk.dim(exists ? '(overwrite)' : '(create)')}`);
    }
  }

  if (shouldInclude('modules', undefined, filters) && state.modules?.length) {
    console.log(chalk.bold(`\n  Modules (${state.modules.length}):`));
    for (const m of state.modules) {
      const fileCount = m.files?.length || 0;
      console.log(`    ${m.name}  ${chalk.dim(`(${fileCount} file${fileCount !== 1 ? 's' : ''}`)}`);
      for (const f of m.files || []) {
        const exists = fs.existsSync(resolveHome(f.path));
        console.log(`      ${f.path}  ${chalk.dim(exists ? '(overwrite)' : '(create)')}`);
      }
    }
  }

  if (shouldInclude('projects', undefined, filters) && state.projects?.length) {
    console.log(chalk.bold(`\n  Projects (${state.projects.length}):`));
    for (const p of state.projects) {
      const secretCount = p.secrets?.length || 0;
      const configCount = p.configs?.length || 0;
      console.log(`    ${p.name}  ${chalk.dim(`(${secretCount} secrets, ${configCount} configs)`)}`);
    }
  }

  if (shouldInclude('groups', undefined, filters) && state.groups?.length) {
    console.log(chalk.bold(`\n  Groups (${state.groups.length}):`));
    for (const g of state.groups) {
      console.log(`    ${g.name}  ${chalk.dim(`(${g.projects?.length || 0} projects)`)}`);
    }
  }

  if (shouldInclude('packages', undefined, filters) && state.packages?.length && options.packages !== false) {
    try {
      const localManagers = await scanPackagesAsync();
      const mappings = loadMappings(config);
      const diff = diffPackages(localManagers, state.packages, mappings);
      let totalMissing = 0;
      for (const pkgs of diff.missing.values()) totalMissing += pkgs.length;
      if (totalMissing > 0) {
        console.log(chalk.bold(`\n  Packages (${totalMissing} missing):`));
        console.log(formatDiff(diff));
      } else {
        console.log(chalk.bold('\n  Packages:') + chalk.green(' all installed'));
      }
    } catch {
      console.log(chalk.dim('\n  Packages: unable to scan'));
    }
  }

  console.log('');
}

// --- Restore category functions (for dependency-graph-driven execution) ---

interface RestoreContext {
  state: Record<string, any>;
  config: any;
  configManager: ConfigManager;
  cryptoManager: CryptoManager;
  templateContext: any;
  envFilesToRestore: any[];
  activeEnvName: string | null | undefined;
  activeProfile: any;
  filters: Filter[];
  filterGroup?: string;
  filterProject?: string;
  options: {
    force: boolean;
    packages?: boolean;
    install?: boolean;
    installYes?: boolean;
  };
  stats: {
    configs: number;
    envs: number;
    projects: number;
    groups: number;
    injected: number;
    repoStats: { cloned: number; updated: number };
    warnings: string[];
  };
}

function restoreConfigs(ctx: RestoreContext): void {
  if (!shouldInclude('configs', undefined, ctx.filters)) return;
  if (ctx.filterGroup || ctx.filterProject) return;

  for (const entry of ctx.state.configs || []) {
    const resolvedPath = resolveHome(entry.source);
    if (fs.existsSync(resolvedPath) && !ctx.options.force) {
      fs.copyFileSync(resolvedPath, path.join(ctx.configManager.backupDir, `${path.basename(resolvedPath)}.${Date.now()}.bak`));
    }
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    let content: Buffer = Buffer.from(entry.content, 'base64');
    if (entry.encrypted) content = Buffer.from(ctx.cryptoManager.decrypt(content));

    if (entry.template && !entry.encrypted) {
      const rendered = renderTemplate(content.toString('utf-8'), ctx.templateContext);
      content = Buffer.from(rendered, 'utf-8');
    }

    fs.writeFileSync(resolvedPath, content);
    ctx.stats.configs++;
  }
}

function restoreEnvFilesCategory(ctx: RestoreContext): void {
  if (!shouldInclude('env_files', undefined, ctx.filters)) return;
  if (ctx.filterGroup || ctx.filterProject) return;

  for (const env of ctx.envFilesToRestore) {
    const envPath = path.join(resolveHome(env.project_path), env.filename || '.env.local');
    if (fs.existsSync(envPath) && !ctx.options.force) {
      fs.copyFileSync(envPath, path.join(ctx.configManager.backupDir, `${path.basename(envPath)}.${Date.now()}.bak`));
    }
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    let content: Buffer = Buffer.from(env.content, 'base64');
    if (env.encrypted) content = Buffer.from(ctx.cryptoManager.decrypt(content));
    fs.writeFileSync(envPath, content, { mode: 0o600 });
    ctx.stats.envs++;
  }
}

function restoreModulesCategory(ctx: RestoreContext): void {
  if (!shouldInclude('modules', undefined, ctx.filters)) return;

  for (const mod of ctx.state.modules || []) {
    for (const file of mod.files || []) {
      const filePath = resolveHome(file.path);
      if (fs.existsSync(filePath) && !ctx.options.force) {
        fs.copyFileSync(filePath, path.join(ctx.configManager.backupDir, `${path.basename(filePath)}.${Date.now()}.bak`));
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      let content: Buffer = Buffer.from(file.content, 'base64');
      if (file.encrypted) content = Buffer.from(ctx.cryptoManager.decrypt(content));
      fs.writeFileSync(filePath, content, { mode: 0o600 });
    }
  }
}

function restoreReposCategory(ctx: RestoreContext): void {
  if (!shouldInclude('repos', undefined, ctx.filters)) return;
  if (ctx.filterGroup || ctx.filterProject) return;

  for (const repo of ctx.state.repos || []) {
    cloneOrPullRepo(repo, resolveHome(repo.path), ctx.stats.repoStats, ctx.stats.warnings);
    if (repo.has_uncommitted) {
      ctx.stats.warnings.push(`${repo.path} had uncommitted changes on source machine`);
    }
  }
}

function restoreProjectsCategory(ctx: RestoreContext): void {
  if (!shouldInclude('projects', undefined, ctx.filters)) return;
  if (ctx.filterGroup) return;

  for (const project of ctx.state.projects || []) {
    if (ctx.filterProject && !project.name.toLowerCase().includes(ctx.filterProject)) continue;

    const projectPath = resolveHome(project.path);
    if (project.repo?.url) {
      cloneOrPullRepo(project.repo, projectPath, ctx.stats.repoStats, ctx.stats.warnings);
    }

    const projectConfig = (ctx.config.projects || []).find((p: any) => p.name === project.name || resolveHome(p.path) === projectPath);
    if (projectConfig?.inject_as_env) {
      writeEnvInject(ctx.configManager.configDir, project, ctx.cryptoManager, ctx.activeEnvName, ctx.activeProfile?.env_overrides);
      ctx.stats.injected++;
    } else {
      restoreFiles(project.secrets || [], projectPath, ctx.cryptoManager, ctx.configManager.backupDir, ctx.options.force, 0o600);
    }

    restoreFiles(project.configs || [], projectPath, ctx.cryptoManager, ctx.configManager.backupDir, ctx.options.force, undefined, ctx.templateContext);
    ctx.stats.projects++;
  }
}

function restoreGroupsCategory(ctx: RestoreContext): void {
  if (!shouldInclude('groups', undefined, ctx.filters)) return;

  for (const group of ctx.state.groups || []) {
    if (ctx.filterGroup && !group.name.toLowerCase().includes(ctx.filterGroup)) continue;

    for (const project of group.projects || []) {
      if (ctx.filterProject && !project.name.toLowerCase().includes(ctx.filterProject)) continue;

      const projectPath = resolveHome(project.path);
      if (project.repo?.url) {
        cloneOrPullRepo(project.repo, projectPath, ctx.stats.repoStats, ctx.stats.warnings);
      }

      const projectConfig = (ctx.config.projects || []).find((p: any) => p.name === project.name || resolveHome(p.path) === projectPath);
      if (projectConfig?.inject_as_env) {
        writeEnvInject(ctx.configManager.configDir, project, ctx.cryptoManager, ctx.activeEnvName, ctx.activeProfile?.env_overrides);
        ctx.stats.injected++;
      } else {
        restoreFiles(project.secrets || [], projectPath, ctx.cryptoManager, ctx.configManager.backupDir, ctx.options.force, 0o600);
      }

      restoreFiles(project.configs || [], projectPath, ctx.cryptoManager, ctx.configManager.backupDir, ctx.options.force, undefined, ctx.templateContext);
      ctx.stats.projects++;
    }
    ctx.stats.groups++;
  }
}

// Category name → restore function mapping
const RESTORE_FNS: Record<string, (ctx: RestoreContext) => void> = {
  configs: restoreConfigs,
  env_files: restoreEnvFilesCategory,
  modules: restoreModulesCategory,
  repos: restoreReposCategory,
  projects: restoreProjectsCategory,
  groups: restoreGroupsCategory,
  packages: () => {}, // handled separately after restore
};

// --- Main command ---

export function registerPullCommand(program: Command): void {
  program
    .command('pull')
    .description('Pull and restore state from sync backend')
    .option('--force', 'overwrite existing files without backup', false)
    .option('--from <machine>', 'pull from a specific machine (name or ID)')
    .option('--group <name>', 'only pull a specific project group')
    .option('--project <name>', 'only pull a specific project')
    .option('--list-machines', 'list available machines to pull from')
    .option('--install', 'install missing packages after pull')
    .option('--install-yes', 'install missing packages without prompting')
    .option('--no-packages', 'skip package reconciliation')
    .option('--no-delete', 'pull cloud additions without removing local-only environments')
    .option('--cloud-wins', 'on conflict, prefer cloud version over local')
    .option('-y, --yes', 'skip confirmation prompt')
    .option('--dry-run', 'preview what would be restored without making changes')
    .option('--filter <filters...>', 'only pull specific items (e.g. modules:ssh,configs)')
    .option('--snapshot <id>', 'restore a specific snapshot by ID')
    .option('--i-know-what-im-doing', 'override production safety (requires CONFIGSYNC_ALLOW_PROD_SKIP=1)')
    .action(async (options: {
      force: boolean;
      from?: string;
      group?: string;
      project?: string;
      listMachines?: boolean;
      install?: boolean;
      installYes?: boolean;
      packages?: boolean;
      noDelete?: boolean;
      cloudWins?: boolean;
      yes?: boolean;
      dryRun?: boolean;
      filter?: string[];
      snapshot?: string;
      iKnowWhatImDoing?: boolean;
    }) => {
      const configManager = new ConfigManager();

      if (!configManager.exists()) {
        console.error(chalk.red("Error: Run 'configsync init' first."));
        process.exit(1);
      }

      const config = configManager.load();

      // Environment safety check
      const envManager = new EnvironmentManager(configManager.configDir);
      const activeEnv = envManager.getActive(config, program.opts().env);
      if (activeEnv && !options.dryRun) {
        console.log(renderBanner(activeEnv));
        const operation = options.force ? 'pull-force' : 'pull';
        const confirmed = await requireConfirmation(activeEnv, operation as any, options);
        if (!confirmed) {
          process.exit(1);
        }
      }

      // Resolve active profile
      const profileManager = new ProfileManager(configManager.configDir);
      const activeProfile = profileManager.getActive(config, program.opts().profile);

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

          if (options.listMachines) {
            spinner.stop();
            const machines = await backend.listMachines();
            if (machines.length === 0) {
              console.log(chalk.dim('No machines found.'));
            } else {
              console.log(chalk.bold('Available machines:\n'));
              for (const m of machines) {
                console.log(`  ${m.name} ${chalk.dim(`(${m.machine_id})`)}`);
              }
            }
            process.exit(0);
          }

          // Snapshot restore
          if (options.snapshot) {
            state = await backend.pullSnapshot(parseInt(options.snapshot, 10), cryptoManager);
            if (!state) {
              spinner.fail(`Snapshot #${options.snapshot} not found.`);
              process.exit(1);
            }
          } else {
            let pullFromMachineId: string | undefined;
            if (options.from) {
              const machines = await backend.listMachines();
              const match = machines.find((m: any) =>
                m.machine_id === options.from ||
                m.name.toLowerCase().includes(options.from!.toLowerCase())
              );
              if (!match) {
                spinner.fail(`Machine "${options.from}" not found.`);
                if (machines.length > 0) {
                  console.log(chalk.dim('\nAvailable machines:'));
                  for (const m of machines) {
                    console.log(chalk.dim(`  - ${m.name} (${m.machine_id})`));
                  }
                }
                process.exit(1);
              }
              pullFromMachineId = match.machine_id;
              spinner.text = `Pulling from ${match.name}...`;
            }

            state = await backend.pull(cryptoManager, pullFromMachineId);
          }

          // Merge cloud environments into local config (skip on dry-run)
          if (!options.dryRun) {
            try {
              const cloudEnvs = await backend.getEnvironments();
              if (cloudEnvs.length > 0) {
                if (!config.environments) config.environments = [];
                const cloudByName = new Map(cloudEnvs.map((e: any) => [e.name, e]));
                let added = 0;
                let updated = 0;
                let removed = 0;

                for (const cloudEnv of cloudEnvs) {
                  const local = config.environments.find((e: any) => e.name === cloudEnv.name);
                  if (!local) {
                    config.environments.push({
                      name: cloudEnv.name,
                      tier: cloudEnv.tier,
                      color: cloudEnv.color,
                      protect: !!cloudEnv.protect,
                    });
                    added++;
                  } else if (options.cloudWins) {
                    local.tier = cloudEnv.tier;
                    local.color = cloudEnv.color;
                    local.protect = !!cloudEnv.protect;
                    updated++;
                  }
                }

                if (!options.noDelete) {
                  const toRemove = config.environments.filter((e: any) => !cloudByName.has(e.name));
                  for (const env of toRemove) {
                    const idx = config.environments.indexOf(env);
                    if (idx !== -1) {
                      config.environments.splice(idx, 1);
                      removed++;
                    }
                  }
                }

                if (added > 0 || updated > 0 || removed > 0) {
                  configManager.save(config);
                }
              }
            } catch {
              // Environment sync is non-critical
            }
          }
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

        // Resolve environment-scoped env files
        const activeEnvName = activeEnv?.name || envManager.resolve(program.opts().env);
        let envFilesToRestore = state.env_files || [];
        if (activeEnvName && state.env_files_by_environment?.[activeEnvName]) {
          envFilesToRestore = state.env_files_by_environment[activeEnvName];
        }

        // Parse filters (--filter flag + legacy --group/--project shortcuts)
        const filters = parseFilters(options.filter || []);

        // Dry-run mode: preview only
        if (options.dryRun) {
          spinner.stop();
          await printDryRun(state, config, filters, envFilesToRestore, options);
          return;
        }

        spinner.text = 'Restoring...';

        // Build template context
        const templateContext = buildContext(config.machine, activeProfile);

        const filterGroup = options.group?.toLowerCase();
        const filterProject = options.project?.toLowerCase();

        const ctx: RestoreContext = {
          state,
          config,
          configManager,
          cryptoManager,
          templateContext,
          envFilesToRestore,
          activeEnvName,
          activeProfile,
          filters,
          filterGroup,
          filterProject,
          options,
          stats: {
            configs: 0,
            envs: 0,
            projects: 0,
            groups: 0,
            injected: 0,
            repoStats: { cloned: 0, updated: 0 },
            warnings: [],
          },
        };

        // Execute restore in dependency-graph order
        const levels = getRestoreLevels();
        for (const level of levels) {
          // Run all categories in this level in parallel
          await Promise.all(
            level.map(async (category) => {
              const fn = RESTORE_FNS[category];
              if (fn) fn(ctx);
            }),
          );
        }

        // Build summary
        const parts: string[] = [];
        if (ctx.stats.configs) parts.push(`${ctx.stats.configs} config${ctx.stats.configs !== 1 ? 's' : ''}`);
        if (ctx.stats.repoStats.cloned) parts.push(`${ctx.stats.repoStats.cloned} repo${ctx.stats.repoStats.cloned !== 1 ? 's' : ''} cloned`);
        if (ctx.stats.repoStats.updated) parts.push(`${ctx.stats.repoStats.updated} repo${ctx.stats.repoStats.updated !== 1 ? 's' : ''} updated`);
        if (ctx.stats.envs) parts.push(`${ctx.stats.envs} env file${ctx.stats.envs !== 1 ? 's' : ''}`);
        if (ctx.stats.projects) parts.push(`${ctx.stats.projects} project${ctx.stats.projects !== 1 ? 's' : ''}`);
        if (ctx.stats.groups) parts.push(`${ctx.stats.groups} group${ctx.stats.groups !== 1 ? 's' : ''}`);
        if (ctx.stats.injected) parts.push(`${ctx.stats.injected} project${ctx.stats.injected !== 1 ? 's' : ''} (env injected)`);

        spinner.succeed(`Restored! (${parts.join(', ') || 'no changes'})`);

        if (state.timestamp) console.log(`  ${chalk.dim('Snapshot from:')} ${state.timestamp}`);
        if (state.message) console.log(`  ${chalk.dim('Message:')} ${state.message}`);

        // Package reconciliation
        if (shouldInclude('packages', undefined, filters) && state.packages?.length && !isFilterActive(filters.filter(f => f.type !== 'packages')) && options.packages !== false) {
          const totalPkgs = state.packages.reduce((s: number, m: any) => s + m.packages.length, 0);
          console.log(`\n  ${chalk.dim('Packages:')} ${totalPkgs} packages from ${state.packages.length} manager(s)`);

          if (options.install || options.installYes) {
            spinner.start('Scanning local packages...');
            const localManagers = await scanPackagesAsync();
            spinner.stop();

            const mappings = loadMappings(config);
            const diff = diffPackages(localManagers, state.packages, mappings);

            let totalMissing = 0;
            for (const pkgs of diff.missing.values()) totalMissing += pkgs.length;

            if (totalMissing === 0) {
              console.log(chalk.green('\n  All packages already installed!'));
            } else {
              console.log(formatDiff(diff));

              const commands: string[] = [];
              for (const [manager, packages] of diff.missing) {
                const cmdFn = INSTALL_CMDS[manager];
                if (!cmdFn) continue;

                if (manager === 'brew' || manager === 'apt' || manager === 'dnf' || manager === 'pacman') {
                  commands.push(cmdFn(packages.join(' ')));
                } else {
                  for (const pkg of packages) {
                    commands.push(cmdFn(pkg));
                  }
                }
              }

              if (commands.length > 0) {
                console.log(chalk.bold('\n  Install commands:'));
                for (const cmd of commands) {
                  console.log(chalk.dim(`    ${cmd}`));
                }

                let doInstall = options.installYes;
                if (!doInstall) {
                  doInstall = await confirm('\n  Run these commands? [y/N] ');
                }

                if (doInstall) {
                  for (const cmd of commands) {
                    console.log(chalk.dim(`\n  $ ${cmd}`));
                    try {
                      execSync(cmd, { stdio: 'inherit', timeout: 300000 });
                    } catch (err: any) {
                      ctx.stats.warnings.push(`Failed: ${cmd}`);
                    }
                  }
                }
              }
            }
          } else {
            console.log(chalk.dim('  Run "configsync pull --install" to install missing packages'));
          }
        }

        if (ctx.stats.injected > 0) {
          console.log(chalk.dim(`\n  Env vars injected for ${ctx.stats.injected} project(s). Use "eval $(configsync env vars)" or the shell hook.`));
        }

        if (ctx.stats.warnings.length > 0) {
          console.log(chalk.yellow('\nWarnings:'));
          for (const w of ctx.stats.warnings) console.log(chalk.yellow(`  - ${w}`));
        }
      } catch (err: any) {
        spinner.fail(`Pull failed: ${err.message}`);
        process.exit(1);
      }
    });
}

/**
 * Write env vars to ~/.configsync/env_inject/<hash>.json for shell injection
 * instead of writing .env files to disk.
 */
function writeEnvInject(
  configDir: string,
  project: any,
  cryptoManager: CryptoManager,
  environment?: string | null,
  profileOverrides?: Record<string, string>,
): void {
  const injectDir = path.join(configDir, 'env_inject');
  fs.mkdirSync(injectDir, { recursive: true });

  const vars: Record<string, string> = {};
  for (const secret of project.secrets || []) {
    let content: Buffer = Buffer.from(secret.content, 'base64');
    if (secret.encrypted) content = Buffer.from(cryptoManager.decrypt(content));

    const lines = content.toString('utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)) continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  }

  if (profileOverrides) {
    Object.assign(vars, profileOverrides);
  }

  const projectPath = resolveHome(project.path);
  const hash = crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 12);

  const data = {
    project_path: project.path,
    directory: projectPath,
    environment: environment || null,
    vars,
  };

  fs.writeFileSync(
    path.join(injectDir, `${hash}.json`),
    JSON.stringify(data, null, 2),
    { mode: 0o600 },
  );
}
