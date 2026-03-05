# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important Guidelines

- **Git Commits**: Never mention "Claude", "AI", or "assistant" in commit messages. Write commits as if you are the developer.

## Commands

### Development Setup
```bash
# Install in development mode
pip install -e .

# Install with dev dependencies
pip install -e ".[dev]"

# Install with optional dependencies
pip install -e ".[keyring]"        # Keyring provider support
pip install -e ".[onepassword]"    # 1Password integration
pip install -e ".[bitwarden]"      # Bitwarden integration
```

### Code Quality
```bash
# Format code with black
black devsync/

# Lint code with ruff
ruff devsync/

# Run tests (when implemented)
pytest
```

## Architecture

### Core Components

**DevSync** (`devsync/core.py`) - Main orchestrator that manages:
- Configuration stored in `~/.devsync/config.yaml`
- State storage in `~/.devsync/state/`
- Backup management in `~/.devsync/backups/`
- Coordination between all managers and providers

**CryptoManager** (`devsync/crypto.py`) - Handles all encryption:
- Master password protection with PBKDF2 (100,000 iterations)
- Individual secrets encrypted with key-specific salts
- Fernet encryption for config files (AES-128)
- Secure file permissions (600)

**EnvManager** (`devsync/env_manager.py`) - Manages environment files:
- Tracks `.env` and `.env.local` files per project
- Encrypts sensitive environment variables
- Handles backup and restoration

**Plugin System** (`devsync/plugin_system.py`) - Extensible architecture:
- Base class `DevSyncPlugin` for all plugins
- Auto-discovery in `examples/plugins/` directory
- Categories: ai_tool, editor, database, cloud, custom
- Each plugin implements detect(), capture(), restore()

### Secret Providers (`devsync/providers/`)

Pluggable architecture with multiple backends:
- **BuiltinProvider** - Encrypted local storage
- **KeyringProvider** - OS keychain integration
- **OnePasswordProvider** - 1Password CLI integration
- **BitwartdenProvider** - Bitwarden CLI integration

### Data Models

Key dataclasses in `core.py`:
- `GitRepo` - Repository configuration with branch tracking
- `ConfigFile` - Config file/directory to sync
- `EnvFile` - Environment file configuration

### CLI Structure (`devsync/cli.py`)

Commands follow pattern:
- `devsync <verb> [<noun>] [options]`
- Core verbs: init, push, pull, status
- Management: add, remove, list
- Secret operations: secret set/get/list

### State Management

State files stored as YAML in `~/.devsync/state/`:
- Machine-specific state tracking
- Versioned for rollback capability
- Encrypted sensitive sections