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
import { CloudV2, EntityRow } from '../lib/cloud-v2.js';
import { SessionManager } from '../lib/session.js';
import { unwrapDEK, UserKeypair } from '../lib/envelope-crypto.js';
import {
  bytesToBlob,
  decryptEntityBlob,
  EntityBlob,
} from '../lib/entity-blob.js';

type EntityKind = 'project' | 'workspace' | 'config' | 'module' | 'profile';

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
    .option('--project <slug>', 'diff a project entity version')
    .option('--workspace <slug>', 'diff a workspace entity version')
    .option('--config <slug>', 'diff a config entity version')
    .option('--module <slug>', 'diff a module entity version')
    .option('--profile <slug>', 'diff a profile entity version')
    .option('--version <n>', 'entity version to diff against')
    .action(async (options: {
      from?: string;
      snapshot?: string;
      filter?: string[];
      stat?: boolean;
      nameOnly?: boolean;
      project?: string;
      workspace?: string;
      config?: string;
      module?: string;
      profile?: string;
      version?: string;
    }) => {
      // Per-entity version diff branch
      const entityOpts: [EntityKind, string | undefined][] = [
        ['project', options.project],
        ['workspace', options.workspace],
        ['config', options.config],
        ['module', options.module],
        ['profile', options.profile],
      ];
      const activeEntity = entityOpts.filter(([, v]) => !!v);
      if (activeEntity.length > 1) {
        console.error(chalk.red('Specify at most one entity flag.'));
        process.exit(1);
      }
      if (activeEntity.length === 1) {
        if (!options.version) {
          console.error(chalk.red('--version <n> is required with an entity flag.'));
          process.exit(1);
        }
        const [kind, slug] = activeEntity[0] as [EntityKind, string];
        await diffEntityVersion(kind, slug, parseInt(options.version, 10), options);
        return;
      }

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

// ---------------------------------------------------------------------------
// Entity version diff (v2)
// ---------------------------------------------------------------------------

async function diffEntityVersion(
  kind: EntityKind,
  slug: string,
  version: number,
  options: { stat?: boolean; nameOnly?: boolean },
): Promise<void> {
  if (!Number.isFinite(version) || version < 1) {
    console.error(chalk.red(`Invalid version: ${version}`));
    process.exit(1);
  }

  const { cloud, keypair } = await loadV2Context();
  const row = await findEntityBySlug(cloud, kind, slug);

  const spinner = ora(`Fetching ${kind} '${slug}' v${version} & current...`).start();
  try {
    const info = await cloud.getEntity(kind, row.id);
    if (!info.wrapped_dek) {
      spinner.fail(`No wrapped DEK for ${kind} '${slug}'`);
      process.exit(1);
    }
    const dek = unwrapDEK(Buffer.from(info.wrapped_dek, 'base64'), keypair);

    // Fetch both the target historical version and the current version
    // so the diff reflects "how would this rollback change things".
    const [targetCt, currentCt] = await Promise.all([
      cloud.getEntityVersionBlob(kind, row.id, version),
      cloud.getEntityBlob(kind, row.id),
    ]);
    const targetBytes = decryptEntityBlob(targetCt, dek, kind, row.id, version);
    const currentBytes = decryptEntityBlob(
      currentCt,
      dek,
      kind,
      row.id,
      row.current_version,
    );
    const target = bytesToBlob(targetBytes);
    const current = bytesToBlob(currentBytes);
    spinner.stop();

    const diffs = compareBlobFiles(current, target);
    const modified = diffs.filter((d) => d.status === 'modified');
    const added = diffs.filter((d) => d.status === 'added');
    const removed = diffs.filter((d) => d.status === 'removed');

    if (modified.length + added.length + removed.length === 0) {
      console.log(chalk.green(`v${version} is identical to v${row.current_version}.`));
      return;
    }

    if (options.stat) {
      console.log(chalk.bold(`\n${kind} '${slug}' v${row.current_version} -> v${version}:`));
      if (modified.length) console.log(chalk.yellow(`  ${modified.length} modified`));
      if (added.length) console.log(chalk.green(`  ${added.length} added (would be restored)`));
      if (removed.length) console.log(chalk.red(`  ${removed.length} removed (would be deleted)`));
      return;
    }

    if (options.nameOnly) {
      for (const d of [...modified, ...added, ...removed]) {
        const marker = d.status === 'modified' ? 'M' : d.status === 'added' ? 'A' : 'D';
        const color =
          d.status === 'modified'
            ? chalk.yellow
            : d.status === 'added'
            ? chalk.green
            : chalk.red;
        console.log(color(`${marker}  ${d.path}`));
      }
      return;
    }

    for (const d of modified) {
      const patch = createTwoFilesPatch(
        `current: ${d.path}`,
        `v${version}: ${d.path}`,
        d.currentContent ?? '',
        d.targetContent ?? '',
        '',
        '',
        { context: 3 },
      );
      console.log(colorDiff(patch));
    }
    for (const d of added) {
      console.log(chalk.green(`\n+ Added in v${version}: ${d.path}`));
    }
    for (const d of removed) {
      console.log(chalk.red(`\n- Removed in v${version}: ${d.path}`));
    }
    console.log(
      chalk.dim(
        `\n${modified.length} modified, ${added.length} added, ${removed.length} removed`,
      ),
    );
  } catch (err: any) {
    spinner.fail(`Entity diff failed: ${err.message}`);
    process.exit(1);
  }
}

interface BlobFileDiff {
  path: string;
  status: 'modified' | 'added' | 'removed';
  currentContent?: string;
  targetContent?: string;
}

function compareBlobFiles(current: EntityBlob, target: EntityBlob): BlobFileDiff[] {
  const currentMap = new Map(current.files.map((f) => [f.rel_path, f]));
  const targetMap = new Map(target.files.map((f) => [f.rel_path, f]));
  const out: BlobFileDiff[] = [];
  for (const [p, cur] of currentMap) {
    const tgt = targetMap.get(p);
    if (!tgt) {
      out.push({ path: p, status: 'removed', currentContent: decodeEntry(cur) });
    } else if (tgt.sha256 !== cur.sha256) {
      out.push({
        path: p,
        status: 'modified',
        currentContent: decodeEntry(cur),
        targetContent: decodeEntry(tgt),
      });
    }
  }
  for (const [p, tgt] of targetMap) {
    if (!currentMap.has(p)) {
      out.push({ path: p, status: 'added', targetContent: decodeEntry(tgt) });
    }
  }
  return out;
}

function decodeEntry(entry: { content_b64: string }): string {
  return Buffer.from(entry.content_b64, 'base64').toString('utf-8');
}

async function loadV2Context(): Promise<{ cloud: CloudV2; keypair: UserKeypair }> {
  const configManager = new ConfigManager();
  if (!configManager.exists()) {
    console.error(chalk.red("Run 'configsync login' first."));
    process.exit(1);
  }
  const config = configManager.load();
  const apiUrl = (config.sync?.config?.api_url as string) ?? 'https://configsync.dev';
  const apiKey = (config.sync?.config?.api_key as string) ?? '';
  if (!apiKey) {
    console.error(chalk.red('No API key configured. Run `configsync login`.'));
    process.exit(3);
  }
  const sessionMgr = new SessionManager(configManager.configDir);
  if (!sessionMgr.exists()) {
    console.error(chalk.red("No v2 session. Run 'configsync login' first."));
    process.exit(1);
  }
  const session = sessionMgr.load();
  const cloud = new CloudV2(apiUrl, apiKey, session.machine_id);

  const password = await promptPassword('Enter master password: ');
  let keypair: UserKeypair;
  try {
    keypair = sessionMgr.unlockKeypair(password);
  } catch {
    console.error(chalk.red('Incorrect master password.'));
    process.exit(3);
  }
  return { cloud, keypair };
}

async function findEntityBySlug(
  cloud: CloudV2,
  kind: EntityKind,
  slug: string,
): Promise<EntityRow> {
  const rows =
    kind === 'project'
      ? await cloud.listProjects()
      : kind === 'workspace'
      ? await cloud.listWorkspaces()
      : kind === 'config'
      ? await cloud.listConfigs()
      : kind === 'module'
      ? await cloud.listModules()
      : ((await cloud.listProfiles()) as any[]);
  const row = rows.find((r: any) => r.slug === slug);
  if (!row) {
    console.error(chalk.red(`${kind} '${slug}' not found.`));
    process.exit(1);
  }
  return row as EntityRow;
}
