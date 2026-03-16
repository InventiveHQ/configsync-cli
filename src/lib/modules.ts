/**
 * Built-in modules for common development tools.
 * Each module knows where to find its config files on each OS.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

export interface ModuleFile {
  path: string;       // resolved absolute path
  relative: string;   // display path (with ~)
  encrypt: boolean;
  exists: boolean;
}

export interface ModuleInfo {
  name: string;
  displayName: string;
  description: string;
  detected: boolean;
  files: ModuleFile[];
  extras?: Record<string, any>;  // module-specific data (e.g. extension list)
}

type ModuleDef = {
  name: string;
  displayName: string;
  description: string;
  detect: () => boolean;
  getFiles: () => ModuleFile[];
  getExtras?: () => Record<string, any>;
};

function homeFile(relative: string, encrypt: boolean): ModuleFile {
  const resolved = path.join(os.homedir(), relative);
  return {
    path: resolved,
    relative: `~/${relative}`,
    encrypt,
    exists: fs.existsSync(resolved),
  };
}

function appSupportFile(appPath: string, encrypt: boolean): ModuleFile {
  const platform = os.platform();
  let base: string;
  if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else if (platform === 'win32') {
    base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else {
    base = path.join(os.homedir(), '.config');
  }
  const resolved = path.join(base, appPath);
  const display = platform === 'darwin'
    ? `~/Library/Application Support/${appPath}`
    : platform === 'win32'
    ? `%APPDATA%/${appPath}`
    : `~/.config/${appPath}`;
  return { path: resolved, relative: display, encrypt, exists: fs.existsSync(resolved) };
}

const modules: ModuleDef[] = [
  {
    name: 'ssh',
    displayName: 'SSH',
    description: 'SSH keys, config, and known hosts',
    detect: () => fs.existsSync(path.join(os.homedir(), '.ssh')),
    getFiles: () => {
      const sshDir = path.join(os.homedir(), '.ssh');
      const files: ModuleFile[] = [
        homeFile('.ssh/config', true),
        homeFile('.ssh/known_hosts', false),
      ];

      // Find key files (id_*, but not .pub)
      if (fs.existsSync(sshDir)) {
        for (const f of fs.readdirSync(sshDir)) {
          if (f.startsWith('id_') && !f.endsWith('.pub')) {
            files.push(homeFile(`.ssh/${f}`, true));     // private key — encrypt
            const pubFile = `${f}.pub`;
            if (fs.existsSync(path.join(sshDir, pubFile))) {
              files.push(homeFile(`.ssh/${pubFile}`, false)); // public key — no encrypt
            }
          }
        }
      }

      return files;
    },
  },
  {
    name: 'vscode',
    displayName: 'VS Code',
    description: 'Settings, keybindings, snippets, and extension list',
    detect: () => {
      const platform = os.platform();
      if (platform === 'darwin') {
        return fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'));
      } else if (platform === 'win32') {
        return fs.existsSync(path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json'));
      }
      return fs.existsSync(path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json'));
    },
    getFiles: () => [
      appSupportFile('Code/User/settings.json', false),
      appSupportFile('Code/User/keybindings.json', false),
      appSupportFile('Code/User/snippets', false),
    ],
    getExtras: () => {
      try {
        const output = execSync('code --list-extensions', {
          encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
        });
        return {
          extensions: output.trim().split('\n').filter(Boolean),
        };
      } catch {
        return { extensions: [] };
      }
    },
  },
  {
    name: 'claude-desktop',
    displayName: 'Claude Desktop',
    description: 'Claude Desktop app config and MCP servers',
    detect: () => {
      return fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'Claude'))
        || fs.existsSync(path.join(os.homedir(), '.config', 'Claude'));
    },
    getFiles: () => [
      appSupportFile('Claude/claude_desktop_config.json', true),
      appSupportFile('Claude/settings.json', false),
    ],
  },
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    description: 'Claude Code CLI settings, credentials, and project memory',
    detect: () => fs.existsSync(path.join(os.homedir(), '.claude')),
    getFiles: () => {
      const files: ModuleFile[] = [
        homeFile('.claude/settings.json', false),
        homeFile('.claude/credentials.json', true),
        homeFile('.claude/keybindings.json', false),
      ];

      // CLAUDE.md in home
      if (fs.existsSync(path.join(os.homedir(), 'CLAUDE.md'))) {
        files.push(homeFile('CLAUDE.md', false));
      }

      // MCP config
      if (fs.existsSync(path.join(os.homedir(), '.mcp.json'))) {
        files.push(homeFile('.mcp.json', true));
      }

      return files;
    },
  },
  {
    name: 'git',
    displayName: 'Git',
    description: 'Global git config and ignore patterns',
    detect: () => fs.existsSync(path.join(os.homedir(), '.gitconfig')),
    getFiles: () => [
      homeFile('.gitconfig', false),
      homeFile('.gitignore_global', false),
    ],
  },
  {
    name: 'zsh',
    displayName: 'Zsh',
    description: 'Zsh config, aliases, and Oh My Zsh',
    detect: () => fs.existsSync(path.join(os.homedir(), '.zshrc')),
    getFiles: () => [
      homeFile('.zshrc', false),
      homeFile('.zprofile', false),
      homeFile('.zshenv', false),
      homeFile('.aliases', false),
    ],
  },
  {
    name: 'vim',
    displayName: 'Vim/Neovim',
    description: 'Vim and Neovim configuration',
    detect: () =>
      fs.existsSync(path.join(os.homedir(), '.vimrc'))
      || fs.existsSync(path.join(os.homedir(), '.config', 'nvim')),
    getFiles: () => [
      homeFile('.vimrc', false),
      homeFile('.config/nvim/init.lua', false),
      homeFile('.config/nvim/init.vim', false),
    ],
  },
  {
    name: 'cursor',
    displayName: 'Cursor',
    description: 'Cursor IDE settings and extensions',
    detect: () => {
      const platform = os.platform();
      if (platform === 'darwin') {
        return fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'));
      }
      return fs.existsSync(path.join(os.homedir(), '.config', 'Cursor', 'User', 'settings.json'));
    },
    getFiles: () => [
      appSupportFile('Cursor/User/settings.json', false),
      appSupportFile('Cursor/User/keybindings.json', false),
    ],
  },
];

export function listModules(): ModuleInfo[] {
  return modules.map(m => ({
    name: m.name,
    displayName: m.displayName,
    description: m.description,
    detected: m.detect(),
    files: m.detect() ? m.getFiles().filter(f => f.exists) : [],
    extras: m.detect() && m.getExtras ? m.getExtras() : undefined,
  }));
}

export function getModule(name: string): ModuleInfo | null {
  const m = modules.find(mod => mod.name === name.toLowerCase());
  if (!m) return null;
  return {
    name: m.name,
    displayName: m.displayName,
    description: m.description,
    detected: m.detect(),
    files: m.getFiles(),
    extras: m.getExtras ? m.getExtras() : undefined,
  };
}

export function getAvailableModuleNames(): string[] {
  return modules.map(m => m.name);
}
