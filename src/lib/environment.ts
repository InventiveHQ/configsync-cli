/**
 * Environment management for ConfigSync.
 *
 * Resolves which environment (dev, staging, prod, etc.) is currently active
 * and manages activation/deactivation state files.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EnvironmentDef, Config } from './config.js';

const ENV_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name) && name.length <= 64;
}

const TIER_COLORS: Record<string, string> = {
  development: '#22c55e',
  staging: '#eab308',
  production: '#ef4444',
  custom: '#06b6d4',
};

export class EnvironmentManager {
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), '.configsync');
  }

  /**
   * Resolve the active environment name from (priority order):
   * 1. Explicit name passed in (from --env flag)
   * 2. CONFIGSYNC_ENV env var
   * 3. .configsync-env file in CWD (direnv-style)
   * 4. ~/.configsync/active-env file (persistent activation)
   */
  resolve(explicit?: string): string | null {
    if (explicit) {
      return explicit;
    }

    const fromEnv = process.env.CONFIGSYNC_ENV;
    if (fromEnv) {
      return fromEnv;
    }

    const localFile = path.join(process.cwd(), '.configsync-env');
    if (fs.existsSync(localFile)) {
      const content = fs.readFileSync(localFile, 'utf-8').trim();
      if (content) return content;
    }

    const activeFile = path.join(this.configDir, 'active-env');
    if (fs.existsSync(activeFile)) {
      const content = fs.readFileSync(activeFile, 'utf-8').trim();
      if (content) return content;
    }

    return null;
  }

  /**
   * Get the full EnvironmentDef for the active environment.
   */
  getActive(config: Config, explicit?: string): EnvironmentDef | null {
    const name = this.resolve(explicit);
    if (!name) return null;

    const envs = config.environments || [];
    return envs.find((e) => e.name === name) || null;
  }

  /**
   * Write activation files to persist the active environment.
   * Writes ~/.configsync/active-env (plain text env name)
   * Writes ~/.configsync/active-env-tier (plain text tier)
   */
  activate(env: EnvironmentDef): void {
    if (!isValidEnvName(env.name)) {
      throw new Error(`Invalid environment name: ${env.name}`);
    }
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(path.join(this.configDir, 'active-env'), env.name, 'utf-8');
    fs.writeFileSync(path.join(this.configDir, 'active-env-tier'), env.tier, 'utf-8');
  }

  /**
   * Clear activation files.
   */
  deactivate(): void {
    const activeEnv = path.join(this.configDir, 'active-env');
    const activeTier = path.join(this.configDir, 'active-env-tier');

    if (fs.existsSync(activeEnv)) fs.unlinkSync(activeEnv);
    if (fs.existsSync(activeTier)) fs.unlinkSync(activeTier);
  }

  /**
   * Get the default color for a tier.
   */
  static tierColor(tier: string): string {
    return TIER_COLORS[tier] || TIER_COLORS.custom;
  }

  /**
   * Get the default label for a tier.
   */
  static tierLabel(tier: string, name: string): string {
    switch (tier) {
      case 'production':
        return 'PRODUCTION';
      case 'staging':
        return 'STAGING';
      case 'development':
        return 'DEV';
      default:
        return name.toUpperCase();
    }
  }
}
