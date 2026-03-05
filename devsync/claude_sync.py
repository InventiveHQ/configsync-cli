"""Claude and MCP synchronization for DevSync"""

import json
import os
import platform
from pathlib import Path
from typing import Dict, List, Optional, Any
import subprocess


class ClaudeSync:
    """Manages Claude Desktop and MCP configurations"""

    def __init__(self, crypto_manager):
        self.crypto = crypto_manager
        self.os_type = platform.system().lower()
        self.claude_config_dir = self._get_claude_config_dir()
        self.mcp_config_file = Path.home() / ".mcp.json"

    def _get_claude_config_dir(self) -> Path:
        """Get Claude Desktop configuration directory"""
        if self.os_type == 'darwin':
            return Path.home() / "Library" / "Application Support" / "Claude"
        elif self.os_type == 'windows':
            return Path(os.environ['APPDATA']) / "Claude"
        else:  # Linux
            return Path.home() / ".config" / "Claude"

    def capture_claude_state(self) -> Dict:
        """Capture all Claude-related configurations"""
        state = {
            "mcp_servers": {},
            "claude_settings": {},
            "permissions": {},
            "custom_servers": [],
            "installed_packages": []
        }

        # 1. Capture MCP configuration
        if self.mcp_config_file.exists():
            with open(self.mcp_config_file) as f:
                mcp_config = json.load(f)
                state["mcp_servers"] = mcp_config.get("mcpServers", {})

        # 2. Capture Claude Desktop settings
        if self.claude_config_dir.exists():
            settings_file = self.claude_config_dir / "settings.json"
            if settings_file.exists():
                with open(settings_file) as f:
                    state["claude_settings"] = json.load(f)

            # Capture permissions
            perms_file = self.claude_config_dir / "permissions.json"
            if perms_file.exists():
                with open(perms_file) as f:
                    state["permissions"] = json.load(f)

        # 3. Detect installed MCP server packages
        state["installed_packages"] = self._detect_mcp_packages()

        # 4. Capture custom server configurations
        custom_servers_dir = Path.home() / ".devsync" / "mcp-servers"
        if custom_servers_dir.exists():
            for server_file in custom_servers_dir.glob("*.json"):
                with open(server_file) as f:
                    state["custom_servers"].append({
                        "name": server_file.stem,
                        "config": json.load(f)
                    })

        return state

    def restore_claude_state(self, state: Dict):
        """Restore Claude configurations"""

        # 1. Install required MCP packages
        for package in state.get("installed_packages", []):
            self._install_mcp_package(package)

        # 2. Restore MCP configuration
        mcp_config = {
            "mcpServers": state.get("mcp_servers", {})
        }

        # Ensure parent directory exists
        self.mcp_config_file.parent.mkdir(parents=True, exist_ok=True)

        with open(self.mcp_config_file, 'w') as f:
            json.dump(mcp_config, f, indent=2)

        # 3. Restore Claude Desktop settings (if Claude is installed)
        if self.claude_config_dir.exists():
            # Settings
            if state.get("claude_settings"):
                settings_file = self.claude_config_dir / "settings.json"
                with open(settings_file, 'w') as f:
                    json.dump(state["claude_settings"], f, indent=2)

            # Permissions
            if state.get("permissions"):
                perms_file = self.claude_config_dir / "permissions.json"
                with open(perms_file, 'w') as f:
                    json.dump(state["permissions"], f, indent=2)

        # 4. Restore custom servers
        custom_servers_dir = Path.home() / ".devsync" / "mcp-servers"
        custom_servers_dir.mkdir(parents=True, exist_ok=True)

        for server in state.get("custom_servers", []):
            server_file = custom_servers_dir / f"{server['name']}.json"
            with open(server_file, 'w') as f:
                json.dump(server['config'], f, indent=2)

    def _detect_mcp_packages(self) -> List[str]:
        """Detect installed MCP server packages"""
        packages = []

        # Check npm global packages
        try:
            result = subprocess.run(
                ["npm", "list", "-g", "--json", "--depth=0"],
                capture_output=True,
                text=True
            )
            if result.returncode == 0:
                npm_data = json.loads(result.stdout)
                deps = npm_data.get("dependencies", {})

                # Look for MCP packages
                mcp_packages = [
                    pkg for pkg in deps.keys()
                    if pkg.startswith("@modelcontextprotocol/") or
                    pkg.startswith("mcp-server-") or
                    "mcp" in pkg.lower()
                ]
                packages.extend(mcp_packages)
        except:
            pass

        return packages

    def _install_mcp_package(self, package: str):
        """Install an MCP server package"""
        print(f"Installing MCP package: {package}")
        subprocess.run(["npm", "install", "-g", package], check=False)

    def create_custom_mcp_server(self, name: str, config: Dict) -> bool:
        """Create a custom MCP server configuration"""

        # Validate configuration
        required_fields = ["command", "args"]
        if not all(field in config for field in required_fields):
            raise ValueError("MCP server config must have 'command' and 'args'")

        # Add to MCP configuration
        if not self.mcp_config_file.exists():
            mcp_config = {"mcpServers": {}}
        else:
            with open(self.mcp_config_file) as f:
                mcp_config = json.load(f)

        mcp_config["mcpServers"][name] = config

        with open(self.mcp_config_file, 'w') as f:
            json.dump(mcp_config, f, indent=2)

        return True

    def sync_claude_projects(self, projects: List[Dict]) -> Dict:
        """Sync Claude project configurations"""
        results = {
            "synced": [],
            "failed": []
        }

        for project in projects:
            try:
                # Create project-specific MCP configuration
                project_mcp = {
                    "filesystem": {
                        "command": "npx",
                        "args": [
                            "-y",
                            "@modelcontextprotocol/server-filesystem",
                            project["path"]
                        ]
                    }
                }

                # Add database if specified
                if project.get("database"):
                    db_config = project["database"]
                    if db_config["type"] == "postgres":
                        project_mcp["database"] = {
                            "command": "npx",
                            "args": [
                                "-y",
                                "@modelcontextprotocol/server-postgres",
                                db_config["connection_string"]
                            ]
                        }

                # Save project MCP config
                project_name = Path(project["path"]).name
                self.create_custom_mcp_server(f"project-{project_name}", project_mcp)

                results["synced"].append(project_name)

            except Exception as e:
                results["failed"].append({
                    "project": project.get("path"),
                    "error": str(e)
                })

        return results


class ClaudeSkillBuilder:
    """Build and manage custom "skills" for Claude via MCP servers"""

    def __init__(self):
        self.skills_dir = Path.home() / ".devsync" / "claude-skills"
        self.skills_dir.mkdir(parents=True, exist_ok=True)

    def create_skill(self, name: str, description: str,
                    commands: List[Dict], environment: Optional[Dict] = None) -> Path:
        """Create a custom skill as an MCP server"""

        skill_dir = self.skills_dir / name
        skill_dir.mkdir(exist_ok=True)

        # Generate package.json
        package_json = {
            "name": f"mcp-skill-{name}",
            "version": "1.0.0",
            "description": description,
            "main": "index.js",
            "bin": {
                name: "./index.js"
            },
            "dependencies": {
                "@modelcontextprotocol/sdk": "latest"
            }
        }

        with open(skill_dir / "package.json", 'w') as f:
            json.dump(package_json, f, indent=2)

        # Generate the skill server
        server_code = self._generate_server_code(name, commands)

        with open(skill_dir / "index.js", 'w') as f:
            f.write(server_code)

        # Make executable
        os.chmod(skill_dir / "index.js", 0o755)

        # Install dependencies
        subprocess.run(["npm", "install"], cwd=skill_dir, check=False)

        # Register with MCP
        mcp_config = {
            "command": "node",
            "args": [str(skill_dir / "index.js")]
        }

        if environment:
            mcp_config["env"] = environment

        # Add to MCP configuration
        mcp_file = Path.home() / ".mcp.json"
        if mcp_file.exists():
            with open(mcp_file) as f:
                config = json.load(f)
        else:
            config = {"mcpServers": {}}

        config["mcpServers"][f"skill-{name}"] = mcp_config

        with open(mcp_file, 'w') as f:
            json.dump(config, f, indent=2)

        return skill_dir

    def _generate_server_code(self, name: str, commands: List[Dict]) -> str:
        """Generate MCP server code for the skill"""

        code = f'''#!/usr/bin/env node

const {{ Server }} = require('@modelcontextprotocol/sdk/server/index.js');
const {{ exec }} = require('child_process');
const {{ promisify }} = require('util');

const execAsync = promisify(exec);

const server = new Server({{
  name: 'skill-{name}',
  version: '1.0.0'
}});

// Define tools
'''

        for cmd in commands:
            code += f'''
server.setRequestHandler('tools/call', async (request) => {{
  if (request.params.name === '{cmd["name"]}') {{
    try {{
      const {{ stdout, stderr }} = await execAsync(`{cmd["command"]}`);
      return {{
        content: [
          {{
            type: 'text',
            text: stdout || stderr
          }}
        ]
      }};
    }} catch (error) {{
      return {{
        content: [
          {{
            type: 'text',
            text: `Error: ${{error.message}}`
          }}
        ]
      }};
    }}
  }}
}});
'''

        code += '''
// Start the server
server.connect({
  transport: {
    type: 'stdio'
  }
});
'''

        return code


class ClaudeSessionManager:
    """Manage Claude conversation context and memory"""

    def __init__(self, storage_dir: Path):
        self.storage_dir = storage_dir / "claude-sessions"
        self.storage_dir.mkdir(parents=True, exist_ok=True)

    def save_context(self, context_name: str, data: Dict):
        """Save conversation context for later reference"""

        context_file = self.storage_dir / f"{context_name}.json"

        context = {
            "name": context_name,
            "created_at": datetime.now().isoformat(),
            "data": data,
            "metadata": {
                "project": os.getcwd(),
                "environment": dict(os.environ)
            }
        }

        with open(context_file, 'w') as f:
            json.dump(context, f, indent=2)

    def create_project_instructions(self, project_path: Path) -> str:
        """Generate CLAUDE.md instructions for a project"""

        instructions = f"""# CLAUDE.md

This file provides instructions for Claude when working with this project.

## Project Context

- **Project Path**: {project_path}
- **Primary Language**: {self._detect_language(project_path)}
- **Framework**: {self._detect_framework(project_path)}

## Available MCP Servers

1. **Filesystem Access**: Full access to {project_path}
2. **Database**: Connected via MCP if configured
3. **Custom Skills**: Check ~/.mcp.json for available skills

## Development Workflow

1. Use the filesystem MCP to read/write files
2. Run commands via the appropriate MCP server
3. Test changes before committing

## Project-Specific Rules

- Follow existing code style
- Write tests for new features
- Update documentation as needed
"""

        claude_md = project_path / "CLAUDE.md"
        with open(claude_md, 'w') as f:
            f.write(instructions)

        return str(claude_md)

    def _detect_language(self, project_path: Path) -> str:
        """Detect primary language of the project"""
        if (project_path / "package.json").exists():
            return "JavaScript/TypeScript"
        elif (project_path / "requirements.txt").exists():
            return "Python"
        elif (project_path / "Cargo.toml").exists():
            return "Rust"
        elif (project_path / "go.mod").exists():
            return "Go"
        return "Unknown"

    def _detect_framework(self, project_path: Path) -> str:
        """Detect framework used in the project"""
        if (project_path / "package.json").exists():
            with open(project_path / "package.json") as f:
                pkg = json.load(f)
                deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}

                if "next" in deps:
                    return "Next.js"
                elif "react" in deps:
                    return "React"
                elif "vue" in deps:
                    return "Vue"
                elif "@angular/core" in deps:
                    return "Angular"
                elif "express" in deps:
                    return "Express"

        elif (project_path / "requirements.txt").exists():
            with open(project_path / "requirements.txt") as f:
                reqs = f.read().lower()

                if "django" in reqs:
                    return "Django"
                elif "fastapi" in reqs:
                    return "FastAPI"
                elif "flask" in reqs:
                    return "Flask"

        return "None detected"