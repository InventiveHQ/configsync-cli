/**
 * Tests for `slugify` and `inspectGit`. `cloneRepo` is covered only by
 * a smoke test that verifies it shells out to `git clone` — we do not
 * make a real network request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { inspectGit, slugify } from './git-info.js';

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('turns a git URL into a short lowercase slug', () => {
    expect(slugify('git@github.com:InventiveHQ/configsync-cli.git')).toBe(
      'configsync-cli',
    );
  });

  it('strips the trailing .git', () => {
    expect(slugify('https://github.com/foo/bar-baz.git')).toBe('bar-baz');
  });

  it('works on a bare directory name', () => {
    expect(slugify('My Cool Project')).toBe('my-cool-project');
  });

  it('collapses runs of non-alphanumeric characters to a single dash', () => {
    expect(slugify('foo!!!bar???baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('---weird---')).toBe('weird');
  });

  it('lowercases uppercase input', () => {
    expect(slugify('ALLCAPS')).toBe('allcaps');
  });

  it('falls back to "project" for an empty-ish input', () => {
    expect(slugify('')).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// inspectGit: create a real temporary git repo and probe it
// ---------------------------------------------------------------------------

describe('inspectGit', () => {
  let tmpDir: string;
  let nonRepoDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configsync-git-info-'));
    nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configsync-git-info-nonrepo-'));

    // Initialise a real git repo — we avoid depending on an external
    // fixture by shelling out to git in a tmp dir.
    try {
      execSync('git init -q', { cwd: tmpDir });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir });
      execSync('git config user.name "Test"', { cwd: tmpDir });
      execSync(
        'git remote add origin https://example.com/test/sample.git',
        { cwd: tmpDir },
      );
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
      execSync('git add README.md', { cwd: tmpDir });
      execSync('git commit -q -m "initial"', { cwd: tmpDir });
    } catch {
      // If git is unavailable, the test body will detect isRepo=false
      // and skip assertions.
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(nonRepoDir, { recursive: true, force: true });
  });

  it('returns isRepo=false for a non-git directory', () => {
    const info = inspectGit(nonRepoDir);
    expect(info.isRepo).toBe(false);
  });

  it('returns git metadata for a real repo', () => {
    const info = inspectGit(tmpDir);
    if (!info.isRepo) return; // git not available; skip.
    expect(info.rootPath).toBeDefined();
    expect(info.url).toBe('https://example.com/test/sample.git');
    expect(info.branch).toMatch(/\w+/);
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// cloneRepo: mock child_process execSync so no network is touched
// ---------------------------------------------------------------------------

describe('cloneRepo (mocked)', () => {
  const realEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = realEnv;
    vi.restoreAllMocks();
  });

  it('invokes `git clone` with quoted URL and target', async () => {
    // Re-import with a mock of node:child_process.
    const calls: string[] = [];
    vi.doMock('node:child_process', () => ({
      execSync: (cmd: string) => {
        calls.push(cmd);
        return '';
      },
    }));
    const { cloneRepo } = await import('./git-info.js');
    cloneRepo('https://example.com/foo.git', '/tmp/target', 'main');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('git clone');
    expect(calls[0]).toContain('--branch');
    expect(calls[0]).toContain('"main"');
    expect(calls[0]).toContain('"https://example.com/foo.git"');
    expect(calls[0]).toContain('"/tmp/target"');
  });
});
