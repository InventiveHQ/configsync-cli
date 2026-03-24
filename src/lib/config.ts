/**
 * Configuration file management for ConfigSync.
 *
 * Handles reading, writing, and initializing the YAML-based config
 * stored in ~/.configsync/.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoConfig {
  url: string;
  path: string;
  branch?: string;
  shallow?: boolean;
  auto_pull?: boolean;
}

export interface ConfigItem {
  source: string;
  encrypt?: boolean;
  exclude_patterns?: string[];
  template?: boolean;
}

export interface EnvFileConfig {
  project_path: string;
  filename?: string;
  encrypt?: boolean;
}

export interface PackageList {
  manager: string;
  displayName: string;
  packages: string[];
}

export interface ProjectConfig {
  name: string;           // e.g. "inventivehq.com"
  path: string;           // e.g. "~/git/inventivehq.com"
  repo?: {
    url: string;
    branch: string;
  };
  secrets: string[];      // encrypted files: [".env.local", ".dev.vars", ".mcp.json"]
  configs: string[];      // regular dotfiles: [".eslintrc.json", ".env.example"]
  inject_as_env?: boolean; // if true, inject as shell env vars instead of writing .env files
}

export interface ModuleConfig {
  name: string;              // e.g. "ssh", "vscode", "claude-code"
  files: { path: string; encrypt: boolean }[];
  extras?: Record<string, any>;
}

export interface GroupConfig {
  name: string;              // e.g. "micro_sites", "configsync"
  path: string;              // e.g. "~/git/micro_sites"
  projects: ProjectConfig[]; // child projects within this group
}

export interface EnvironmentDef {
  name: string;           // "dev", "staging", "prod"
  tier: 'development' | 'staging' | 'production' | 'custom';
  label?: string;         // Display: "PRODUCTION"
  color?: string;         // hex: "#ef4444"
  api_url?: string;       // per-env API override
  api_key?: string;       // per-env key override
  protect?: boolean;      // require type-name confirmation
}

export interface MachineConfig {
  tags: string[];
  vars: Record<string, string>;
}

export interface TerminalEffects {
  background?: boolean;
  status_bar?: boolean;
}

export interface ProfileDef {
  name: string;
  environment?: string;           // auto-activate this environment when profile is active
  paths?: string[];               // auto-activate when CWD matches these paths
  vars?: Record<string, string>;  // profile-specific template vars (merged over machine.vars)
  env_overrides?: Record<string, string>; // override .env values per profile
  description?: string;           // human-readable description
}

export interface Config {
  version: string;
  profile: string;
  repos: RepoConfig[];
  configs: ConfigItem[];
  env_files: EnvFileConfig[];
  secrets: { provider: string; config: Record<string, string> };
  sync: { backend: string; config: Record<string, string> };
  packages?: PackageList[];
  projects?: ProjectConfig[];
  groups?: GroupConfig[];
  modules?: ModuleConfig[];
  machine?: MachineConfig;
  environments?: EnvironmentDef[];
  env_vars?: string[];  // explicitly tracked env var names: ["GOPATH", "JAVA_HOME", ...]
  package_exclude?: string[];
  package_mappings?: Record<string, Record<string, string>>[];
  terminal_effects?: TerminalEffects;
  profiles?: ProfileDef[];
  hooks?: {
    pre_push?: string[];
    post_push?: string[];
    pre_pull?: string[];
    post_pull?: string[];
  };
  bootstrap?: {
    script?: string;      // path to bootstrap script (default: ~/.configsync/bootstrap.sh)
    auto_run?: boolean;   // run on first pull without prompting (default: false)
  };
}

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

export class ConfigManager {
  readonly configDir: string;
  readonly configFile: string;
  readonly stateDir: string;
  readonly backupDir: string;

  constructor() {
    this.configDir = path.join(os.homedir(), '.configsync');
    this.configFile = path.join(this.configDir, 'config.yaml');
    this.stateDir = path.join(this.configDir, 'state');
    this.backupDir = path.join(this.configDir, 'backups');

    // Ensure all required directories exist
    for (const dir of [this.configDir, this.stateDir, this.backupDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Create a default configuration file and return the config object.
   */
  init(profile: string, syncBackend: string): Config {
    const config: Config = {
      version: '1.0',
      profile,
      repos: [],
      configs: [
        { source: '~/.gitconfig', encrypt: false },
        { source: '~/.zshrc', encrypt: false },
      ],
      env_files: [],
      secrets: {
        provider: 'builtin',
        config: {},
      },
      sync: {
        backend: syncBackend,
        config: {
          path: syncBackend === 'local' ? this.stateDir : '',
        },
      },
    };

    this.save(config);
    return config;
  }

  /**
   * Load and parse the YAML config file.
   * Throws if the file does not exist.
   */
  load(): Config {
    if (!fs.existsSync(this.configFile)) {
      throw new Error("Run 'configsync init' first.");
    }

    const raw = fs.readFileSync(this.configFile, 'utf-8');
    return yaml.load(raw) as Config;
  }

  /**
   * Serialize and write the config object to disk as YAML.
   */
  save(config: Config): void {
    const content = yaml.dump(config, { sortKeys: false, lineWidth: -1 });
    fs.writeFileSync(this.configFile, content, 'utf-8');
  }

  /**
   * Check whether a config file already exists on disk.
   */
  exists(): boolean {
    return fs.existsSync(this.configFile);
  }
}
