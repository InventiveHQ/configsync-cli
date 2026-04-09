/**
 * v2 `project` command group.
 *
 *   configsync project add <path> [--name <slug>] [--git-url <url>] [--git-branch <branch>]
 *   configsync project list
 *   configsync project show <slug>
 *   configsync project rename <old> <new>
 *   configsync project delete <slug>
 *
 * The headline operation is `project add`: register a project as a
 * first-class entity, capture its tracked files into an encrypted
 * blob, and link it to this machine.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { ConfigManager } from '../lib/config.js';
import { promptPassword } from '../lib/prompt.js';
import { CloudV2, ProjectRow } from '../lib/cloud-v2.js';
import { SessionManager } from '../lib/session.js';
import {
  generateDEK,
  wrapDEK,
  unwrapDEK,
  UserKeypair,
} from '../lib/envelope-crypto.js';
import {
  buildProjectBlob,
  blobToBytes,
  hashBlob,
  encryptEntityBlob,
} from '../lib/entity-blob.js';
import { inspectGit, slugify } from '../lib/git-info.js';
import { captureEnvFilesFromDir } from '../lib/env-capture.js';
import { DekCache } from '../lib/dek-cache.js';

export function registerProjectCommand(program: Command): void {
  const cmd = program
    .command('project')
    .description('Manage projects (v2 entity)');

  cmd
    .command('add <dir>')
    .description('Register a project and push an initial version')
    .option('--name <slug>', 'project slug (defaults to directory name)')
    .option('--git-url <url>', 'override detected git remote URL')
    .option('--git-branch <branch>', 'override detected git branch')
    .action(async (dir: string, options: { name?: string; gitUrl?: string; gitBranch?: string }) => {
      await addProject(path.resolve(dir), options);
    });

  cmd
    .command('list')
    .description('List projects')
    .action(async () => {
      const cloud = await loadCloud();
      const projects = await cloud.listProjects();
      if (projects.length === 0) {
        console.log(chalk.dim('No projects yet.'));
        return;
      }
      for (const p of projects) {
        console.log(
          `${chalk.cyan(p.slug.padEnd(30))} v${p.current_version}  ${
            p.git_url ?? ''
          }`,
        );
      }
    });

  cmd
    .command('show <slug>')
    .description('Show a project')
    .action(async (slug: string) => {
      const cloud = await loadCloud();
      const projects = await cloud.listProjects();
      const p = projects.find((x) => x.slug === slug);
      if (!p) {
        console.error(chalk.red(`Project '${slug}' not found.`));
        process.exit(1);
      }
      console.log(JSON.stringify(p, null, 2));
    });

  cmd
    .command('rename <oldSlug> <newName>')
    .description('Rename a project')
    .action(async (oldSlug: string, newName: string) => {
      const cloud = await loadCloud();
      const p = (await cloud.listProjects()).find((x) => x.slug === oldSlug);
      if (!p) {
        console.error(chalk.red(`Project '${oldSlug}' not found.`));
        process.exit(1);
      }
      // Use PATCH via raw fetch (only name is mutable; slug stays stable).
      const res = await fetch(`${cloud.apiUrl}/api/projects/${p.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${cloud.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) {
        console.error(chalk.red(`Rename failed: ${res.status} ${res.statusText}`));
        process.exit(1);
      }
      console.log(chalk.green(`Project renamed: ${oldSlug} -> ${newName}`));
    });

  cmd
    .command('delete <slug>')
    .description('Soft-delete a project')
    .option('--force', 'skip confirmation')
    .action(async (slug: string, options: { force?: boolean }) => {
      const cloud = await loadCloud();
      const p = (await cloud.listProjects()).find((x) => x.slug === slug);
      if (!p) {
        console.error(chalk.red(`Project '${slug}' not found.`));
        process.exit(1);
      }
      if (!options.force) {
        console.error(chalk.yellow(`Re-run with --force to delete project '${slug}'.`));
        process.exit(2);
      }
      const res = await fetch(`${cloud.apiUrl}/api/projects/${p.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cloud.apiKey}` },
      });
      if (!res.ok) {
        console.error(chalk.red(`Delete failed: ${res.status} ${res.statusText}`));
        process.exit(1);
      }
      console.log(chalk.green(`Project '${slug}' deleted.`));
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadCloud(): Promise<CloudV2> {
  const configManager = new ConfigManager();
  if (!configManager.exists()) {
    console.error(chalk.red("Run 'configsync init' or 'configsync login' first."));
    process.exit(1);
  }
  const config = configManager.load();
  const apiUrl = (config.sync?.config?.api_url as string) ?? 'https://configsync.dev';
  const apiKey = (config.sync?.config?.api_key as string) ?? '';
  if (!apiKey) {
    console.error(chalk.red('No API key configured. Run `configsync login`.'));
    process.exit(3);
  }
  const session = new SessionManager(configManager.configDir);
  const machineId = session.exists() ? session.load().machine_id : CloudV2.generateMachineId();
  return new CloudV2(apiUrl, apiKey, machineId);
}

export async function addProject(
  rootDir: string,
  options: { name?: string; gitUrl?: string; gitBranch?: string },
): Promise<ProjectRow> {
  const configManager = new ConfigManager();
  const sessionMgr = new SessionManager(configManager.configDir);
  if (!sessionMgr.exists()) {
    console.error(chalk.red("No v2 session. Run 'configsync login' first."));
    process.exit(1);
  }

  // Detect git info from the target directory.
  const gitInfo = inspectGit(rootDir);
  const slug =
    options.name ??
    (gitInfo.url ? slugify(gitInfo.url) : slugify(path.basename(rootDir)));
  const gitUrl = options.gitUrl ?? gitInfo.url;
  const gitBranch = options.gitBranch ?? gitInfo.branch ?? 'main';

  // Unlock the keypair once.
  const password = await promptPassword('Enter master password: ');
  let keypair: UserKeypair;
  try {
    keypair = sessionMgr.unlockKeypair(password);
  } catch {
    console.error(chalk.red('Incorrect master password.'));
    process.exit(3);
  }

  const cloud = await loadCloud();

  // Check whether this git_url is already a known project (dedupe hint).
  let project: ProjectRow | null = null;
  if (gitUrl) {
    const matches = await cloud.listProjects({ git_url: gitUrl });
    if (matches.length > 0) project = matches[0];
  }
  if (!project) {
    try {
      project = await cloud.createProject({
        slug,
        name: slug,
        git_url: gitUrl,
        git_branch: gitBranch,
      });
      console.log(chalk.green(`Created project '${project.slug}' (id=${project.id})`));
    } catch (err: any) {
      // Fallback dedupe: another project already owns this slug (e.g. created
      // without a git_url, so the git_url query above missed it). Look it up
      // by slug and reuse rather than failing the whole flow.
      if (err?.message && /already exists/i.test(err.message)) {
        const all = await cloud.listProjects();
        const bySlug = all.find((p) => p.slug === slug);
        if (!bySlug) throw err;
        project = bySlug;
        console.log(chalk.dim(`Reusing existing project '${project.slug}' (id=${project.id})`));
      } else {
        throw err;
      }
    }
  } else {
    console.log(chalk.dim(`Reusing existing project '${project.slug}' (id=${project.id})`));
  }

  // Fetch fresh server state (includes wrapped_dek and current_version).
  const existing = await cloud.getProject(project.id);
  project = existing.project;
  let dek: Buffer;
  if (existing.wrapped_dek) {
    console.log(chalk.dim('  Project already has a DEK; reusing it.'));
    dek = unwrapDEK(Buffer.from(existing.wrapped_dek, 'base64'), keypair);
  } else {
    dek = generateDEK();
    const wrapped = wrapDEK(dek, keypair.publicKey);
    await cloud.upsertProjectKey(
      project.id,
      wrapped.toString('base64'),
      sessionMgr.load().user_id,
    );
    console.log(chalk.dim('  Wrapped DEK uploaded'));
  }

  // Build the blob, encrypt, push a new version.
  const blob = buildProjectBlob({
    slug: project.slug,
    rootPath: rootDir,
    gitUrl: gitUrl ?? undefined,
    gitBranch: gitBranch ?? undefined,
    gitCommit: gitInfo.commit,
  });
  const bytes = blobToBytes(blob);
  const nextVersion = (project.current_version ?? 0) + 1;
  const ciphertext = encryptEntityBlob(bytes, dek, 'project', project.id, nextVersion);
  const pushResult = await cloud.pushProjectVersion(
    project.id,
    ciphertext.toString('base64'),
    hashBlob(bytes),
  );
  console.log(chalk.green(`  Pushed version v${pushResult.version} (${pushResult.size_bytes} bytes)`));

  // Link to this machine.
  await cloud.linkMachineProject(cloud.machineId, project.id, rootDir);
  console.log(chalk.green(`  Linked to machine ${cloud.machineId}`));

  // Auto-capture .env* files as structured variables so the dashboard
  // Variables tab is populated without a separate `vars push` step.
  // Idempotent upsert — re-running refreshes values but does not delete.
  try {
    const dekCache = new DekCache(configManager.configDir);
    const captured = await captureEnvFilesFromDir(
      { cloud, keypair, dekCache, userId: sessionMgr.load().user_id },
      project.id,
      rootDir,
    );
    if (captured.totalVars > 0) {
      console.log(
        chalk.green(`  Captured ${captured.totalVars} variable(s) from .env files:`),
      );
      for (const f of captured.files) {
        console.log(
          chalk.dim(
            `    ${f.file} → ${f.tier}/${f.visibility} (${f.count} var${f.count !== 1 ? 's' : ''})`,
          ),
        );
      }
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Variable capture skipped: ${err.message ?? err}`));
  }

  return project;
}
