/**
 * Bootstrap script support for first-pull automation.
 * Runs a user-defined script on the first pull to a new machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import type { Config, ConfigManager } from './config.js';

export interface BootstrapResult {
  ran: boolean;
  exitCode: number | null;
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

/**
 * Check if bootstrap has already been run on this machine.
 */
export function hasBootstrapped(stateDir: string): boolean {
  return fs.existsSync(path.join(stateDir, 'bootstrap-done'));
}

/**
 * Mark bootstrap as complete for this machine.
 */
export function markBootstrapped(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'bootstrap-done'), new Date().toISOString());
}

/**
 * Run the bootstrap script if it exists and hasn't been run yet.
 */
export async function runBootstrapIfNeeded(
  config: Config,
  configManager: ConfigManager,
  options?: { force?: boolean; autoApprove?: boolean },
): Promise<BootstrapResult> {
  // Find the bootstrap script
  const scriptPath = config.bootstrap?.script
    ? path.resolve(config.bootstrap.script.replace(/^~/, require('os').homedir()))
    : path.join(configManager.configDir, 'bootstrap.sh');

  if (!fs.existsSync(scriptPath)) {
    return { ran: false, exitCode: null };
  }

  // Check if already bootstrapped (unless forced)
  if (!options?.force && hasBootstrapped(configManager.stateDir)) {
    return { ran: false, exitCode: null };
  }

  // Prompt unless auto_run or autoApprove
  const autoRun = config.bootstrap?.auto_run || options?.autoApprove;
  if (!autoRun) {
    console.log(chalk.bold(`\n  Bootstrap script found: ${scriptPath}`));
    const proceed = await confirm('  Run bootstrap script? [y/N] ');
    if (!proceed) {
      return { ran: false, exitCode: null };
    }
  }

  console.log(chalk.dim(`\n  Running bootstrap script: ${scriptPath}`));

  try {
    execSync(scriptPath, {
      stdio: 'inherit',
      timeout: 600000, // 10 minute timeout
      shell: process.env.SHELL || '/bin/sh',
    });
    markBootstrapped(configManager.stateDir);
    return { ran: true, exitCode: 0 };
  } catch (err: any) {
    const exitCode = err.status ?? 1;
    throw new Error(`Bootstrap script exited with code ${exitCode}`);
  }
}
