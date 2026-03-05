"""DevSync Core Plugins Bundle

This module contains all built-in plugins that ship with DevSync.
Users can override these by placing their own versions in ~/.devsync/plugins/
"""

from typing import List, Type
from ..plugin_system import DevSyncPlugin

# Import all built-in plugins
from .claude import ClaudePlugin

# List of built-in plugin classes
builtin_plugins: List[Type[DevSyncPlugin]] = [
    ClaudePlugin,
    # CursorPlugin,  # Using YAML version instead
    # VSCodePlugin,
    # GeminiPlugin,
    # HomebrewPlugin,
    # ChocolateyPlugin,
    # AptPlugin,
]

# Plugin categories
PLUGIN_CATEGORIES = {
    "ai_tool": [
        "claude",
        "cursor",
        "vscode-copilot",
        "gemini",
        "jetbrains-ai",
        "windsurf",
        "cody",
        "tabnine",
        "codewhisperer"
    ],
    "editor": [
        "vscode",
        "vim",
        "neovim",
        "emacs",
        "sublime-text",
        "atom",
        "brackets",
        "notepad-plus-plus"
    ],
    "browser": [
        "arc",
        "chrome",
        "firefox",
        "safari",
        "edge",
        "brave",
        "vivaldi"
    ],
    "terminal": [
        "iterm2",
        "hyper",
        "wezterm",
        "alacritty",
        "kitty",
        "windows-terminal"
    ],
    "database": [
        "tableplus",
        "datagrip",
        "dbeaver",
        "sequel-pro",
        "postico",
        "mongodb-compass"
    ],
    "cloud": [
        "aws-cli",
        "gcloud",
        "azure-cli",
        "doctl",
        "heroku-cli"
    ],
    "container": [
        "docker",
        "podman",
        "rancher",
        "kubernetes",
        "minikube"
    ],
    "package_manager": [
        "homebrew",
        "chocolatey",
        "apt",
        "yum",
        "dnf",
        "pacman",
        "npm",
        "pip",
        "cargo"
    ],
    "productivity": [
        "obsidian",
        "notion",
        "linear",
        "raycast",
        "alfred",
        "1password",
        "bitwarden"
    ],
    "communication": [
        "slack",
        "discord",
        "teams",
        "zoom",
        "telegram"
    ]
}

# Core plugins that should always be loaded
CORE_PLUGINS = [
    "claude",
    "cursor",
    "vscode",
    "homebrew",
    "chocolatey",
    "apt"
]

# Plugin dependencies
PLUGIN_DEPENDENCIES = {
    "vscode-copilot": ["vscode"],
    "claude": ["npm"],  # For MCP servers
    "cursor": ["npm"],
    "docker-compose": ["docker"]
}


def get_plugin_category(plugin_name: str) -> str:
    """Get the category of a plugin"""
    for category, plugins in PLUGIN_CATEGORIES.items():
        if plugin_name in plugins:
            return category
    return "custom"


def get_recommended_plugins(os_type: str) -> List[str]:
    """Get recommended plugins for the current OS"""
    base_plugins = [
        "claude",
        "cursor",
        "vscode",
        "git",
        "docker"
    ]

    if os_type == "darwin":
        return base_plugins + [
            "homebrew",
            "iterm2",
            "arc",
            "raycast"
        ]
    elif os_type == "windows":
        return base_plugins + [
            "chocolatey",
            "windows-terminal",
            "powertoys"
        ]
    else:  # Linux
        return base_plugins + [
            "apt",  # or yum/dnf based on distro
            "alacritty",
            "firefox"
        ]