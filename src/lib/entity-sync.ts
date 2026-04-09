/**
 * The v2 entity sync engine.
 *
 * This module contains the non-UI logic for:
 *   - pulling a single project by slug onto this machine
 *   - running a full `configsync sync` that reconciles every linked
 *     entity against the server via /api/sync/plan and /api/sync/commit
 *
 * The UI / commander wiring lives in commands/pull.ts and
 * commands/sync.ts; this module is pure data flow so it can be unit
 * tested later.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
import { ConfigManager } from './config.js';
import { promptPassword } from './prompt.js';
import { CloudV2, PlanEntity, PlanResult, ProjectRow } from './cloud-v2.js';
import { SessionManager } from './session.js';
import { unwrapDEK, generateDEK, wrapDEK, UserKeypair } from './envelope-crypto.js';
import {
  EntityBlob,
  applyBlobFiles,
  blobToBytes,
  buildProjectBlob,
  bytesToBlob,
  decryptEntityBlob,
  encryptEntityBlob,
  hashBlob,
} from './entity-blob.js';
import { executeHooks } from './hooks.js';
import { captureEnvFilesFromDir } from './env-capture.js';
import { DekCache } from './dek-cache.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

async function loadCloudAndSession(configManager: ConfigManager): Promise<{
  cloud: CloudV2;
  sessionMgr: SessionManager;
}> {
  if (!configManager.exists()) {
    throw new Error("Run 'configsync init' or 'configsync login' first.");
  }
  const config = configManager.load();
  const apiUrl = (config.sync?.config?.api_url as string) ?? 'https://configsync.dev';
  const apiKey = (config.sync?.config?.api_key as string) ?? '';
  if (!apiKey) {
    throw new Error('No API key configured. Run `configsync login`.');
  }
  const sessionMgr = new SessionManager(configManager.configDir);
  if (!sessionMgr.exists()) {
    throw new Error("No v2 session found. Run 'configsync login' first.");
  }
  const machineId = sessionMgr.load().machine_id;
  return { cloud: new CloudV2(apiUrl, apiKey, machineId), sessionMgr };
}

async function unlockKeypair(sessionMgr: SessionManager): Promise<UserKeypair> {
  const password = await promptPassword('Enter master password: ');
  try {
    return sessionMgr.unlockKeypair(password);
  } catch {
    throw new Error('Incorrect master password.');
  }
}

function gitCloneIfMissing(url: string | undefined, branch: string | undefined, target: string): void {
  if (!url) return;
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const args = ['clone'];
  if (branch) args.push('--branch', branch);
  args.push(url, target);
  execFileSync('git', args, { stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Project pull
// ---------------------------------------------------------------------------

export interface PullProjectOptions {
  configManager: ConfigManager;
  projectSlug: string;
  targetPath?: string;
}

export async function pullProjectV2(opts: PullProjectOptions): Promise<void> {
  const { configManager, projectSlug, targetPath } = opts;
  const { cloud, sessionMgr } = await loadCloudAndSession(configManager);
  const keypair = await unlockKeypair(sessionMgr);

  // Find the project by slug.
  const projects = await cloud.listProjects();
  const project = projects.find((p) => p.slug === projectSlug);
  if (!project) {
    throw new Error(`Project '${projectSlug}' not found on the server.`);
  }

  // Fetch wrapped DEK from /api/projects/:id (returns wrapped_dek beside row).
  const detail = await cloud.getProject(project.id);
  if (!detail.wrapped_dek) {
    throw new Error(
      `Project '${projectSlug}' has no wrapped DEK uploaded. ` +
        'This project may have been created without encryption — unable to decrypt.',
    );
  }
  const dek = unwrapDEK(Buffer.from(detail.wrapped_dek, 'base64'), keypair);

  if (!project.current_version || project.current_version < 1) {
    console.log(chalk.yellow('Project has no versions yet; nothing to pull.'));
    return;
  }

  // Download and decrypt the current version blob.
  const ciphertext = await cloud.getProjectBlob(project.id);
  const plaintext = decryptEntityBlob(
    ciphertext,
    dek,
    'project',
    project.id,
    project.current_version,
  );
  const blob = bytesToBlob(plaintext);

  // Determine target directory: explicit --path > existing link row > default.
  let target = targetPath;
  if (!target) {
    const links = await cloud.listMachineProjects(cloud.machineId);
    const existing = links.find((l: any) => l.id === project.id);
    if (existing?.local_path) target = existing.local_path;
  }
  if (!target) {
    target = path.join(os.homedir(), 'git', project.slug);
  }
  target = resolveHome(target);

  // Clone the git repo into the target if configured and not present.
  gitCloneIfMissing(blob.git?.url ?? project.git_url ?? undefined, blob.git?.branch ?? project.git_branch ?? undefined, target);

  // Apply the decrypted file payload.
  applyBlobFiles(blob, target);
  console.log(
    chalk.green(
      `  Restored ${blob.files.length} file(s) into ${target} (project '${project.slug}' v${project.current_version})`,
    ),
  );

  // Link (or refresh link) for this machine.
  await cloud.linkMachineProject(cloud.machineId, project.id, target);

  // Update last_synced_version.
  await cloud.patchMachineProject(cloud.machineId, project.id, {
    last_synced_version: project.current_version,
    local_path: target,
  });

  console.log(chalk.green(`  Pull complete for '${project.slug}'.`));
}

// ---------------------------------------------------------------------------
// Workspace pull
// ---------------------------------------------------------------------------

export interface PullWorkspaceOptions {
  configManager: ConfigManager;
  workspaceSlug: string;
}

export async function pullWorkspaceV2(opts: PullWorkspaceOptions): Promise<void> {
  const { configManager, workspaceSlug } = opts;
  const { cloud, sessionMgr } = await loadCloudAndSession(configManager);
  const keypair = await unlockKeypair(sessionMgr);

  // Find the workspace by slug.
  const workspaces = await cloud.listWorkspaces();
  const ws = workspaces.find((w) => w.slug === workspaceSlug);
  if (!ws) {
    throw new Error(`Workspace '${workspaceSlug}' not found on the server.`);
  }

  // Fetch wrapped DEK and blob.
  const detail = await cloud.getEntity('workspace', ws.id);
  if (!detail.wrapped_dek) {
    throw new Error(`Workspace '${workspaceSlug}' has no wrapped DEK.`);
  }
  const dek = unwrapDEK(Buffer.from(detail.wrapped_dek, 'base64'), keypair);
  const ciphertext = await cloud.getEntityBlob('workspace', ws.id);
  const plaintext = decryptEntityBlob(
    ciphertext,
    dek,
    'workspace',
    ws.id,
    ws.current_version,
  );
  const blob = bytesToBlob(plaintext);

  // Extract member project IDs from the workspace blob.
  const projectIds = (blob.extras?.project_ids as number[] | undefined) ?? [];
  if (projectIds.length === 0) {
    console.log(chalk.yellow(`Workspace '${workspaceSlug}' has no member projects.`));
    return;
  }

  console.log(chalk.bold(`Pulling workspace '${workspaceSlug}' (${projectIds.length} projects)...`));

  // Pull each project.
  const projects = await cloud.listProjects();
  for (const id of projectIds) {
    const p = projects.find((x) => x.id === id);
    if (!p) {
      console.log(chalk.yellow(`  Project ID ${id} not found; skipping.`));
      continue;
    }
    console.log(chalk.cyan(`\n  --- Pulling ${p.slug} ---`));
    try {
      await pullProjectV2({
        configManager,
        projectSlug: p.slug,
      });
    } catch (err: any) {
      console.error(chalk.red(`  Failed to pull project '${p.slug}': ${err.message}`));
    }
  }

  console.log(chalk.green(`\nWorkspace '${workspaceSlug}' pull complete.`));
}

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

export interface SyncOptions {
  cloudWins?: boolean;
  localWins?: boolean;
  prompt?: boolean;
  dryRun?: boolean;
  entity?: string; // "project/<slug>" to scope
}

interface LocalProjectState {
  /** Joined machine_projects + projects row; typed loosely because
   *  the server returns the merged shape. */
  project: ProjectRow & { last_synced_version?: number; local_path?: string };
  localPath: string;
  lastSyncedVersion: number;
  /** The project's current local content, hashed. */
  localBlobBytes: Buffer;
  localHash: string;
}

async function buildLocalProjectState(
  cloud: CloudV2,
): Promise<LocalProjectState[]> {
  const links = await cloud.listMachineProjects(cloud.machineId);
  const out: LocalProjectState[] = [];
  for (const link of links) {
    const localPath = link.local_path as string | null;
    if (!localPath || !fs.existsSync(localPath)) continue;
    const blob = buildProjectBlob({
      slug: link.slug,
      rootPath: localPath,
    });
    const bytes = blobToBytes(blob);
    out.push({
      project: link as any,
      localPath,
      lastSyncedVersion: link.last_synced_version ?? 0,
      localBlobBytes: bytes,
      localHash: hashBlob(bytes),
    });
  }
  return out;
}

export async function runSync(configManager: ConfigManager, options: SyncOptions): Promise<number> {
  const { cloud, sessionMgr } = await loadCloudAndSession(configManager);
  const config = configManager.load();
  await executeHooks('pre_sync', config, { silent: options.dryRun });

  const keypair = await unlockKeypair(sessionMgr);

  // Build the per-entity local snapshot.
  const localProjects = await buildLocalProjectState(cloud);

  // Optional --entity scoping.
  const scopedLocal = options.entity
    ? localProjects.filter((lp) => `project/${lp.project.slug}` === options.entity)
    : localProjects;

  // Build the sync plan request.
  //
  // NOTE: the current implementation always sends local_version ==
  // last_synced_version. The server will return 'pull' when the cloud
  // has advanced and 'noop' when we're up to date. Outbound pushes
  // (local content changed since last sync) are not auto-detected
  // here yet — the user runs `configsync project add` / `push` to
  // explicitly push. A future enhancement will stash the "last pushed
  // hash" per entity so we can detect local drift and auto-push.
  const planEntities: PlanEntity[] = scopedLocal.map((lp) => ({
    type: 'project',
    id: lp.project.id,
    local_version: lp.lastSyncedVersion,
    local_hash: lp.localHash,
  }));

  if (planEntities.length === 0) {
    console.log(chalk.dim('Nothing linked on this machine; sync is a no-op.'));
    await executeHooks('post_sync', config, { silent: options.dryRun });
    return 0;
  }

  const actions = await cloud.syncPlan(cloud.machineId, planEntities);

  let conflicts = 0;
  const commits: { entity_type: string; entity_id: number; new_last_synced_version: number }[] = [];

  for (const action of actions) {
    const local = scopedLocal.find((lp) => lp.project.id === action.id);
    if (!local) continue;
    switch (action.action) {
      case 'noop':
        console.log(chalk.dim(`  [noop] project/${local.project.slug}`));
        break;
      case 'pull':
        if (options.dryRun) {
          console.log(chalk.cyan(`  [pull] project/${local.project.slug}`));
          break;
        }
        await applyPull(cloud, keypair, local, action);
        commits.push({
          entity_type: 'project',
          entity_id: action.id,
          new_last_synced_version: action.current_version!,
        });
        break;
      case 'push':
        if (options.dryRun) {
          console.log(chalk.cyan(`  [push] project/${local.project.slug}`));
          break;
        }
        {
          const version = await applyPush(cloud, keypair, local, action);
          commits.push({
            entity_type: 'project',
            entity_id: action.id,
            new_last_synced_version: version,
          });
        }
        break;
      case 'conflict':
        conflicts++;
        console.log(chalk.yellow(`  [conflict] project/${local.project.slug}`));
        await handleConflict(cloud, keypair, local, action, options, commits);
        break;
      case 'error':
        console.log(chalk.red(`  [error] project/${local.project.slug}: ${action.error}`));
        break;
    }
  }

  // Fail closed if there are unresolved conflicts and no strategy flag.
  const hasStrategy = options.cloudWins || options.localWins || options.prompt;
  if (conflicts > 0 && !hasStrategy) {
    console.error(
      chalk.red(
        `Sync halted: ${conflicts} conflict(s) detected. ` +
          'Re-run with --cloud-wins, --local-wins, or --prompt.',
      ),
    );
    return 2;
  }

  if (!options.dryRun && commits.length > 0) {
    await cloud.syncCommit(cloud.machineId, commits);
  }

  // Auto-capture .env* files as structured variables for every linked
  // project. This keeps the dashboard Variables tab in sync with what's
  // actually on disk without the user having to remember `vars push`.
  // Idempotent: values are upserted, not merged or deleted. Skipped in
  // dry-run mode. Failures are non-fatal — we still report sync as OK.
  if (!options.dryRun) {
    const dekCache = new DekCache(configManager.configDir);
    const userId = sessionMgr.load().user_id;
    let totalCaptured = 0;
    const capturedPerProject: { slug: string; count: number }[] = [];
    for (const lp of scopedLocal) {
      try {
        const captured = await captureEnvFilesFromDir(
          { cloud, keypair, dekCache, userId },
          lp.project.id,
          lp.localPath,
        );
        if (captured.totalVars > 0) {
          totalCaptured += captured.totalVars;
          capturedPerProject.push({ slug: lp.project.slug, count: captured.totalVars });
        }
      } catch (err: any) {
        console.log(
          chalk.yellow(
            `  Variable capture skipped for ${lp.project.slug}: ${err.message ?? err}`,
          ),
        );
      }
    }
    if (totalCaptured > 0) {
      console.log(
        chalk.green(
          `  Captured ${totalCaptured} variable(s) from .env files across ${capturedPerProject.length} project(s):`,
        ),
      );
      for (const p of capturedPerProject) {
        console.log(chalk.dim(`    ${p.slug}: ${p.count}`));
      }
    }
  }

  console.log(chalk.green(`Sync complete (${commits.length} entity updates).`));
  await executeHooks('post_sync', config, { silent: options.dryRun });
  return 0;
}

async function applyPull(
  cloud: CloudV2,
  keypair: UserKeypair,
  local: LocalProjectState,
  action: PlanResult,
): Promise<void> {
  const detail = await cloud.getProject(local.project.id);
  if (!detail.wrapped_dek) throw new Error('Project is missing wrapped DEK.');
  const dek = unwrapDEK(Buffer.from(detail.wrapped_dek, 'base64'), keypair);
  const ciphertext = await cloud.getProjectBlob(local.project.id);
  const plaintext = decryptEntityBlob(
    ciphertext,
    dek,
    'project',
    local.project.id,
    action.current_version!,
  );
  const blob = bytesToBlob(plaintext);
  applyBlobFiles(blob, local.localPath);
  console.log(
    chalk.green(
      `    pulled ${blob.files.length} file(s) -> ${local.localPath}`,
    ),
  );
}

async function applyPush(
  cloud: CloudV2,
  keypair: UserKeypair,
  local: LocalProjectState,
  action: PlanResult,
): Promise<number> {
  const detail = await cloud.getProject(local.project.id);
  let dek: Buffer;
  if (detail.wrapped_dek) {
    dek = unwrapDEK(Buffer.from(detail.wrapped_dek, 'base64'), keypair);
  } else {
    dek = generateDEK();
    const wrapped = wrapDEK(dek, keypair.publicKey);
    const userId = (detail.project as any).user_id as number;
    await cloud.upsertProjectKey(local.project.id, wrapped.toString('base64'), userId);
  }
  const nextVersion = (action.current_version ?? 0) + 1;
  const ciphertext = encryptEntityBlob(
    local.localBlobBytes,
    dek,
    'project',
    local.project.id,
    nextVersion,
  );
  const result = await cloud.pushProjectVersion(
    local.project.id,
    ciphertext.toString('base64'),
    local.localHash,
  );
  console.log(
    chalk.green(
      `    pushed project/${local.project.slug} -> v${result.version} (${result.size_bytes} bytes)`,
    ),
  );
  return result.version;
}

async function handleConflict(
  cloud: CloudV2,
  keypair: UserKeypair,
  local: LocalProjectState,
  action: PlanResult,
  options: SyncOptions,
  commits: { entity_type: string; entity_id: number; new_last_synced_version: number }[],
): Promise<void> {
  if (options.cloudWins) {
    await applyPull(cloud, keypair, local, action);
    commits.push({
      entity_type: 'project',
      entity_id: local.project.id,
      new_last_synced_version: action.current_version!,
    });
    return;
  }
  if (options.localWins) {
    const v = await applyPush(cloud, keypair, local, action);
    commits.push({ entity_type: 'project', entity_id: local.project.id, new_last_synced_version: v });
    return;
  }
  if (options.prompt && process.stdin.isTTY) {
    const answer = await prompt(
      `Conflict on project/${local.project.slug}: (c)loud wins, (l)ocal wins, (s)kip? `,
    );
    if (answer === 'c') {
      await applyPull(cloud, keypair, local, action);
      commits.push({
        entity_type: 'project',
        entity_id: local.project.id,
        new_last_synced_version: action.current_version!,
      });
    } else if (answer === 'l') {
      const v = await applyPush(cloud, keypair, local, action);
      commits.push({ entity_type: 'project', entity_id: local.project.id, new_last_synced_version: v });
    }
  }
}

function prompt(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
}
