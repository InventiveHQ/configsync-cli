/**
 * Tests for `passwordFromEnv()` — the CI/automation env var resolver.
 *
 * The `promptPassword()` function itself is harder to test in isolation
 * because it manipulates `process.stdin`. These tests cover the env var
 * branch, which is the path used in CI.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { passwordFromEnv } from './prompt.js';

// ---------------------------------------------------------------------------
// Env var helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'CONFIGSYNC_MASTER_PASSWORD',
  'CONFIGSYNC_MASTER_PASSWORD_FILE',
] as const;

let savedEnv: Record<string, string | undefined> = {};
const tmpFiles: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const p of tmpFiles) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  tmpFiles.length = 0;
});

function writeTmp(content: string): string {
  const file = path.join(
    os.tmpdir(),
    `configsync-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  fs.writeFileSync(file, content);
  tmpFiles.push(file);
  return file;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('passwordFromEnv', () => {
  it('returns null when neither env var is set', () => {
    expect(passwordFromEnv()).toBeNull();
  });

  it('returns the verbatim value from CONFIGSYNC_MASTER_PASSWORD', () => {
    process.env.CONFIGSYNC_MASTER_PASSWORD = 'correct horse battery staple';
    expect(passwordFromEnv()).toBe('correct horse battery staple');
  });

  it('falls through when CONFIGSYNC_MASTER_PASSWORD is the empty string', () => {
    process.env.CONFIGSYNC_MASTER_PASSWORD = '';
    expect(passwordFromEnv()).toBeNull();
  });

  it('reads the file named by CONFIGSYNC_MASTER_PASSWORD_FILE', () => {
    const file = writeTmp('filepassword');
    process.env.CONFIGSYNC_MASTER_PASSWORD_FILE = file;
    expect(passwordFromEnv()).toBe('filepassword');
  });

  it('trims a single trailing LF from the password file', () => {
    const file = writeTmp('hunter2\n');
    process.env.CONFIGSYNC_MASTER_PASSWORD_FILE = file;
    expect(passwordFromEnv()).toBe('hunter2');
  });

  it('trims a trailing CRLF from the password file', () => {
    const file = writeTmp('hunter2\r\n');
    process.env.CONFIGSYNC_MASTER_PASSWORD_FILE = file;
    expect(passwordFromEnv()).toBe('hunter2');
  });

  it('does not strip internal whitespace from the password file', () => {
    const file = writeTmp('   spaced password   ');
    process.env.CONFIGSYNC_MASTER_PASSWORD_FILE = file;
    expect(passwordFromEnv()).toBe('   spaced password   ');
  });

  it('throws a clear error when the password file does not exist', () => {
    process.env.CONFIGSYNC_MASTER_PASSWORD_FILE = path.join(
      os.tmpdir(),
      `configsync-nonexistent-${Date.now()}.txt`,
    );
    expect(() => passwordFromEnv()).toThrow(
      /CONFIGSYNC_MASTER_PASSWORD_FILE is set but cannot be read/,
    );
  });

  it('prefers CONFIGSYNC_MASTER_PASSWORD over CONFIGSYNC_MASTER_PASSWORD_FILE', () => {
    const file = writeTmp('from-file');
    process.env.CONFIGSYNC_MASTER_PASSWORD = 'from-env';
    process.env.CONFIGSYNC_MASTER_PASSWORD_FILE = file;
    expect(passwordFromEnv()).toBe('from-env');
  });
});
