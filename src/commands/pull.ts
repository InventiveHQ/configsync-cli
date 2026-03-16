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
import { scanPackages } from '../lib/packages.js';
import { diffPackages, formatDiff } from '../lib/package-diff.js';
import { loadMappings } from '../lib/package-mappings.js';

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
    .option('--i-know-what-im-doing', 'override production safety (requires CONFIGSYNC_ALLOW_PROD_SKIP=1)')
    .action(async (options: {
      force: boolean;
      from?: string;
      group?: string;
      project?: string;
      listMachines?: boolean;
      install?: boolean;
      installYes?: boolean;
      packages?: boolean; // --no-packages sets this to false
      noDelete?: boolean;
      cloudWins?: boolean;
      yes?: boolean;
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
      if (activeEnv) {
        console.log(renderBanner(activeEnv));
        const operation = options.force ? 'pull-force' : 'pull';
        const confirmed = await requireConfirmation(activeEnv, operation as any, options);
        if (!confirmed) {
          process.exit(1);
        }
      }

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

          // Merge cloud environments into local config
          try {
            const cloudEnvs = await backend.getEnvironments();
            if (cloudEnvs.length > 0) {
              if (!config.environments) config.environments = [];
              const cloudByName = new Map(cloudEnvs.map((e: any) => [e.name, e]));
              let added = 0;
              let updated = 0;
              let removed = 0;

              // Add cloud-only envs to local; optionally overwrite on conflict
              for (const cloudEnv of cloudEnvs) {
                const local = config.environments.find(e => e.name === cloudEnv.name);
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

              // Remove local envs not in cloud (unless --no-delete)
              if (!options.noDelete) {
                const toRemove = config.environments.filter(e => !cloudByName.has(e.name));
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
                const parts: string[] = [];
                if (added) parts.push(`${added} added`);
                if (updated) parts.push(`${updated} updated`);
                if (removed) parts.push(`${removed} removed`);
                spinner.text = `Environments: ${parts.join(', ')}`;
              }
            }
          } catch {
            // Environment sync is non-critical
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

        spinner.text = 'Restoring...';

        // Build template context for this machine
        const templateContext = buildContext(config.machine);

        // Resolve environment-scoped env files
        const activeEnvName = activeEnv?.name || envManager.resolve(program.opts().env);
        let envFilesToRestore = state.env_files || [];
        if (activeEnvName && state.env_files_by_environment?.[activeEnvName]) {
          envFilesToRestore = state.env_files_by_environment[activeEnvName];
        }

        const repoStats = { cloned: 0, updated: 0 };
        let configsRestored = 0;
        let envsRestored = 0;
        let projectsRestored = 0;
        let groupsRestored = 0;
        let injectedProjects = 0;
        const warnings: string[] = [];

        const filterGroup = options.group?.toLowerCase();
        const filterProject = options.project?.toLowerCase();
        const isFiltered = !!(filterGroup || filterProject);

        // If filtering by group/project, skip standalone items
        if (!isFiltered) {
          // Restore standalone config files
          for (const entry of state.configs || []) {
            const resolvedPath = resolveHome(entry.source);
            if (fs.existsSync(resolvedPath) && !options.force) {
              fs.copyFileSync(resolvedPath, path.join(configManager.backupDir, `${path.basename(resolvedPath)}.${Date.now()}.bak`));
            }
            fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
            let content: Buffer = Buffer.from(entry.content, 'base64');
            if (entry.encrypted) content = Buffer.from(cryptoManager.decrypt(content));

            // Template rendering for non-encrypted config files
            if (entry.template && !entry.encrypted) {
              const rendered = renderTemplate(content.toString('utf-8'), templateContext);
              content = Buffer.from(rendered, 'utf-8');
            }

            fs.writeFileSync(resolvedPath, content);
            configsRestored++;
          }

          // Restore standalone repos
          for (const repo of state.repos || []) {
            cloneOrPullRepo(repo, resolveHome(repo.path), repoStats, warnings);
            if (repo.has_uncommitted) {
              warnings.push(`${repo.path} had uncommitted changes on source machine`);
            }
          }

          // Restore standalone env files
          for (const env of envFilesToRestore) {
            const envPath = path.join(resolveHome(env.project_path), env.filename || '.env.local');
            if (fs.existsSync(envPath) && !options.force) {
              fs.copyFileSync(envPath, path.join(configManager.backupDir, `${path.basename(envPath)}.${Date.now()}.bak`));
            }
            fs.mkdirSync(path.dirname(envPath), { recursive: true });
            let content: Buffer = Buffer.from(env.content, 'base64');
            if (env.encrypted) content = Buffer.from(cryptoManager.decrypt(content));
            fs.writeFileSync(envPath, content, { mode: 0o600 });
            envsRestored++;
          }
        }

        // Restore standalone projects (if not filtering by group, or if project name matches)
        if (!filterGroup) {
          for (const project of state.projects || []) {
            if (filterProject && !project.name.toLowerCase().includes(filterProject)) continue;

            const projectPath = resolveHome(project.path);
            if (project.repo?.url) {
              cloneOrPullRepo(project.repo, projectPath, repoStats, warnings);
            }

            // Check if this project should use env injection
            const projectConfig = (config.projects || []).find(p => p.name === project.name || resolveHome(p.path) === projectPath);
            if (projectConfig?.inject_as_env) {
              // Write to env_inject directory instead of disk
              writeEnvInject(configManager.configDir, project, cryptoManager, activeEnvName);
              injectedProjects++;
            } else {
              restoreFiles(project.secrets || [], projectPath, cryptoManager, configManager.backupDir, options.force, 0o600);
            }

            restoreFiles(project.configs || [], projectPath, cryptoManager, configManager.backupDir, options.force, undefined, templateContext);
            projectsRestored++;
          }
        }

        // Restore groups
        for (const group of state.groups || []) {
          if (filterGroup && !group.name.toLowerCase().includes(filterGroup)) continue;

          for (const project of group.projects || []) {
            if (filterProject && !project.name.toLowerCase().includes(filterProject)) continue;

            const projectPath = resolveHome(project.path);
            if (project.repo?.url) {
              cloneOrPullRepo(project.repo, projectPath, repoStats, warnings);
            }

            const projectConfig = (config.projects || []).find(p => p.name === project.name || resolveHome(p.path) === projectPath);
            if (projectConfig?.inject_as_env) {
              writeEnvInject(configManager.configDir, project, cryptoManager, activeEnvName);
              injectedProjects++;
            } else {
              restoreFiles(project.secrets || [], projectPath, cryptoManager, configManager.backupDir, options.force, 0o600);
            }

            restoreFiles(project.configs || [], projectPath, cryptoManager, configManager.backupDir, options.force, undefined, templateContext);
            projectsRestored++;
          }
          groupsRestored++;
        }

        // Build summary
        const parts: string[] = [];
        if (configsRestored) parts.push(`${configsRestored} config${configsRestored !== 1 ? 's' : ''}`);
        if (repoStats.cloned) parts.push(`${repoStats.cloned} repo${repoStats.cloned !== 1 ? 's' : ''} cloned`);
        if (repoStats.updated) parts.push(`${repoStats.updated} repo${repoStats.updated !== 1 ? 's' : ''} updated`);
        if (envsRestored) parts.push(`${envsRestored} env file${envsRestored !== 1 ? 's' : ''}`);
        if (projectsRestored) parts.push(`${projectsRestored} project${projectsRestored !== 1 ? 's' : ''}`);
        if (groupsRestored) parts.push(`${groupsRestored} group${groupsRestored !== 1 ? 's' : ''}`);
        if (injectedProjects) parts.push(`${injectedProjects} project${injectedProjects !== 1 ? 's' : ''} (env injected)`);

        spinner.succeed(`Restored! (${parts.join(', ') || 'no changes'})`);

        if (state.timestamp) console.log(`  ${chalk.dim('Snapshot from:')} ${state.timestamp}`);
        if (state.message) console.log(`  ${chalk.dim('Message:')} ${state.message}`);

        // Package reconciliation
        if (state.packages?.length && !isFiltered && options.packages !== false) {
          const totalPkgs = state.packages.reduce((s: number, m: any) => s + m.packages.length, 0);
          console.log(`\n  ${chalk.dim('Packages:')} ${totalPkgs} packages from ${state.packages.length} manager(s)`);

          if (options.install || options.installYes) {
            spinner.start('Scanning local packages...');
            const localManagers = scanPackages();
            spinner.stop();

            const mappings = loadMappings(config);
            const diff = diffPackages(localManagers, state.packages, mappings);

            let totalMissing = 0;
            for (const pkgs of diff.missing.values()) totalMissing += pkgs.length;

            if (totalMissing === 0) {
              console.log(chalk.green('\n  All packages already installed!'));
            } else {
              console.log(formatDiff(diff));

              // Build install commands
              const commands: string[] = [];
              for (const [manager, packages] of diff.missing) {
                const cmdFn = INSTALL_CMDS[manager];
                if (!cmdFn) continue;

                if (manager === 'brew' || manager === 'apt' || manager === 'dnf' || manager === 'pacman') {
                  // Batch install for system managers
                  commands.push(cmdFn(packages.join(' ')));
                } else {
                  // Individual install for language managers
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
                      warnings.push(`Failed: ${cmd}`);
                    }
                  }
                }
              }
            }
          } else {
            console.log(chalk.dim('  Run "configsync pull --install" to install missing packages'));
          }
        }

        if (injectedProjects > 0) {
          console.log(chalk.dim(`\n  Env vars injected for ${injectedProjects} project(s). Use "eval $(configsync env vars)" or the shell hook.`));
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

/**
 * Write env vars to ~/.configsync/env_inject/<hash>.json for shell injection
 * instead of writing .env files to disk.
 */
function writeEnvInject(
  configDir: string,
  project: any,
  cryptoManager: CryptoManager,
  environment?: string | null,
): void {
  const injectDir = path.join(configDir, 'env_inject');
  fs.mkdirSync(injectDir, { recursive: true });

  // Parse decrypted secrets into key=value pairs
  const vars: Record<string, string> = {};
  for (const secret of project.secrets || []) {
    let content: Buffer = Buffer.from(secret.content, 'base64');
    if (secret.encrypted) content = Buffer.from(cryptoManager.decrypt(content));

    // Parse .env format
    const lines = content.toString('utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)) continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
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
