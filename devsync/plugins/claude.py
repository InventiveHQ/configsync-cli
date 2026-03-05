"""Claude Desktop Plugin for DevSync"""

import json
import os
import platform
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime

from devsync.plugin_system import DevSyncPlugin, PluginMetadata


class ClaudePlugin(DevSyncPlugin):
    """Sync Claude Desktop settings, MCP servers, and permissions"""

    def get_metadata(self) -> PluginMetadata:
        return PluginMetadata(
            name="claude",
            version="1.0.0",
            author="DevSync Core",
            description="Sync Claude Desktop settings, MCP servers, and permissions",
            category="ai_tool",
            platforms=["darwin", "windows", "linux"],
            homepage="https://claude.ai"
        )

    def detect(self) -> bool:
        """Detect if Claude is installed"""
        # Check for MCP config (works even without Claude Desktop)
        mcp_config = Path.home() / ".mcp.json"
        if mcp_config.exists():
            return True

        # Check for Claude Desktop
        claude_dir = self._get_claude_dir()
        return claude_dir.exists()

    def get_config_paths(self) -> Dict[str, Path]:
        """Get Claude configuration paths"""
        paths = {
            "mcp_config": Path.home() / ".mcp.json"
        }

        claude_dir = self._get_claude_dir()
        if claude_dir.exists():
            paths.update({
                "settings": claude_dir / "settings.json",
                "permissions": claude_dir / "permissions.json",
                "claude_mcp": claude_dir / ".mcp.json"
            })

        # Project-specific CLAUDE.md files
        claude_md_files = list(Path.home().rglob("**/CLAUDE.md"))
        for i, file in enumerate(claude_md_files[:10]):  # Limit to 10
            paths[f"claude_md_{i}"] = file

        return paths

    def capture(self, crypto_manager) -> Dict:
        """Capture Claude configuration"""
        config = {
            "version": "1.0",
            "mcp_servers": {},
            "settings": {},
            "permissions": {},
            "claude_instructions": {},
            "mcp_packages": []
        }

        paths = self.get_config_paths()

        # Capture MCP configuration
        if "mcp_config" in paths and paths["mcp_config"].exists():
            with open(paths["mcp_config"]) as f:
                mcp_data = json.load(f)
                config["mcp_servers"] = mcp_data.get("mcpServers", {})

        # Capture Claude Desktop settings
        if "settings" in paths and paths["settings"].exists():
            with open(paths["settings"]) as f:
                config["settings"] = json.load(f)

        # Capture permissions (encrypted)
        if "permissions" in paths and paths["permissions"].exists():
            with open(paths["permissions"], 'rb') as f:
                encrypted = crypto_manager.encrypt(f.read())
                config["permissions"] = encrypted.hex()

        # Capture CLAUDE.md instructions
        for key, path in paths.items():
            if key.startswith("claude_md_") and path.exists():
                with open(path) as f:
                    project = str(path.parent)
                    config["claude_instructions"][project] = f.read()

        # Detect installed MCP packages
        config["mcp_packages"] = self._detect_mcp_packages()

        return config

    def restore(self, config: Dict, crypto_manager) -> bool:
        """Restore Claude configuration"""
        restored = False

        # Install MCP packages first
        for package in config.get("mcp_packages", []):
            self._install_mcp_package(package)

        # Restore MCP configuration
        if config.get("mcp_servers"):
            mcp_config = Path.home() / ".mcp.json"
            mcp_data = {
                "mcpServers": config["mcp_servers"]
            }
            mcp_config.parent.mkdir(parents=True, exist_ok=True)
            with open(mcp_config, 'w') as f:
                json.dump(mcp_data, f, indent=2)
            restored = True

        # Restore Claude Desktop settings
        claude_dir = self._get_claude_dir()
        if config.get("settings") and claude_dir.exists():
            settings_file = claude_dir / "settings.json"
            with open(settings_file, 'w') as f:
                json.dump(config["settings"], f, indent=2)
            restored = True

        # Restore permissions (decrypt first)
        if config.get("permissions") and claude_dir.exists():
            perms_file = claude_dir / "permissions.json"
            decrypted = crypto_manager.decrypt(bytes.fromhex(config["permissions"]))
            with open(perms_file, 'wb') as f:
                f.write(decrypted)
            restored = True

        # Restore CLAUDE.md files
        for project_path, content in config.get("claude_instructions", {}).items():
            claude_md = Path(project_path) / "CLAUDE.md"
            if Path(project_path).exists():
                with open(claude_md, 'w') as f:
                    f.write(content)

        return restored

    def install(self, package_manager) -> bool:
        """Install Claude Desktop"""
        os_type = platform.system().lower()

        if os_type == "darwin":
            # Install via Homebrew
            import subprocess
            result = subprocess.run(
                ["brew", "install", "--cask", "claude"],
                capture_output=True
            )
            return result.returncode == 0

        elif os_type == "windows":
            # Install via winget
            import subprocess
            result = subprocess.run(
                ["winget", "install", "Anthropic.Claude"],
                capture_output=True
            )
            return result.returncode == 0

        return False

    def post_restore(self) -> bool:
        """Post-restore actions"""
        print("\n✅ Claude configuration restored!")
        print("   • MCP servers configured")
        print("   • Permissions restored")
        print("   • CLAUDE.md instructions in place")

        # Create helper script for testing MCP servers
        self._create_mcp_test_script()

        return True

    def _get_claude_dir(self) -> Path:
        """Get Claude configuration directory"""
        os_type = platform.system().lower()

        if os_type == "darwin":
            return Path.home() / "Library" / "Application Support" / "Claude"
        elif os_type == "windows":
            return Path(os.environ['APPDATA']) / "Claude"
        else:  # Linux
            return Path.home() / ".config" / "Claude"

    def _detect_mcp_packages(self) -> List[str]:
        """Detect installed MCP packages"""
        packages = []

        try:
            import subprocess
            result = subprocess.run(
                ["npm", "list", "-g", "--json", "--depth=0"],
                capture_output=True,
                text=True
            )
            if result.returncode == 0:
                npm_data = json.loads(result.stdout)
                deps = npm_data.get("dependencies", {})

                # Find MCP packages
                for pkg in deps.keys():
                    if ("@modelcontextprotocol/" in pkg or
                        "mcp-server-" in pkg):
                        packages.append(pkg)
        except:
            pass

        return packages

    def _install_mcp_package(self, package: str):
        """Install an MCP package"""
        print(f"Installing MCP package: {package}")
        import subprocess
        subprocess.run(["npm", "install", "-g", package], check=False)

    def _create_mcp_test_script(self):
        """Create a script to test MCP servers"""
        script_content = """#!/bin/bash
# Test MCP servers

echo "Testing MCP servers..."

# Test filesystem server
npx -y @modelcontextprotocol/server-filesystem /tmp 2>/dev/null &
PID=$!
sleep 2
if ps -p $PID > /dev/null; then
    echo "✅ Filesystem MCP server works"
    kill $PID
else
    echo "❌ Filesystem MCP server failed"
fi

echo "MCP server test complete!"
"""

        script_path = Path.home() / ".devsync" / "test-mcp.sh"
        script_path.parent.mkdir(parents=True, exist_ok=True)
        with open(script_path, 'w') as f:
            f.write(script_content)
        os.chmod(script_path, 0o755)
        print(f"MCP test script created at: {script_path}")


# MCP Server Builder - Create custom MCP servers
class MCPServerBuilder:
    """Helper to create custom MCP servers for Claude"""

    @staticmethod
    def create_project_server(project_name: str, project_path: str,
                             database_url: Optional[str] = None) -> Dict:
        """Create an MCP server configuration for a project"""
        config = {
            f"project-{project_name}": {
                "command": "npx",
                "args": [
                    "-y",
                    "@modelcontextprotocol/server-filesystem",
                    project_path
                ]
            }
        }

        # Add database if provided
        if database_url:
            config[f"project-{project_name}-db"] = {
                "command": "npx",
                "args": [
                    "-y",
                    "@modelcontextprotocol/server-postgres",
                    database_url
                ]
            }

        return config

    @staticmethod
    def create_github_server(token_env_var: str = "GITHUB_TOKEN") -> Dict:
        """Create GitHub MCP server configuration"""
        return {
            "github": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": {
                    "GITHUB_TOKEN": f"${{{token_env_var}}}"
                }
            }
        }

    @staticmethod
    def create_custom_server(name: str, command: str, args: List[str],
                            env: Optional[Dict] = None) -> Dict:
        """Create a custom MCP server configuration"""
        config = {
            name: {
                "command": command,
                "args": args
            }
        }

        if env:
            config[name]["env"] = env

        return config