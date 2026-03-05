"""DevSync Plugin System - Extensible support for any tool"""

import json
import importlib.util
import subprocess
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Dict, List, Optional, Any, Callable
import yaml
from dataclasses import dataclass


@dataclass
class PluginMetadata:
    """Plugin metadata and requirements"""
    name: str
    version: str
    author: str
    description: str
    category: str  # 'ai_tool', 'editor', 'database', 'cloud', 'custom'
    platforms: List[str]  # ['darwin', 'windows', 'linux']
    requires: List[str] = None  # Other plugins this depends on
    homepage: str = None
    repository: str = None


class DevSyncPlugin(ABC):
    """Base class for all DevSync plugins"""

    @abstractmethod
    def get_metadata(self) -> PluginMetadata:
        """Return plugin metadata"""
        pass

    @abstractmethod
    def detect(self) -> bool:
        """Detect if this tool is installed/configured"""
        pass

    @abstractmethod
    def get_config_paths(self) -> Dict[str, Path]:
        """Return configuration file paths to sync"""
        pass

    @abstractmethod
    def capture(self, crypto_manager) -> Dict:
        """Capture tool configuration and state"""
        pass

    @abstractmethod
    def restore(self, config: Dict, crypto_manager) -> bool:
        """Restore tool configuration"""
        pass

    def install(self, package_manager) -> bool:
        """Install the tool (optional)"""
        return True

    def post_restore(self) -> bool:
        """Run post-restore actions (optional)"""
        return True

    def validate_config(self, config: Dict) -> bool:
        """Validate captured configuration (optional)"""
        return True


class PluginRegistry:
    """Registry for managing DevSync plugins"""

    def __init__(self, plugins_dir: Path = None):
        self.plugins_dir = plugins_dir or Path.home() / ".devsync" / "plugins"
        self.plugins_dir.mkdir(parents=True, exist_ok=True)

        self.builtin_plugins = {}
        self.user_plugins = {}
        self.loaded_plugins = {}

        # Load built-in plugins
        self._load_builtin_plugins()

        # Load user plugins
        self._load_user_plugins()

    def _load_builtin_plugins(self):
        """Load plugins that ship with DevSync"""
        from .plugins import builtin_plugins

        for plugin_class in builtin_plugins:
            plugin = plugin_class()
            metadata = plugin.get_metadata()
            self.builtin_plugins[metadata.name] = plugin

    def _load_user_plugins(self):
        """Load user-installed plugins"""
        # Load from ~/.devsync/plugins/
        for plugin_file in self.plugins_dir.glob("*.py"):
            self._load_plugin_file(plugin_file)

        # Load from plugin directories
        for plugin_dir in self.plugins_dir.iterdir():
            if plugin_dir.is_dir():
                manifest_file = plugin_dir / "plugin.yaml"
                if manifest_file.exists():
                    self._load_plugin_directory(plugin_dir)

    def _load_plugin_file(self, plugin_path: Path):
        """Load a single Python file plugin"""
        try:
            spec = importlib.util.spec_from_file_location(
                plugin_path.stem,
                plugin_path
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            # Find DevSyncPlugin subclasses
            for name in dir(module):
                obj = getattr(module, name)
                if (isinstance(obj, type) and
                    issubclass(obj, DevSyncPlugin) and
                    obj != DevSyncPlugin):

                    plugin = obj()
                    metadata = plugin.get_metadata()
                    self.user_plugins[metadata.name] = plugin
                    print(f"Loaded plugin: {metadata.name} v{metadata.version}")

        except Exception as e:
            print(f"Error loading plugin {plugin_path}: {e}")

    def _load_plugin_directory(self, plugin_dir: Path):
        """Load a plugin from a directory with manifest"""
        manifest_file = plugin_dir / "plugin.yaml"

        with open(manifest_file) as f:
            manifest = yaml.safe_load(f)

        # Check plugin type
        plugin_type = manifest.get("type", "python")

        if plugin_type == "python":
            # Load Python plugin
            main_file = plugin_dir / manifest.get("main", "main.py")
            if main_file.exists():
                self._load_plugin_file(main_file)

        elif plugin_type == "declarative":
            # Load declarative YAML-only plugin
            plugin = DeclarativePlugin(manifest, plugin_dir)
            self.user_plugins[manifest["name"]] = plugin

        elif plugin_type == "script":
            # Load shell script plugin
            plugin = ScriptPlugin(manifest, plugin_dir)
            self.user_plugins[manifest["name"]] = plugin

    def get_plugin(self, name: str) -> Optional[DevSyncPlugin]:
        """Get a plugin by name"""
        # Check user plugins first (can override built-ins)
        if name in self.user_plugins:
            return self.user_plugins[name]
        return self.builtin_plugins.get(name)

    def list_plugins(self) -> Dict[str, List[str]]:
        """List all available plugins by category"""
        categories = {}

        for plugin in {**self.builtin_plugins, **self.user_plugins}.values():
            metadata = plugin.get_metadata()
            category = metadata.category

            if category not in categories:
                categories[category] = []

            categories[category].append(metadata.name)

        return categories

    def detect_installed(self) -> List[str]:
        """Detect which plugin tools are installed"""
        installed = []

        for name, plugin in {**self.builtin_plugins, **self.user_plugins}.items():
            try:
                if plugin.detect():
                    installed.append(name)
            except Exception as e:
                print(f"Error detecting {name}: {e}")

        return installed

    def install_plugin(self, plugin_source: str) -> bool:
        """Install a new plugin from various sources"""

        # GitHub repository
        if plugin_source.startswith("github:"):
            return self._install_from_github(plugin_source[7:])

        # NPM package
        elif plugin_source.startswith("npm:"):
            return self._install_from_npm(plugin_source[4:])

        # URL
        elif plugin_source.startswith("http"):
            return self._install_from_url(plugin_source)

        # Local file
        elif Path(plugin_source).exists():
            return self._install_from_file(Path(plugin_source))

        # Plugin registry
        else:
            return self._install_from_registry(plugin_source)

    def _install_from_github(self, repo: str) -> bool:
        """Install plugin from GitHub repository"""
        plugin_name = repo.split("/")[-1]
        target_dir = self.plugins_dir / plugin_name

        # Clone repository
        subprocess.run([
            "git", "clone",
            f"https://github.com/{repo}.git",
            str(target_dir)
        ], check=True)

        # Load the plugin
        self._load_plugin_directory(target_dir)

        return True

    def _install_from_registry(self, name: str) -> bool:
        """Install from DevSync plugin registry"""
        # This would connect to a central registry API
        # For now, we'll use a simple GitHub list

        registry = {
            "devsync-docker": "devsync/plugin-docker",
            "devsync-k8s": "devsync/plugin-kubernetes",
            "devsync-terraform": "devsync/plugin-terraform",
            "devsync-ansible": "devsync/plugin-ansible",
        }

        if name in registry:
            return self._install_from_github(registry[name])

        return False


class DeclarativePlugin(DevSyncPlugin):
    """Plugin defined entirely in YAML (no code)"""

    def __init__(self, manifest: Dict, plugin_dir: Path):
        self.manifest = manifest
        self.plugin_dir = plugin_dir

    def get_metadata(self) -> PluginMetadata:
        return PluginMetadata(
            name=self.manifest["name"],
            version=self.manifest["version"],
            author=self.manifest.get("author", "Unknown"),
            description=self.manifest.get("description", ""),
            category=self.manifest.get("category", "custom"),
            platforms=self.manifest.get("platforms", ["darwin", "windows", "linux"])
        )

    def detect(self) -> bool:
        """Detect based on YAML rules"""
        detection = self.manifest.get("detection", {})

        # Check for files
        if "files" in detection:
            for file_path in detection["files"]:
                path = Path(file_path).expanduser()
                if path.exists():
                    return True

        # Check for commands
        if "commands" in detection:
            for cmd in detection["commands"]:
                result = subprocess.run(
                    cmd,
                    shell=True,
                    capture_output=True
                )
                if result.returncode == 0:
                    return True

        # Check for environment variables
        if "env_vars" in detection:
            for var in detection["env_vars"]:
                if os.environ.get(var):
                    return True

        return False

    def get_config_paths(self) -> Dict[str, Path]:
        """Get paths from YAML manifest"""
        paths = {}

        for name, path_spec in self.manifest.get("config_paths", {}).items():
            # Support platform-specific paths
            if isinstance(path_spec, dict):
                import platform
                os_type = platform.system().lower()
                path_str = path_spec.get(os_type, path_spec.get("default"))
            else:
                path_str = path_spec

            if path_str:
                paths[name] = Path(path_str).expanduser()

        return paths

    def capture(self, crypto_manager) -> Dict:
        """Capture based on YAML rules"""
        config = {}
        paths = self.get_config_paths()

        for name, path in paths.items():
            if path.exists():
                # Determine if should encrypt
                encrypt_rules = self.manifest.get("encryption", {})
                should_encrypt = name in encrypt_rules.get("paths", [])

                if path.is_file():
                    with open(path, 'rb') as f:
                        content = f.read()
                        if should_encrypt:
                            content = crypto_manager.encrypt(content)
                        config[name] = content.hex()
                elif path.is_dir():
                    # Capture directory structure
                    config[name] = self._capture_directory(path, crypto_manager)

        return config

    def restore(self, config: Dict, crypto_manager) -> bool:
        """Restore based on YAML rules"""
        paths = self.get_config_paths()

        for name, path in paths.items():
            if name in config:
                path.parent.mkdir(parents=True, exist_ok=True)

                # Check if was encrypted
                encrypt_rules = self.manifest.get("encryption", {})
                was_encrypted = name in encrypt_rules.get("paths", [])

                content = bytes.fromhex(config[name])
                if was_encrypted:
                    content = crypto_manager.decrypt(content)

                if path.suffix:  # Is file
                    with open(path, 'wb') as f:
                        f.write(content)
                else:  # Is directory
                    self._restore_directory(path, config[name], crypto_manager)

        # Run post-restore commands
        for cmd in self.manifest.get("post_restore", []):
            subprocess.run(cmd, shell=True, check=False)

        return True

    def _capture_directory(self, dir_path: Path, crypto_manager) -> Dict:
        """Capture directory contents"""
        contents = {}
        for item in dir_path.rglob("*"):
            if item.is_file():
                rel_path = item.relative_to(dir_path)
                with open(item, 'rb') as f:
                    contents[str(rel_path)] = f.read().hex()
        return contents

    def _restore_directory(self, dir_path: Path, contents: Dict, crypto_manager):
        """Restore directory contents"""
        dir_path.mkdir(parents=True, exist_ok=True)
        for rel_path, hex_content in contents.items():
            full_path = dir_path / rel_path
            full_path.parent.mkdir(parents=True, exist_ok=True)
            with open(full_path, 'wb') as f:
                f.write(bytes.fromhex(hex_content))


class ScriptPlugin(DeclarativePlugin):
    """Plugin that uses shell scripts for operations"""

    def detect(self) -> bool:
        """Run detection script"""
        detect_script = self.plugin_dir / "detect.sh"
        if detect_script.exists():
            result = subprocess.run(
                str(detect_script),
                capture_output=True
            )
            return result.returncode == 0
        return super().detect()

    def capture(self, crypto_manager) -> Dict:
        """Run capture script"""
        capture_script = self.plugin_dir / "capture.sh"
        if capture_script.exists():
            result = subprocess.run(
                str(capture_script),
                capture_output=True,
                text=True
            )
            if result.returncode == 0:
                return json.loads(result.stdout)
        return super().capture(crypto_manager)

    def restore(self, config: Dict, crypto_manager) -> bool:
        """Run restore script"""
        restore_script = self.plugin_dir / "restore.sh"
        if restore_script.exists():
            # Pass config as JSON to stdin
            result = subprocess.run(
                str(restore_script),
                input=json.dumps(config),
                text=True,
                capture_output=True
            )
            return result.returncode == 0
        return super().restore(config, crypto_manager)