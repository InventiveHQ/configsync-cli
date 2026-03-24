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
  {
    name: 'wrangler',
    displayName: 'Wrangler (Cloudflare)',
    description: 'Cloudflare Wrangler CLI config and authentication',
    detect: () => {
      // Wrangler stores config in ~/.wrangler or via `wrangler` command
      const wranglerDir = path.join(os.homedir(), '.wrangler');
      const configDir = path.join(os.homedir(), '.config', '.wrangler');
      let cmdExists = false;
      try {
        execSync('wrangler --version', { stdio: 'pipe', timeout: 5000 });
        cmdExists = true;
      } catch {}
      return fs.existsSync(wranglerDir) || fs.existsSync(configDir) || cmdExists;
    },
    getFiles: () => {
      const files: ModuleFile[] = [];

      // Auth config (contains OAuth tokens — must encrypt)
      const wranglerDir = path.join(os.homedir(), '.wrangler');
      const configDir = path.join(os.homedir(), '.config', '.wrangler');

      // Wrangler stores auth in different places depending on version
      const authPaths = [
        '.wrangler/config/default.toml',
        '.config/.wrangler/config/default.toml',
      ];
      for (const p of authPaths) {
        const full = path.join(os.homedir(), p);
        if (fs.existsSync(full)) {
          files.push(homeFile(p, true));  // encrypt — contains OAuth tokens
        }
      }

      // Also check for legacy wrangler.toml in home (global config)
      if (fs.existsSync(path.join(os.homedir(), '.wrangler.toml'))) {
        files.push(homeFile('.wrangler.toml', true));
      }

      return files;
    },
  },
  {
    name: 'aws',
    displayName: 'AWS CLI',
    description: 'AWS CLI config and credentials',
    detect: () => fs.existsSync(path.join(os.homedir(), '.aws')),
    getFiles: () => [
      homeFile('.aws/config', false),
      homeFile('.aws/credentials', true),  // encrypt — contains secret keys
    ],
  },
  {
    name: 'npm',
    displayName: 'npm',
    description: 'npm config and auth tokens',
    detect: () => fs.existsSync(path.join(os.homedir(), '.npmrc')),
    getFiles: () => [
      homeFile('.npmrc', true),  // encrypt — may contain auth tokens
    ],
  },
  {
    name: 'docker',
    displayName: 'Docker',
    description: 'Docker config and auth',
    detect: () => fs.existsSync(path.join(os.homedir(), '.docker')),
    getFiles: () => [
      homeFile('.docker/config.json', true),  // encrypt — contains registry auth
    ],
  },
  {
    name: 'iterm2',
    displayName: 'iTerm2',
    description: 'iTerm2 preferences and profiles',
    detect: () => os.platform() === 'darwin' && fs.existsSync(path.join(os.homedir(), 'Library', 'Preferences', 'com.googlecode.iterm2.plist')),
    getFiles: () => {
      const plist = path.join(os.homedir(), 'Library', 'Preferences', 'com.googlecode.iterm2.plist');
      return [{
        path: plist,
        relative: '~/Library/Preferences/com.googlecode.iterm2.plist',
        encrypt: false,
        exists: fs.existsSync(plist),
      }];
    },
  },
  {
    name: 'alacritty',
    displayName: 'Alacritty',
    description: 'Alacritty terminal config',
    detect: () =>
      fs.existsSync(path.join(os.homedir(), '.config', 'alacritty', 'alacritty.toml'))
      || fs.existsSync(path.join(os.homedir(), '.config', 'alacritty', 'alacritty.yml')),
    getFiles: () => [
      homeFile('.config/alacritty/alacritty.toml', false),
      homeFile('.config/alacritty/alacritty.yml', false),
    ],
  },
  {
    name: 'tmux',
    displayName: 'tmux',
    description: 'tmux configuration',
    detect: () =>
      fs.existsSync(path.join(os.homedir(), '.tmux.conf'))
      || fs.existsSync(path.join(os.homedir(), '.config', 'tmux', 'tmux.conf')),
    getFiles: () => [
      homeFile('.tmux.conf', false),
      homeFile('.config/tmux/tmux.conf', false),
    ],
  },
  {
    name: 'sublime',
    displayName: 'Sublime Text',
    description: 'Sublime Text preferences and keybindings',
    detect: () => {
      if (os.platform() === 'darwin') {
        return fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'Sublime Text', 'Packages', 'User'));
      }
      return fs.existsSync(path.join(os.homedir(), '.config', 'sublime-text', 'Packages', 'User'));
    },
    getFiles: () => {
      if (os.platform() === 'darwin') {
        return [
          appSupportFile('Sublime Text/Packages/User/Preferences.sublime-settings', false),
          appSupportFile('Sublime Text/Packages/User/Default (OSX).sublime-keymap', false),
        ];
      }
      return [
        homeFile('.config/sublime-text/Packages/User/Preferences.sublime-settings', false),
        homeFile('.config/sublime-text/Packages/User/Default (Linux).sublime-keymap', false),
      ];
    },
  },
  {
    name: 'jetbrains',
    displayName: 'JetBrains IDEs',
    description: 'IdeaVim config and global settings',
    detect: () => fs.existsSync(path.join(os.homedir(), '.ideavimrc')),
    getFiles: () => [
      homeFile('.ideavimrc', false),
    ],
  },
  {
    name: 'starship',
    displayName: 'Starship',
    description: 'Starship prompt configuration',
    detect: () => fs.existsSync(path.join(os.homedir(), '.config', 'starship.toml')),
    getFiles: () => [
      homeFile('.config/starship.toml', false),
    ],
  },
  {
    name: 'homebrew',
    displayName: 'Homebrew',
    description: 'Homebrew Brewfile for reproducible installs',
    detect: () => {
      try {
        execSync('brew --version', { stdio: 'pipe', timeout: 5000 });
        return true;
      } catch { return false; }
    },
    getFiles: () => [
      homeFile('.Brewfile', false),
    ],
    getExtras: () => {
      try {
        const output = execSync('brew bundle dump --file=- --no-upgrade 2>/dev/null', {
          encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
        });
        return { brewfile: output };
      } catch {
        return { brewfile: '' };
      }
    },
  },
  {
    name: 'karabiner',
    displayName: 'Karabiner-Elements',
    description: 'Karabiner keyboard customization (macOS)',
    detect: () => os.platform() === 'darwin' && fs.existsSync(path.join(os.homedir(), '.config', 'karabiner', 'karabiner.json')),
    getFiles: () => [
      homeFile('.config/karabiner/karabiner.json', false),
    ],
  },
  {
    name: 'bat',
    displayName: 'bat',
    description: 'bat (cat alternative) configuration',
    detect: () => fs.existsSync(path.join(os.homedir(), '.config', 'bat', 'config')),
    getFiles: () => [
      homeFile('.config/bat/config', false),
    ],
  },
  {
    name: 'gpg',
    displayName: 'GPG',
    description: 'GPG configuration and agent settings',
    detect: () => fs.existsSync(path.join(os.homedir(), '.gnupg')),
    getFiles: () => [
      homeFile('.gnupg/gpg.conf', true),
      homeFile('.gnupg/gpg-agent.conf', true),
    ],
  },
  {
    name: 'raycast',
    displayName: 'Raycast',
    description: 'Raycast launcher settings (macOS)',
    detect: () => os.platform() === 'darwin' && fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'com.raycast.macos')),
    getFiles: () => {
      const dir = path.join(os.homedir(), 'Library', 'Application Support', 'com.raycast.macos');
      const files: ModuleFile[] = [];
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.json') || f.endsWith('.plist')) {
            const full = path.join(dir, f);
            if (fs.statSync(full).isFile()) {
              files.push({
                path: full,
                relative: `~/Library/Application Support/com.raycast.macos/${f}`,
                encrypt: false,
                exists: true,
              });
            }
          }
        }
      }
      return files;
    },
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
