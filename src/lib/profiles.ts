/**
 * Profile management for ConfigSync.
 *
 * Resolves which profile is currently active via multiple resolution strategies
 * (explicit flag, env var, directory markers, session file, path matching)
 * and manages activation/deactivation state files.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProfileDef, Config, MachineConfig } from './config.js';

export class ProfileManager {
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), '.configsync');
  }

  /**
   * Resolve the active profile name from (priority order):
   * 1. Explicit name passed in (from --profile flag)
   * 2. CONFIGSYNC_PROFILE env var
   * 3. .configsync-profile file in CWD or parent directories (walk up)
   * 4. ~/.configsync/active-profile file (session override from `profile switch`)
   * 5. Path-based matching from profile `paths` config
   * 6. null (no active profile)
   */
  resolve(config: Config, explicit?: string): string | null {
    if (explicit) {
      return explicit;
    }

    const fromEnv = process.env.CONFIGSYNC_PROFILE;
    if (fromEnv) {
      return fromEnv;
    }

    // Walk up from CWD looking for .configsync-profile
    let dir = process.cwd();
    while (true) {
      const file = path.join(dir, '.configsync-profile');
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf-8').trim();
        if (content) return content;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // Session override
    const activeFile = path.join(this.configDir, 'active-profile');
    if (fs.existsSync(activeFile)) {
      const content = fs.readFileSync(activeFile, 'utf-8').trim();
      if (content) return content;
    }

    // Path-based matching: check CWD against profile paths
    const cwd = process.cwd();
    const profiles = config.profiles || [];
    for (const profile of profiles) {
      for (const p of profile.paths || []) {
        const resolved = path.resolve(p.replace(/^~/, os.homedir()));
        if (cwd.startsWith(resolved)) return profile.name;
      }
    }

    return null;
  }

  /**
   * Get the full ProfileDef for the active profile.
   */
  getActive(config: Config, explicit?: string): ProfileDef | null {
    const name = this.resolve(config, explicit);
    if (!name) return null;

    const profiles = config.profiles || [];
    return profiles.find((p) => p.name === name) || null;
  }

  /**
   * Write session activation file.
   */
  activate(profileName: string): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(path.join(this.configDir, 'active-profile'), profileName, 'utf-8');
  }

  /**
   * Clear session activation.
   */
  deactivate(): void {
    const file = path.join(this.configDir, 'active-profile');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  /**
   * Merge profile vars with machine vars. Profile wins on conflict.
   * Returns a merged MachineConfig-compatible object for template rendering.
   */
  static mergeVars(
    machine?: MachineConfig,
    profile?: ProfileDef | null,
  ): { tags: string[]; vars: Record<string, string> } {
    const base = {
      tags: [...(machine?.tags || [])],
      vars: { ...(machine?.vars || {}) },
    };
    if (profile?.vars) {
      Object.assign(base.vars, profile.vars);
    }
    return base;
  }

  /**
   * Apply profile env_overrides on top of existing env vars.
   * Returns merged vars (original + overrides).
   */
  static applyEnvOverrides(
    vars: Record<string, string>,
    profile?: ProfileDef | null,
  ): Record<string, string> {
    if (!profile?.env_overrides) return vars;
    return { ...vars, ...profile.env_overrides };
  }

  /**
   * Get the environment name that should be auto-activated for this profile.
   */
  getProfileEnvironment(config: Config, explicit?: string): string | null {
    const profile = this.getActive(config, explicit);
    return profile?.environment || null;
  }
}
