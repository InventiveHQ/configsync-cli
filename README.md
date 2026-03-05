# DeveloperSync CLI

> Sync your development environment between machines - git repos, secrets, configs, and more.

[![PyPI Version](https://img.shields.io/pypi/v/devsync)](https://pypi.org/project/devsync/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Installation

### Quick Install (from [developersync.com](https://developersync.com))

```bash
# Sign in at developersync.com and copy your personalized install command
curl -sSL https://developersync.com/install | sh -s -- --token=YOUR_TOKEN
```

### Manual Install

```bash
pip install devsync
devsync auth  # Authenticate with DeveloperSync
```

## Quick Start

```bash
# Initialize on your first machine
devsync init

# Add git repositories
devsync add repo git@github.com:you/project.git ~/projects/project

# Add environment files
devsync add env ~/projects/myapp --filename .env.local

# Add config files
devsync add config ~/.gitconfig

# Store secrets securely
devsync secret set OPENAI_API_KEY
devsync secret set GITHUB_TOKEN

# Push your state
devsync push -m "MacBook Pro setup"

# On your second machine, pull the state
devsync pull
```

## Core Features

- **🔄 Git Repository Sync** - Clone and track multiple repos with branch states
- **🔐 Secure Secrets** - Encrypted storage with multiple provider backends
- **📁 Config Management** - Sync dotfiles, tool configs, and settings
- **🌍 Environment Files** - Manage `.env` files across projects
- **🔌 Plugin System** - Extensible architecture for any tool
- **☁️ Cloud Sync** - Push/pull state via DeveloperSync cloud

## Plugin System

DeveloperSync uses a plugin architecture to support any development tool:

```bash
# Install official plugins
devsync plugin add devsync-plugins/vscode
devsync plugin add devsync-plugins/cursor

# Install community plugins
devsync plugin add github:user/devsync-plugin-custom
```

See [devsync-plugins](https://github.com/developersync/devsync-plugins) for official plugins.

## Commands

### Core Commands
- `devsync init` - Initialize DeveloperSync
- `devsync push` - Save current state
- `devsync pull` - Restore saved state
- `devsync status` - Show sync status
- `devsync diff` - Show differences

### Management Commands
- `devsync add <type>` - Add items to sync (repo/env/config)
- `devsync remove <type>` - Remove items from sync
- `devsync list` - List all tracked items

### Secret Commands
- `devsync secret set <key>` - Store a secret
- `devsync secret get <key>` - Retrieve a secret
- `devsync secret list` - List all secrets

### Plugin Commands
- `devsync plugin add <source>` - Install a plugin
- `devsync plugin list` - List installed plugins
- `devsync plugin remove <name>` - Uninstall a plugin

## Security

- Master password protection with PBKDF2 (100,000 iterations)
- AES-256 encryption for all sensitive data
- Secure cloud sync via DeveloperSync API
- Local-first architecture - works offline
- Zero-knowledge encryption available

## Documentation

- [Installation Guide](https://developersync.com/docs/install)
- [Plugin Development](https://developersync.com/docs/plugins)
- [API Reference](https://developersync.com/docs/api)
- [Security Model](https://developersync.com/docs/security)

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Support

- [Documentation](https://developersync.com/docs)
- [Discord Community](https://discord.gg/devsync)
- [GitHub Issues](https://github.com/developersync/devsync-cli/issues)

## License

MIT License - see [LICENSE](LICENSE) for details.