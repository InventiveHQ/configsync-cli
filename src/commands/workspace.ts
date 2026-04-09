/**
 * v2 `workspace` command group.
 *
 *   configsync workspace list
 *   configsync workspace show <slug>
 *   configsync workspace add <name> [--description <text>]
 *   configsync workspace rename <old> <new>
 *   configsync workspace delete <slug> [--force]
 *   configsync workspace add-project <workspace-slug> <project-slug>
 *   configsync workspace remove-project <workspace-slug> <project-slug>
 *
 * Mirrors the structure of `project.ts`.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../lib/config.js';
import { promptPassword } from '../lib/prompt.js';
import { CloudV2, EntityRow } from '../lib/cloud-v2.js';
import { SessionManager } from '../lib/session.js';
import {
  generateDEK,
  wrapDEK,
  unwrapDEK,
  UserKeypair,
} from '../lib/envelope-crypto.js';
import {
  blobToBytes,
  bytesToBlob,
  hashBlob,
  encryptEntityBlob,
  decryptEntityBlob,
  EntityBlob,
} from '../lib/entity-blob.js';
import { slugify } from '../lib/git-info.js';

export function registerWorkspaceCommand(program: Command): void {
  const cmd = program
    .command('workspace')
    .description('Manage workspaces (v2 entity)');

  cmd
    .command('list')
    .description('List workspaces')
    .action(async () => {
      const { cloud } = await loadCtx(false);
      const rows = await cloud.listWorkspaces();
      if (rows.length === 0) {
        console.log(chalk.dim('No workspaces yet.'));
        return;
      }
      for (const w of rows) {
        console.log(
          `${chalk.cyan(w.slug.padEnd(30))} v${w.current_version}  ${w.name}`,
        );
      }
    });

  cmd
    .command('show <slug>')
    .description('Show a workspace and its member projects')
    .action(async (slug: string) => {
      const ctx = await loadCtx(true);
      const ws = await findWorkspace(ctx.cloud, slug);
      console.log(chalk.bold(ws.slug) + chalk.dim(`  (id=${ws.id}, v${ws.current_version})`));
      if (ws.description) console.log(chalk.dim(ws.description));

      // Decrypt the blob and enumerate project_ids from extras.
      try {
        const blob = await fetchAndDecryptBlob(ctx, 'workspace', ws);
        const ids = (blob.extras?.project_ids as number[] | undefined) ?? [];
        if (ids.length === 0) {
          console.log(chalk.dim('  no member projects'));
          return;
        }
        const projects = await ctx.cloud.listProjects();
        console.log(chalk.bold('\nMember projects:'));
        for (const id of ids) {
          const p = projects.find((x) => x.id === id);
          console.log(`  - ${p ? chalk.cyan(p.slug) : chalk.dim(`(deleted id=${id})`)}`);
        }
      } catch (err: any) {
        console.error(chalk.yellow(`  (could not decrypt blob: ${err.message})`));
      }
    });

  cmd
    .command('add <name>')
    .description('Create a new workspace and push an empty initial version')
    .option('--description <text>', 'optional description')
    .action(async (name: string, opts: { description?: string }) => {
      const ctx = await loadCtx(true);
      const slug = slugify(name);
      const ws = await ctx.cloud.createWorkspace({ slug, name, description: opts.description });
      console.log(chalk.green(`Created workspace '${ws.slug}' (id=${ws.id})`));

      const dek = generateDEK();
      const wrapped = wrapDEK(dek, ctx.keypair.publicKey);
      await ctx.cloud.upsertEntityKey('workspace', ws.id, wrapped.toString('base64'), ctx.userId);

      // Build an empty initial blob with an empty project_ids list.
      const blob: EntityBlob = {
        schema_version: 1,
        entity_type: 'workspace',
        slug: ws.slug,
        captured_at: new Date().toISOString(),
        files: [],
        extras: { project_ids: [] },
      };
      const bytes = blobToBytes(blob);
      const ct = encryptEntityBlob(bytes, dek, 'workspace', ws.id, 1);
      await ctx.cloud.pushEntityVersion(
        'workspace',
        ws.id,
        ct.toString('base64'),
        hashBlob(bytes),
      );
      console.log(chalk.green('  Pushed v1 (empty)'));
    });

  cmd
    .command('rename <oldSlug> <newName>')
    .description('Rename a workspace')
    .action(async (oldSlug: string, newName: string) => {
      const ctx = await loadCtx(false);
      const ws = await findWorkspace(ctx.cloud, oldSlug);
      await ctx.cloud.patchEntity('workspace', ws.id, { name: newName, slug: slugify(newName) });
      console.log(chalk.green(`Workspace renamed: ${oldSlug} -> ${newName}`));
    });

  cmd
    .command('delete <slug>')
    .description('Soft-delete a workspace')
    .option('--force', 'skip confirmation')
    .action(async (slug: string, opts: { force?: boolean }) => {
      const ctx = await loadCtx(false);
      if (!opts.force) {
        console.error(chalk.yellow(`Re-run with --force to delete workspace '${slug}'.`));
        process.exit(2);
      }
      const ws = await findWorkspace(ctx.cloud, slug);
      await ctx.cloud.deleteEntity('workspace', ws.id);
      console.log(chalk.green(`Workspace '${slug}' deleted.`));
    });

  cmd
    .command('add-project <workspaceSlug> <projectSlug>')
    .description('Add a project to a workspace')
    .action(async (workspaceSlug: string, projectSlug: string) => {
      await mutateWorkspaceProjectList(workspaceSlug, projectSlug, 'add');
    });

  cmd
    .command('remove-project <workspaceSlug> <projectSlug>')
    .description('Remove a project from a workspace')
    .action(async (workspaceSlug: string, projectSlug: string) => {
      await mutateWorkspaceProjectList(workspaceSlug, projectSlug, 'remove');
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Ctx {
  cloud: CloudV2;
  keypair: UserKeypair;
  userId: number;
  sessionMgr: SessionManager;
}

async function loadCtx(unlock: boolean): Promise<Ctx> {
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

  let keypair: UserKeypair;
  if (unlock) {
    const password = await promptPassword('Enter master password: ');
    try {
      keypair = sessionMgr.unlockKeypair(password);
    } catch {
      console.error(chalk.red('Incorrect master password.'));
      process.exit(3);
    }
  } else {
    keypair = { publicKey: Buffer.alloc(0), privateKey: Buffer.alloc(0) };
  }

  return { cloud, keypair, userId: session.user_id, sessionMgr };
}

async function findWorkspace(cloud: CloudV2, slug: string): Promise<EntityRow> {
  const rows = await cloud.listWorkspaces();
  const ws = rows.find((x) => x.slug === slug);
  if (!ws) {
    console.error(chalk.red(`Workspace '${slug}' not found.`));
    process.exit(1);
  }
  return ws;
}

async function fetchAndDecryptBlob(
  ctx: Ctx,
  entity: 'workspace',
  row: EntityRow,
): Promise<EntityBlob> {
  const info = await ctx.cloud.getEntity(entity, row.id);
  if (!info.wrapped_dek) {
    throw new Error(`No wrapped DEK for ${entity} ${row.slug}`);
  }
  const dek = unwrapDEK(Buffer.from(info.wrapped_dek, 'base64'), ctx.keypair);
  const ciphertext = await ctx.cloud.getEntityBlob(entity, row.id);
  const bytes = decryptEntityBlob(ciphertext, dek, entity, row.id, row.current_version);
  return bytesToBlob(bytes);
}

export async function mutateWorkspaceProjectList(
  workspaceSlug: string,
  projectSlug: string,
  op: 'add' | 'remove',
): Promise<void> {
  const ctx = await loadCtx(true);
  const ws = await findWorkspace(ctx.cloud, workspaceSlug);
  const project = (await ctx.cloud.listProjects()).find((p) => p.slug === projectSlug);
  if (!project) {
    console.error(chalk.red(`Project '${projectSlug}' not found.`));
    process.exit(1);
  }

  const info = await ctx.cloud.getEntity('workspace', ws.id);
  if (!info.wrapped_dek) {
    console.error(chalk.red(`Workspace '${workspaceSlug}' has no wrapped DEK.`));
    process.exit(1);
  }
  const dek = unwrapDEK(Buffer.from(info.wrapped_dek, 'base64'), ctx.keypair);

  const ct = await ctx.cloud.getEntityBlob('workspace', ws.id);
  const bytes = decryptEntityBlob(ct, dek, 'workspace', ws.id, ws.current_version);
  const blob = bytesToBlob(bytes);

  const ids = new Set<number>((blob.extras?.project_ids as number[] | undefined) ?? []);
  if (op === 'add') {
    if (ids.has(project.id)) {
      console.log(chalk.dim(`Project '${projectSlug}' already in workspace.`));
      return;
    }
    ids.add(project.id);
  } else {
    if (!ids.has(project.id)) {
      console.log(chalk.dim(`Project '${projectSlug}' not in workspace.`));
      return;
    }
    ids.delete(project.id);
  }

  const newBlob: EntityBlob = {
    ...blob,
    extras: { ...(blob.extras ?? {}), project_ids: Array.from(ids) },
    captured_at: new Date().toISOString(),
  };
  const newBytes = blobToBytes(newBlob);
  const nextVersion = (ws.current_version ?? 0) + 1;
  const newCt = encryptEntityBlob(newBytes, dek, 'workspace', ws.id, nextVersion);
  const pushed = await ctx.cloud.pushEntityVersion(
    'workspace',
    ws.id,
    newCt.toString('base64'),
    hashBlob(newBytes),
  );
  console.log(
    chalk.green(
      `${op === 'add' ? 'Added' : 'Removed'} '${projectSlug}' ${op === 'add' ? 'to' : 'from'} '${workspaceSlug}' (v${pushed.version})`,
    ),
  );
}
