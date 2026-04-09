/**
 * Helpers for inspecting a local git checkout (used by `project add`).
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

export interface GitInfo {
  isRepo: boolean;
  url?: string;
  branch?: string;
  commit?: string;
  rootPath?: string;
}

function run(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

export function inspectGit(dir: string): GitInfo {
  const rootPath = run('git rev-parse --show-toplevel', dir);
  if (!rootPath) return { isRepo: false };
  const url = run('git config --get remote.origin.url', rootPath) ?? undefined;
  const branch = run('git rev-parse --abbrev-ref HEAD', rootPath) ?? undefined;
  const commit = run('git rev-parse HEAD', rootPath) ?? undefined;
  return { isRepo: true, rootPath, url, branch, commit };
}

/** Derive a reasonable slug from a directory name or git URL. */
export function slugify(input: string): string {
  const base = input
    .replace(/\.git$/, '')
    .split(/[/\\]/)
    .filter(Boolean)
    .pop() ?? 'project';
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

export function cloneRepo(url: string, target: string, branch?: string): void {
  const branchArg = branch ? ` --branch ${JSON.stringify(branch)}` : '';
  execSync(`git clone${branchArg} ${JSON.stringify(url)} ${JSON.stringify(target)}`, {
    stdio: 'inherit',
  });
}

export { path as _path };
