/**
 * Safety confirmations for destructive operations.
 *
 * Enforces tiered confirmation requirements based on the active environment,
 * with special protections for production that cannot be bypassed with --yes.
 */

import readline from 'node:readline';
import chalk from 'chalk';
import { EnvironmentDef } from './config.js';
import { EnvironmentManager } from './environment.js';

export type ConfirmationLevel = 'none' | 'prompt' | 'type-name';

/**
 * Determine the confirmation level required for an operation in the given environment.
 *
 * Rules:
 * - development: none for push/pull, prompt for pull-force
 * - staging: prompt for push/pull, type-name for pull-force
 * - production (protect: true): type-name for everything
 * - --yes flag is BLOCKED in protected environments
 */
export function getConfirmationLevel(
  env: EnvironmentDef | null,
  operation: 'push' | 'pull' | 'pull-force',
): ConfirmationLevel {
  if (!env) return 'none';

  // Protected environments always require type-name
  if (env.protect) return 'type-name';

  switch (env.tier) {
    case 'development':
      return operation === 'pull-force' ? 'prompt' : 'none';

    case 'staging':
      return operation === 'pull-force' ? 'type-name' : 'prompt';

    case 'production':
      return 'type-name';

    default:
      return 'prompt';
  }
}

/**
 * Require the appropriate confirmation for an operation.
 *
 * Returns true if confirmed, false if cancelled.
 * For 'none': always returns true.
 * For 'prompt': shows Y/n prompt (auto-yes if options.yes, unless env.protect).
 * For 'type-name': requires typing the env name to confirm.
 *
 * Escape hatch: --i-know-what-im-doing + CONFIGSYNC_ALLOW_PROD_SKIP=1
 */
export async function requireConfirmation(
  env: EnvironmentDef | null,
  operation: 'push' | 'pull' | 'pull-force',
  options: { yes?: boolean; iKnowWhatImDoing?: boolean },
): Promise<boolean> {
  const level = getConfirmationLevel(env, operation);

  if (level === 'none') return true;

  // Check if --yes is blocked in protected environments
  if (env?.protect && options.yes && !options.iKnowWhatImDoing) {
    console.error(
      chalk.red.bold('\n  --yes is blocked for protected environments.'),
    );
    console.error(
      chalk.red('  This environment requires explicit confirmation to prevent accidents.\n'),
    );
    return false;
  }

  // Escape hatch: --i-know-what-im-doing + CONFIGSYNC_ALLOW_PROD_SKIP=1
  if (options.iKnowWhatImDoing && process.env.CONFIGSYNC_ALLOW_PROD_SKIP === '1') {
    return true;
  }

  if (level === 'prompt') {
    if (options.yes) return true;
    return promptYesNo(formatSafetyWarning(env!, operation) + '\n  Continue? [Y/n] ');
  }

  if (level === 'type-name') {
    console.log(formatSafetyWarning(env!, operation));
    return promptTypeName(env!.name);
  }

  return false;
}

/**
 * Format a colored warning string about the operation in this environment.
 */
export function formatSafetyWarning(env: EnvironmentDef, operation: string): string {
  const label = env.label || EnvironmentManager.tierLabel(env.tier, env.name);
  const color = env.tier === 'production' ? chalk.red.bold : chalk.yellow.bold;

  const lines = [
    '',
    color(`  ⚠ ${operation.toUpperCase()} → ${label} (${env.name})`),
  ];

  if (env.protect) {
    lines.push(chalk.red('  This is a protected environment.'));
  }

  if (env.api_url) {
    lines.push(chalk.dim(`  Target: ${env.api_url}`));
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal prompt helpers
// ---------------------------------------------------------------------------

function promptYesNo(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(message, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

function promptTypeName(envName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      chalk.yellow(`  Type the environment name to confirm (${chalk.bold(envName)}): `),
      (answer) => {
        rl.close();
        if (answer.trim() === envName) {
          resolve(true);
        } else {
          console.error(chalk.red('  Name did not match. Operation cancelled.'));
          resolve(false);
        }
      },
    );
  });
}
