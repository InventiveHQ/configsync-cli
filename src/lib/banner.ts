/**
 * CLI banner rendering for environment indicators.
 *
 * Displays a colored, full-width banner showing the active environment
 * so operators always know which env they are targeting.
 */

import chalk from 'chalk';
import { EnvironmentDef } from './config.js';
import { EnvironmentManager } from './environment.js';

type ChalkFn = (text: string) => string;

function tierChalk(tier: string): ChalkFn {
  switch (tier) {
    case 'production':
      return chalk.bgRed.white.bold;
    case 'staging':
      return chalk.bgYellow.black.bold;
    case 'development':
      return chalk.bgGreen.black;
    default:
      return chalk.bgCyan.black;
  }
}

/**
 * Render a full-width colored banner for the active environment.
 *
 * Example output:
 * ```
 * ┌─────────────────────────────────────┐
 * │  ■ PRODUCTION — configsync.dev      │
 * └─────────────────────────────────────┘
 * ```
 */
export function renderBanner(env: EnvironmentDef): string {
  const width = process.stdout.columns || 80;
  const colorize = tierChalk(env.tier);
  const label = env.label || EnvironmentManager.tierLabel(env.tier, env.name);
  const suffix = env.api_url ? ` — ${env.api_url}` : '';
  const content = `  ■ ${label}${suffix}  `;

  const innerWidth = width - 2; // account for │ on each side
  const padded = content.padEnd(innerWidth);

  const top = `┌${'─'.repeat(innerWidth)}┐`;
  const middle = `│${colorize(padded)}│`;
  const bottom = `└${'─'.repeat(innerWidth)}┘`;

  return `${top}\n${middle}\n${bottom}`;
}
