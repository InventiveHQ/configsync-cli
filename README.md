# ConfigSync CLI

> Cross-machine sync for your development environment — projects, dotfiles, modules, env variables, and packages — with zero-knowledge encryption.

[![npm](https://img.shields.io/npm/v/@inventivehq/configsync)](https://www.npmjs.com/package/@inventivehq/configsync)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Install

```bash
npm install -g @inventivehq/configsync
```

Requires Node.js >= 18. No native dependencies.

## Quick start

```bash
# First machine — creates your keypair and default profile
configsync login --token <your-token>

# Track a project
configsync project add ~/git/my-app

# Set an environment variable
configsync vars set DATABASE_URL=postgres://... --project my-app --env dev

# Push everything to the cloud
configsync push

# On another machine — same account, same password
configsync login --token <your-token>
configsync pull --project my-app
configsync sync                          # bidirectional from here on
```

## Key concepts

### Entities

ConfigSync v2 has five user-owned entity types: **project** (a git repo + dotfiles + env declarations), **workspace** (a logical grouping of projects), **config** (a standalone dotfile like `~/.zshrc`), **module** (a tool-specific file bundle from a curated catalog — ssh, vscode, git, zsh, etc.), and **profile** (a container of workspaces, modules, and packages that activates together). Every entity is versioned and encrypted.

### Profiles

A profile bundles the content that belongs to a context. A contractor with three clients has three profiles. A solo developer has one `default` profile that holds "always installed" tools. Profiles are first-class cloud entities — portable across machines, versioned, encrypted.

### Envelope encryption

Your master password derives a KEK (PBKDF2-HMAC-SHA256, 600k iterations, server-stored salt) which unwraps an X25519 keypair. The keypair unwraps per-entity DEKs (tweetnacl sealed boxes), which decrypt content blobs (AES-256-GCM). The password never leaves the client. The server sees variable names for indexing but never sees plaintext values.

## Commands

| Command | Description |
|---------|-------------|
| `login` | Log in to ConfigSync cloud (fetches/creates keypair) |
| `init` | Initialize ConfigSync on this machine (generates keypair, creates default profile) |
| `project add\|list\|show\|rename\|delete` | Manage project entities |
| `workspace add\|list\|show\|rename\|delete\|add-project\|remove-project` | Manage workspaces |
| `config add\|list\|show\|rename\|delete` | Manage config (dotfile) entities |
| `module add\|list\|show\|delete` | Manage module entities |
| `profile add\|list\|show\|rename\|delete\|add-workspace\|remove-workspace\|add-package\|remove-package\|activate\|deactivate` | Manage profile entities |
| `vars set\|unset\|list\|render\|push` | Structured per-project env variables |
| `env list\|create\|activate\|deactivate\|current\|shell\|hook\|delete\|vars` | Environment tiers (dev/staging/prod) |
| `sync` | Bidirectional per-entity 3-way sync with conflict resolution |
| `pull` | Materialize entities onto the local machine |
| `push` | Push current state to sync backend |
| `history` | Per-entity version history and whole-state snapshots |
| `diff` | Compare local state against a historical entity version |
| `rollback` | Roll an entity or snapshot back to a previous version |
| `watch` | Auto-sync on file changes (debounced) |
| `status` | Show current sync status |
| `list` | Show all tracked items by type |
| `doctor` | Diagnose common local-state problems |
| `scan` | Scan for installed packages and save to sync state |

Run `configsync <command> --help` for full flag documentation.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `CONFIGSYNC_MASTER_PASSWORD` | Master password for non-interactive use (CI, scripts) |
| `CONFIGSYNC_MASTER_PASSWORD_FILE` | Path to a file containing the master password |
| `CONFIGSYNC_PROFILE` | Override the active profile for the current session |
| `CONFIGSYNC_ENV` | Override the active environment tier for the current session |

## Links

- [Documentation](https://configsync.dev/docs) — user-facing docs with command examples
- [Architecture](https://configsync.dev/docs/architecture) — conceptual model and crypto design
- [GitHub Issues](https://github.com/InventiveHQ/configsync-cli/issues) — bug reports and feature requests
- [Discord](https://discord.gg/configsync) — community support

## License

MIT License — see [LICENSE](LICENSE) for details.
