/**
 * Lifecycle hooks for push/pull operations.
 * Users define hooks in config.yaml that run before/after sync operations.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import type { Config } from './config.js';

export type HookName =
  | 'pre_push'
  | 'post_push'
  | 'pre_pull'
  | 'post_pull'
  | 'pre_sync'
  | 'post_sync';

export interface HookOptions {
  continueOnError?: boolean;
  silent?: boolean;
  env?: string;
  profile?: string;
}

function resolveHome(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

/**
 * Check if any hooks are defined for a given hook name.
 */
export function hasHooks(hookName: HookName, config: Config): boolean {
  return (config.hooks?.[hookName]?.length ?? 0) > 0;
}

/**
 * Execute all hooks for a given hook name.
 * Pre-hooks throw on failure (aborting the operation).
 * Post-hooks warn on failure but continue.
 */
export async function executeHooks(
  hookName: HookName,
  config: Config,
  options?: HookOptions,
): Promise<void> {
  const commands = config.hooks?.[hookName];
  if (!commands || commands.length === 0) return;

  const continueOnError = options?.continueOnError ?? hookName.startsWith('post_');

  if (!options?.silent) {
    console.log(chalk.dim(`  Running ${hookName} hooks...`));
  }

  const hookEnv = {
    ...process.env,
    CONFIGSYNC_HOOK: hookName,
    ...(options?.env ? { CONFIGSYNC_ENV: options.env } : {}),
    ...(options?.profile ? { CONFIGSYNC_PROFILE: options.profile } : {}),
  };

  for (const cmd of commands) {
    const resolved = resolveHome(cmd);
    try {
      execSync(resolved, {
        stdio: options?.silent ? 'pipe' : 'inherit',
        env: hookEnv,
        timeout: 300000, // 5 minute timeout per hook
        shell: process.env.SHELL || '/bin/sh',
      });
    } catch (err: any) {
      const exitCode = err.status ?? 'unknown';
      if (continueOnError) {
        if (!options?.silent) {
          console.log(chalk.yellow(`  Warning: ${hookName} hook failed (exit ${exitCode}): ${cmd}`));
        }
      } else {
        throw new Error(`${hookName} hook failed (exit ${exitCode}): ${cmd}`);
      }
    }
  }
}
