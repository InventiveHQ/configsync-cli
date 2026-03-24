import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTwoFilesPatch } from 'diff';
import { ConfigManager } from '../lib/config.js';
import CryptoManager from '../lib/crypto.js';
import CloudBackend from '../lib/cloud.js';
import { promptPassword } from '../lib/prompt.js';
import { parseFilters, shouldInclude, type Filter } from '../lib/filter.js';

function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

interface DiffEntry {
  category: string;
  path: string;
  status: 'modified' | 'added' | 'removed' | 'identical';
  diff?: string;
}

function colorDiff(patch: string): string {
  return patch.split('\n').map(line => {
    if (line.startsWith('---') || line.startsWith('+++')) return chalk.bold(line);
    if (line.startsWith('@@')) return chalk.cyan(line);
    if (line.startsWith('-')) return chalk.red(line);
    if (line.startsWith('+')) return chalk.green(line);
    return line;
  }).join('\n');
}

function readLocalFile(filePath: string): string | null {
  const resolved = resolveHome(filePath);
  if (!fs.existsSync(resolved)) return null;
  if (!fs.statSync(resolved).isFile()) return null;
  return fs.readFileSync(resolved, 'utf-8');
}

function decryptEntry(entry: any, cryptoManager: CryptoManager): string {
  let content = Buffer.from(entry.content, 'base64');
  if (entry.encrypted) content = Buffer.from(cryptoManager.decrypt(content));
  return content.toString('utf-8');
}

function diffFile(category: string, displayPath: string, localContent: string | null, remoteContent: string): DiffEntry {
  if (localContent === null) {
    return { category, path: displayPath, status: 'removed' };
  }
  if (localContent === remoteContent) {
    return { category, path: displayPath, status: 'identical' };
  }
  const patch = createTwoFilesPatch(
    `remote: ${displayPath}`,
    `local: ${displayPath}`,
    remoteContent,
    localContent,
    '', '',
    { context: 3 },
  );
  return { category, path: displayPath, status: 'modified', diff: patch };
}

function computeDiffs(
  config: any,
  state: Record<string, any>,
  cryptoManager: CryptoManager,
  filters: Filter[],
): DiffEntry[] {
  const entries: DiffEntry[] = [];

  // Configs
  if (shouldInclude('configs', undefined, filters)) {
    for (const entry of state.configs || []) {
      const local = readLocalFile(entry.source);
      const remote = decryptEntry(entry, cryptoManager);
      entries.push(diffFile('configs', entry.source, local, remote));
    }
  }

  // Modules
  if (shouldInclude('modules', undefined, filters)) {
    for (const mod of state.modules || []) {
      for (const file of mod.files || []) {
        const local = readLocalFile(file.path);
        const remote = decryptEntry(file, cryptoManager);
        entries.push(diffFile(`modules/${mod.name}`, file.path, local, remote));
      }
    }
  }

  // Env files
  if (shouldInclude('env_files', undefined, filters)) {
    for (const env of state.env_files || []) {
      const envPath = `${env.project_path}/${env.filename || '.env.local'}`;
      const fullPath = path.join(resolveHome(env.project_path), env.filename || '.env.local');
      const local = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;
      const remote = decryptEntry(env, cryptoManager);
      entries.push(diffFile('env_files', envPath, local, remote));
    }
  }

  // Projects
  if (shouldInclude('projects', undefined, filters)) {
    for (const project of state.projects || []) {
      const projectPath = resolveHome(project.path);
      for (const file of [...(project.secrets || []), ...(project.configs || [])]) {
        const fullPath = path.join(projectPath, file.filename);
        const local = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;
        const remote = decryptEntry(file, cryptoManager);
        entries.push(diffFile(`projects/${project.name}`, `${project.path}/${file.filename}`, local, remote));
      }
    }
  }

  // Groups
  if (shouldInclude('groups', undefined, filters)) {
    for (const group of state.groups || []) {
      for (const project of group.projects || []) {
        const projectPath = resolveHome(project.path);
        for (const file of [...(project.secrets || []), ...(project.configs || [])]) {
          const fullPath = path.join(projectPath, file.filename);
          const local = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;
          const remote = decryptEntry(file, cryptoManager);
          entries.push(diffFile(`groups/${group.name}/${project.name}`, `${project.path}/${file.filename}`, local, remote));
        }
      }
    }
  }

  return entries;
}

export function registerDiffCommand(program: Command): void {
  program
    .command('diff')
    .description('Show differences between local files and remote state')
    .option('--from <machine>', 'diff against a specific machine')
    .option('--snapshot <id>', 'diff against a specific snapshot')
    .option('--filter <filters...>', 'only diff specific items')
    .option('--stat', 'show summary only (no content diff)')
    .option('--name-only', 'show only file paths that differ')
    .action(async (options: {
      from?: string;
      snapshot?: string;
      filter?: string[];
      stat?: boolean;
      nameOnly?: boolean;
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

      const spinner = ora('Fetching remote state...').start();

      try {
        let state: Record<string, any> | null = null;

        if (config.sync.backend === 'cloud') {
          const apiUrl = config.sync.config.api_url;
          const apiKey = config.sync.config.api_key;
          if (!apiUrl || !apiKey) {
            spinner.fail('Cloud backend not configured.');
            process.exit(1);
          }

          const backend = new CloudBackend(apiUrl, apiKey);

          if (options.snapshot) {
            state = await backend.pullSnapshot(parseInt(options.snapshot, 10), cryptoManager);
          } else {
            let machineId: string | undefined;
            if (options.from) {
              const machines = await backend.listMachines();
              const match = machines.find((m: any) =>
                m.machine_id === options.from || m.name.toLowerCase().includes(options.from!.toLowerCase()));
              machineId = match?.machine_id;
            }
            state = await backend.pull(cryptoManager, machineId);
          }
        } else {
          const stateFile = path.join(configManager.stateDir, 'state.json');
          if (fs.existsSync(stateFile)) {
            state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          }
        }

        if (!state) {
          spinner.fail('No remote state found.');
          process.exit(1);
        }

        spinner.text = 'Computing differences...';

        const filters = parseFilters(options.filter || []);
        const entries = computeDiffs(config, state, cryptoManager, filters);
        spinner.stop();

        const modified = entries.filter(e => e.status === 'modified');
        const removed = entries.filter(e => e.status === 'removed');
        const identical = entries.filter(e => e.status === 'identical');

        if (modified.length === 0 && removed.length === 0) {
          console.log(chalk.green('\nAll files are identical to remote state.'));
          console.log(chalk.dim(`  ${identical.length} file${identical.length !== 1 ? 's' : ''} compared.`));
          return;
        }

        if (options.stat) {
          console.log(chalk.bold('\nDiff summary:\n'));
          if (modified.length) console.log(chalk.yellow(`  ${modified.length} modified`));
          if (removed.length) console.log(chalk.red(`  ${removed.length} removed locally`));
          console.log(chalk.dim(`  ${identical.length} identical`));
          return;
        }

        if (options.nameOnly) {
          for (const entry of [...modified, ...removed]) {
            const color = entry.status === 'modified' ? chalk.yellow : chalk.red;
            console.log(color(`${entry.status === 'modified' ? 'M' : 'D'}  ${entry.path}`));
          }
          return;
        }

        // Full diff output
        for (const entry of modified) {
          console.log(colorDiff(entry.diff!));
        }

        for (const entry of removed) {
          console.log(chalk.red(`\nDeleted locally: ${entry.path}`));
        }

        console.log(chalk.dim(`\n${modified.length} modified, ${removed.length} removed, ${identical.length} identical`));
      } catch (err: any) {
        spinner.fail(`Diff failed: ${err.message}`);
        process.exit(1);
      }
    });
}
