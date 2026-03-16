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

function cloneOrPullRepo(
  repo: { url: string; branch?: string },
  repoPath: string,
  stats: { cloned: number; updated: number },
  warnings: string[],
): void {
  if (!fs.existsSync(repoPath)) {
    // Clone
    try {
      fs.mkdirSync(path.dirname(repoPath), { recursive: true });
      execSync(`git clone ${repo.url} ${repoPath}`, {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000,
      });
      if (repo.branch && repo.branch !== 'main' && repo.branch !== 'master') {
        execSync(`git checkout ${repo.branch}`, {
          cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
      stats.cloned++;
    } catch (err: any) {
      warnings.push(`Failed to clone ${repo.url}: ${err.message}`);
    }
  } else if (fs.existsSync(path.join(repoPath, '.git'))) {
    // Already exists — git pull
    try {
      execSync('git pull', {
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
    fs.writeFileSync(filePath, content, mode ? { mode } : undefined);
    count++;
  }
  return count;
}

export function registerPullCommand(program: Command): void {
  program
    .command('pull')
    .description('Pull and restore state from sync backend')
    .option('--force', 'overwrite existing files without backup', false)
    .option('--from <machine>', 'pull from a specific machine (name or ID)')
    .option('--group <name>', 'only pull a specific project group')
    .option('--project <name>', 'only pull a specific project')
    .option('--list-machines', 'list available machines to pull from')
    .action(async (options: {
      force: boolean;
      from?: string;
      group?: string;
      project?: string;
      listMachines?: boolean;
    }) => {
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

        const repoStats = { cloned: 0, updated: 0 };
        let configsRestored = 0;
        let envsRestored = 0;
        let projectsRestored = 0;
        let groupsRestored = 0;
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
          for (const env of state.env_files || []) {
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
            restoreFiles(project.secrets || [], projectPath, cryptoManager, configManager.backupDir, options.force, 0o600);
            restoreFiles(project.configs || [], projectPath, cryptoManager, configManager.backupDir, options.force);
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
            restoreFiles(project.secrets || [], projectPath, cryptoManager, configManager.backupDir, options.force, 0o600);
            restoreFiles(project.configs || [], projectPath, cryptoManager, configManager.backupDir, options.force);
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

        spinner.succeed(`Restored! (${parts.join(', ') || 'no changes'})`);

        if (state.timestamp) console.log(`  ${chalk.dim('Snapshot from:')} ${state.timestamp}`);
        if (state.message) console.log(`  ${chalk.dim('Message:')} ${state.message}`);

        if (state.packages?.length && !isFiltered) {
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
