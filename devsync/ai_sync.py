"""Universal AI Tools Synchronization - Claude, Cursor, Codex, Gemini, and more"""

import json
import os
import platform
import shutil
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime
import subprocess


class AIToolsSync:
    """Unified synchronization for all AI coding assistants"""

    def __init__(self, crypto_manager):
        self.crypto = crypto_manager
        self.os_type = platform.system().lower()
        self.ai_configs = self._detect_ai_tools()

    def _detect_ai_tools(self) -> Dict[str, Dict]:
        """Detect installed AI tools and their config locations"""
        tools = {}

        # Claude Desktop
        claude_config = self._get_claude_paths()
        if claude_config["app_exists"] or claude_config["mcp_exists"]:
            tools["claude"] = claude_config

        # Cursor AI
        cursor_config = self._get_cursor_paths()
        if cursor_config["app_exists"]:
            tools["cursor"] = cursor_config

        # VS Code with GitHub Copilot
        vscode_config = self._get_vscode_paths()
        if vscode_config["app_exists"]:
            tools["vscode"] = vscode_config

        # Gemini (Google AI Studio / Project IDX)
        gemini_config = self._get_gemini_paths()
        if gemini_config["exists"]:
            tools["gemini"] = gemini_config

        # JetBrains AI Assistant
        jetbrains_config = self._get_jetbrains_paths()
        if jetbrains_config["exists"]:
            tools["jetbrains"] = jetbrains_config

        # Windsurf (Codeium)
        windsurf_config = self._get_windsurf_paths()
        if windsurf_config["exists"]:
            tools["windsurf"] = windsurf_config

        return tools

    def _get_claude_paths(self) -> Dict:
        """Get Claude Desktop configuration paths"""
        paths = {
            "app_exists": False,
            "mcp_exists": False,
            "paths": {}
        }

        if self.os_type == 'darwin':
            paths["paths"] = {
                "app_support": Path.home() / "Library/Application Support/Claude",
                "mcp_config": Path.home() / ".mcp.json",
                "settings": Path.home() / "Library/Application Support/Claude/settings.json",
                "permissions": Path.home() / "Library/Application Support/Claude/permissions.json"
            }
        elif self.os_type == 'windows':
            paths["paths"] = {
                "app_support": Path(os.environ['APPDATA']) / "Claude",
                "mcp_config": Path.home() / ".mcp.json",
                "settings": Path(os.environ['APPDATA']) / "Claude/settings.json",
                "permissions": Path(os.environ['APPDATA']) / "Claude/permissions.json"
            }
        else:  # Linux
            paths["paths"] = {
                "app_support": Path.home() / ".config/Claude",
                "mcp_config": Path.home() / ".mcp.json",
                "settings": Path.home() / ".config/Claude/settings.json",
                "permissions": Path.home() / ".config/Claude/permissions.json"
            }

        paths["app_exists"] = paths["paths"]["app_support"].exists()
        paths["mcp_exists"] = paths["paths"]["mcp_config"].exists()

        return paths

    def _get_cursor_paths(self) -> Dict:
        """Get Cursor AI configuration paths"""
        paths = {
            "app_exists": False,
            "paths": {}
        }

        if self.os_type == 'darwin':
            paths["paths"] = {
                "app_support": Path.home() / "Library/Application Support/Cursor",
                "settings": Path.home() / "Library/Application Support/Cursor/User/settings.json",
                "keybindings": Path.home() / "Library/Application Support/Cursor/User/keybindings.json",
                "extensions": Path.home() / ".cursor/extensions",
                "workspace_storage": Path.home() / "Library/Application Support/Cursor/User/workspaceStorage",
                "snippets": Path.home() / "Library/Application Support/Cursor/User/snippets",
                "ai_settings": Path.home() / "Library/Application Support/Cursor/User/globalStorage/cursor-ai"
            }
        elif self.os_type == 'windows':
            paths["paths"] = {
                "app_support": Path(os.environ['APPDATA']) / "Cursor",
                "settings": Path(os.environ['APPDATA']) / "Cursor/User/settings.json",
                "keybindings": Path(os.environ['APPDATA']) / "Cursor/User/keybindings.json",
                "extensions": Path.home() / ".cursor/extensions",
                "workspace_storage": Path(os.environ['APPDATA']) / "Cursor/User/workspaceStorage",
                "snippets": Path(os.environ['APPDATA']) / "Cursor/User/snippets",
                "ai_settings": Path(os.environ['APPDATA']) / "Cursor/User/globalStorage/cursor-ai"
            }
        else:  # Linux
            paths["paths"] = {
                "app_support": Path.home() / ".config/Cursor",
                "settings": Path.home() / ".config/Cursor/User/settings.json",
                "keybindings": Path.home() / ".config/Cursor/User/keybindings.json",
                "extensions": Path.home() / ".cursor/extensions",
                "workspace_storage": Path.home() / ".config/Cursor/User/workspaceStorage",
                "snippets": Path.home() / ".config/Cursor/User/snippets",
                "ai_settings": Path.home() / ".config/Cursor/User/globalStorage/cursor-ai"
            }

        paths["app_exists"] = paths["paths"]["app_support"].exists()

        return paths

    def _get_vscode_paths(self) -> Dict:
        """Get VS Code with GitHub Copilot configuration paths"""
        paths = {
            "app_exists": False,
            "paths": {}
        }

        if self.os_type == 'darwin':
            paths["paths"] = {
                "app_support": Path.home() / "Library/Application Support/Code",
                "settings": Path.home() / "Library/Application Support/Code/User/settings.json",
                "keybindings": Path.home() / "Library/Application Support/Code/User/keybindings.json",
                "extensions": Path.home() / ".vscode/extensions",
                "copilot": Path.home() / "Library/Application Support/Code/User/globalStorage/github.copilot",
                "copilot_chat": Path.home() / "Library/Application Support/Code/User/globalStorage/github.copilot-chat"
            }
        elif self.os_type == 'windows':
            paths["paths"] = {
                "app_support": Path(os.environ['APPDATA']) / "Code",
                "settings": Path(os.environ['APPDATA']) / "Code/User/settings.json",
                "keybindings": Path(os.environ['APPDATA']) / "Code/User/keybindings.json",
                "extensions": Path.home() / ".vscode/extensions",
                "copilot": Path(os.environ['APPDATA']) / "Code/User/globalStorage/github.copilot",
                "copilot_chat": Path(os.environ['APPDATA']) / "Code/User/globalStorage/github.copilot-chat"
            }
        else:  # Linux
            paths["paths"] = {
                "app_support": Path.home() / ".config/Code",
                "settings": Path.home() / ".config/Code/User/settings.json",
                "keybindings": Path.home() / ".config/Code/User/keybindings.json",
                "extensions": Path.home() / ".vscode/extensions",
                "copilot": Path.home() / ".config/Code/User/globalStorage/github.copilot",
                "copilot_chat": Path.home() / ".config/Code/User/globalStorage/github.copilot-chat"
            }

        paths["app_exists"] = paths["paths"]["app_support"].exists()

        return paths

    def _get_gemini_paths(self) -> Dict:
        """Get Gemini/Google AI configuration paths"""
        paths = {
            "exists": False,
            "paths": {}
        }

        # Gemini configurations (Project IDX, AI Studio)
        paths["paths"] = {
            "gcloud_config": Path.home() / ".config/gcloud",
            "idx_config": Path.home() / ".idx",
            "ai_studio": Path.home() / ".google-ai-studio",
            "credentials": Path.home() / ".config/gcloud/application_default_credentials.json",
            "project_settings": Path.home() / ".config/gcloud/configurations"
        }

        paths["exists"] = any(p.exists() for p in paths["paths"].values())

        return paths

    def _get_jetbrains_paths(self) -> Dict:
        """Get JetBrains AI Assistant configuration paths"""
        paths = {
            "exists": False,
            "paths": {}
        }

        # JetBrains IDEs store configs in version-specific directories
        jetbrains_base = None
        if self.os_type == 'darwin':
            jetbrains_base = Path.home() / "Library/Application Support/JetBrains"
        elif self.os_type == 'windows':
            jetbrains_base = Path(os.environ['APPDATA']) / "JetBrains"
        else:  # Linux
            jetbrains_base = Path.home() / ".config/JetBrains"

        if jetbrains_base and jetbrains_base.exists():
            paths["paths"] = {
                "base": jetbrains_base,
                "ai_assistant": jetbrains_base / "AIAssistant",
                "idea": list(jetbrains_base.glob("IntelliJIdea*")),
                "pycharm": list(jetbrains_base.glob("PyCharm*")),
                "webstorm": list(jetbrains_base.glob("WebStorm*")),
                "goland": list(jetbrains_base.glob("GoLand*"))
            }
            paths["exists"] = True

        return paths

    def _get_windsurf_paths(self) -> Dict:
        """Get Windsurf (Codeium) configuration paths"""
        paths = {
            "exists": False,
            "paths": {}
        }

        if self.os_type == 'darwin':
            paths["paths"] = {
                "app_support": Path.home() / "Library/Application Support/Windsurf",
                "settings": Path.home() / "Library/Application Support/Windsurf/User/settings.json",
                "codeium_config": Path.home() / ".codeium/config.json"
            }
        elif self.os_type == 'windows':
            paths["paths"] = {
                "app_support": Path(os.environ['APPDATA']) / "Windsurf",
                "settings": Path(os.environ['APPDATA']) / "Windsurf/User/settings.json",
                "codeium_config": Path.home() / ".codeium/config.json"
            }
        else:  # Linux
            paths["paths"] = {
                "app_support": Path.home() / ".config/Windsurf",
                "settings": Path.home() / ".config/Windsurf/User/settings.json",
                "codeium_config": Path.home() / ".codeium/config.json"
            }

        paths["exists"] = any(p.exists() for p in paths["paths"].values())

        return paths

    def capture_all_ai_configs(self) -> Dict:
        """Capture configurations from all detected AI tools"""
        configs = {
            "timestamp": datetime.now().isoformat(),
            "tools": {}
        }

        for tool_name, tool_config in self.ai_configs.items():
            print(f"Capturing {tool_name} configuration...")

            if tool_name == "claude":
                configs["tools"]["claude"] = self._capture_claude()
            elif tool_name == "cursor":
                configs["tools"]["cursor"] = self._capture_cursor()
            elif tool_name == "vscode":
                configs["tools"]["vscode"] = self._capture_vscode()
            elif tool_name == "gemini":
                configs["tools"]["gemini"] = self._capture_gemini()
            elif tool_name == "jetbrains":
                configs["tools"]["jetbrains"] = self._capture_jetbrains()
            elif tool_name == "windsurf":
                configs["tools"]["windsurf"] = self._capture_windsurf()

        return configs

    def _capture_claude(self) -> Dict:
        """Capture Claude-specific configurations"""
        config = {"files": {}}
        paths = self.ai_configs["claude"]["paths"]

        for name, path in paths.items():
            if path.exists() and path.is_file():
                with open(path, 'rb') as f:
                    content = f.read()
                    # Encrypt sensitive files
                    if name in ["mcp_config", "permissions"]:
                        content = self.crypto.encrypt(content)
                    config["files"][name] = content.hex()

        return config

    def _capture_cursor(self) -> Dict:
        """Capture Cursor AI configurations"""
        config = {
            "settings": {},
            "extensions": [],
            "ai_context": {}
        }

        paths = self.ai_configs["cursor"]["paths"]

        # Capture settings
        if paths["settings"].exists():
            with open(paths["settings"]) as f:
                config["settings"] = json.load(f)

        # Capture installed extensions
        if paths["extensions"].exists():
            extensions = []
            for ext_dir in paths["extensions"].iterdir():
                if ext_dir.is_dir():
                    package_json = ext_dir / "package.json"
                    if package_json.exists():
                        with open(package_json) as f:
                            pkg = json.load(f)
                            extensions.append({
                                "id": pkg.get("name", ext_dir.name),
                                "version": pkg.get("version"),
                                "publisher": pkg.get("publisher")
                            })
            config["extensions"] = extensions

        # Capture AI-specific settings
        if paths["ai_settings"].exists():
            # Cursor stores AI context in SQLite databases
            for db_file in paths["ai_settings"].glob("*.db"):
                config["ai_context"][db_file.name] = self._extract_cursor_ai_data(db_file)

        return config

    def _extract_cursor_ai_data(self, db_path: Path) -> Dict:
        """Extract AI context from Cursor's SQLite database"""
        data = {
            "conversations": [],
            "indexed_files": [],
            "custom_instructions": []
        }

        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()

            # Get table names
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = cursor.fetchall()

            # Extract relevant data (structure varies by Cursor version)
            for table in tables:
                table_name = table[0]
                if "conversation" in table_name.lower():
                    cursor.execute(f"SELECT * FROM {table_name} LIMIT 100")
                    data["conversations"] = cursor.fetchall()
                elif "index" in table_name.lower():
                    cursor.execute(f"SELECT * FROM {table_name} LIMIT 100")
                    data["indexed_files"] = cursor.fetchall()

            conn.close()
        except Exception as e:
            print(f"Error reading Cursor AI database: {e}")

        return data

    def _capture_vscode(self) -> Dict:
        """Capture VS Code with Copilot configurations"""
        config = {
            "settings": {},
            "extensions": [],
            "copilot": {}
        }

        paths = self.ai_configs["vscode"]["paths"]

        # Capture settings
        if paths["settings"].exists():
            with open(paths["settings"]) as f:
                config["settings"] = json.load(f)

        # Capture Copilot data
        if paths["copilot"].exists():
            for file in paths["copilot"].glob("*"):
                if file.is_file():
                    with open(file, 'rb') as f:
                        # Encrypt Copilot auth data
                        encrypted = self.crypto.encrypt(f.read())
                        config["copilot"][file.name] = encrypted.hex()

        return config

    def _capture_gemini(self) -> Dict:
        """Capture Gemini/Google AI configurations"""
        config = {
            "gcloud": {},
            "credentials": None,
            "projects": []
        }

        paths = self.ai_configs["gemini"]["paths"]

        # Capture gcloud config
        if paths["gcloud_config"].exists():
            for config_file in paths["gcloud_config"].glob("*.json"):
                with open(config_file, 'rb') as f:
                    # Encrypt credentials
                    encrypted = self.crypto.encrypt(f.read())
                    config["gcloud"][config_file.name] = encrypted.hex()

        # Capture application default credentials
        if paths["credentials"].exists():
            with open(paths["credentials"], 'rb') as f:
                config["credentials"] = self.crypto.encrypt(f.read()).hex()

        return config

    def _capture_jetbrains(self) -> Dict:
        """Capture JetBrains AI Assistant configurations"""
        config = {
            "ai_assistant": {},
            "ide_settings": {}
        }

        paths = self.ai_configs["jetbrains"]["paths"]

        # Capture AI Assistant settings
        if paths["ai_assistant"].exists():
            for file in paths["ai_assistant"].glob("*.xml"):
                with open(file) as f:
                    config["ai_assistant"][file.name] = f.read()

        # Capture IDE-specific AI settings
        for ide_name in ["idea", "pycharm", "webstorm", "goland"]:
            if ide_name in paths["paths"]:
                for ide_path in paths["paths"][ide_name]:
                    ai_config = ide_path / "options" / "ai.assistant.xml"
                    if ai_config.exists():
                        with open(ai_config) as f:
                            config["ide_settings"][ide_path.name] = f.read()

        return config

    def _capture_windsurf(self) -> Dict:
        """Capture Windsurf/Codeium configurations"""
        config = {
            "settings": {},
            "codeium": {}
        }

        paths = self.ai_configs["windsurf"]["paths"]

        # Capture settings
        if paths["settings"].exists():
            with open(paths["settings"]) as f:
                config["settings"] = json.load(f)

        # Capture Codeium config
        if paths["codeium_config"].exists():
            with open(paths["codeium_config"], 'rb') as f:
                # Encrypt API keys
                encrypted = self.crypto.encrypt(f.read())
                config["codeium"]["config"] = encrypted.hex()

        return config

    def restore_all_ai_configs(self, configs: Dict):
        """Restore configurations for all AI tools"""
        results = {
            "restored": [],
            "failed": [],
            "skipped": []
        }

        for tool_name, tool_config in configs.get("tools", {}).items():
            try:
                if tool_name == "claude":
                    self._restore_claude(tool_config)
                    results["restored"].append("claude")
                elif tool_name == "cursor":
                    self._restore_cursor(tool_config)
                    results["restored"].append("cursor")
                elif tool_name == "vscode":
                    self._restore_vscode(tool_config)
                    results["restored"].append("vscode")
                elif tool_name == "gemini":
                    self._restore_gemini(tool_config)
                    results["restored"].append("gemini")
                elif tool_name == "jetbrains":
                    self._restore_jetbrains(tool_config)
                    results["restored"].append("jetbrains")
                elif tool_name == "windsurf":
                    self._restore_windsurf(tool_config)
                    results["restored"].append("windsurf")
                else:
                    results["skipped"].append(tool_name)

            except Exception as e:
                results["failed"].append({
                    "tool": tool_name,
                    "error": str(e)
                })

        return results

    def _restore_claude(self, config: Dict):
        """Restore Claude configurations"""
        if "claude" not in self.ai_configs:
            print("Claude not installed, skipping...")
            return

        paths = self.ai_configs["claude"]["paths"]

        for name, hex_content in config.get("files", {}).items():
            if name in paths:
                path = paths[name]
                path.parent.mkdir(parents=True, exist_ok=True)

                content = bytes.fromhex(hex_content)
                # Decrypt if it was encrypted
                if name in ["mcp_config", "permissions"]:
                    content = self.crypto.decrypt(content)

                with open(path, 'wb') as f:
                    f.write(content)

    def _restore_cursor(self, config: Dict):
        """Restore Cursor AI configurations"""
        if "cursor" not in self.ai_configs:
            print("Cursor not installed, skipping...")
            return

        paths = self.ai_configs["cursor"]["paths"]

        # Restore settings
        if config.get("settings") and paths["settings"].exists():
            paths["settings"].parent.mkdir(parents=True, exist_ok=True)
            with open(paths["settings"], 'w') as f:
                json.dump(config["settings"], f, indent=2)

        # Note: Extensions need to be installed via Cursor's extension manager
        # We'll create a script to install them
        if config.get("extensions"):
            install_script = paths["app_support"] / "install_extensions.sh"
            with open(install_script, 'w') as f:
                f.write("#!/bin/bash\n")
                f.write("# Install Cursor extensions\n")
                for ext in config["extensions"]:
                    if ext.get("publisher") and ext.get("id"):
                        ext_id = f"{ext['publisher']}.{ext['id']}"
                        f.write(f"cursor --install-extension {ext_id}\n")
            os.chmod(install_script, 0o755)
            print(f"Extension install script created at {install_script}")

    def _restore_vscode(self, config: Dict):
        """Restore VS Code configurations"""
        if "vscode" not in self.ai_configs:
            print("VS Code not installed, skipping...")
            return

        paths = self.ai_configs["vscode"]["paths"]

        # Restore settings
        if config.get("settings"):
            paths["settings"].parent.mkdir(parents=True, exist_ok=True)
            with open(paths["settings"], 'w') as f:
                json.dump(config["settings"], f, indent=2)

        # Restore Copilot auth
        if config.get("copilot"):
            paths["copilot"].mkdir(parents=True, exist_ok=True)
            for filename, hex_content in config["copilot"].items():
                content = self.crypto.decrypt(bytes.fromhex(hex_content))
                with open(paths["copilot"] / filename, 'wb') as f:
                    f.write(content)

    def _restore_gemini(self, config: Dict):
        """Restore Gemini configurations"""
        paths = self._get_gemini_paths()["paths"]

        # Restore gcloud config
        if config.get("gcloud"):
            paths["gcloud_config"].mkdir(parents=True, exist_ok=True)
            for filename, hex_content in config["gcloud"].items():
                content = self.crypto.decrypt(bytes.fromhex(hex_content))
                with open(paths["gcloud_config"] / filename, 'wb') as f:
                    f.write(content)

        # Restore credentials
        if config.get("credentials"):
            content = self.crypto.decrypt(bytes.fromhex(config["credentials"]))
            paths["credentials"].parent.mkdir(parents=True, exist_ok=True)
            with open(paths["credentials"], 'wb') as f:
                f.write(content)

    def _restore_jetbrains(self, config: Dict):
        """Restore JetBrains AI Assistant configurations"""
        if "jetbrains" not in self.ai_configs:
            print("JetBrains IDEs not installed, skipping...")
            return

        paths = self.ai_configs["jetbrains"]["paths"]

        # Restore AI Assistant settings
        if config.get("ai_assistant"):
            paths["ai_assistant"].mkdir(parents=True, exist_ok=True)
            for filename, content in config["ai_assistant"].items():
                with open(paths["ai_assistant"] / filename, 'w') as f:
                    f.write(content)

    def _restore_windsurf(self, config: Dict):
        """Restore Windsurf configurations"""
        paths = self._get_windsurf_paths()["paths"]

        # Restore settings
        if config.get("settings"):
            paths["settings"].parent.mkdir(parents=True, exist_ok=True)
            with open(paths["settings"], 'w') as f:
                json.dump(config["settings"], f, indent=2)

        # Restore Codeium config
        if config.get("codeium", {}).get("config"):
            content = self.crypto.decrypt(bytes.fromhex(config["codeium"]["config"]))
            paths["codeium_config"].parent.mkdir(parents=True, exist_ok=True)
            with open(paths["codeium_config"], 'wb') as f:
                f.write(content)

    def install_ai_tools(self, tools: List[str]):
        """Install specified AI tools"""
        installers = {
            "claude": {
                "darwin": "brew install --cask claude",
                "windows": "winget install Anthropic.Claude",
                "linux": "snap install claude"
            },
            "cursor": {
                "darwin": "brew install --cask cursor",
                "windows": "winget install Cursor.Cursor",
                "linux": "curl -fsSL https://cursor.sh/install.sh | sh"
            },
            "vscode": {
                "darwin": "brew install --cask visual-studio-code",
                "windows": "winget install Microsoft.VisualStudioCode",
                "linux": "snap install code --classic"
            },
            "windsurf": {
                "darwin": "brew install --cask windsurf",
                "windows": "winget install Codeium.Windsurf",
                "linux": "curl -fsSL https://windsurf.sh/install.sh | sh"
            }
        }

        for tool in tools:
            if tool in installers and self.os_type in installers[tool]:
                cmd = installers[tool][self.os_type]
                print(f"Installing {tool}...")
                subprocess.run(cmd, shell=True, check=False)