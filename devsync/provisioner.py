"""System provisioning and package management for DevSync"""

import os
import sys
import platform
import subprocess
import json
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
import shutil


@dataclass
class Package:
    """Package definition"""
    name: str
    version: Optional[str] = None
    manager: Optional[str] = None  # Auto-detect if not specified
    condition: Optional[str] = None  # Install condition (e.g., "os == 'darwin'")
    post_install: Optional[List[str]] = None  # Commands to run after install


@dataclass
class Tool:
    """Development tool definition"""
    name: str
    test_command: str  # Command to check if installed
    install_commands: Dict[str, List[str]]  # Per-platform install commands
    post_install: Optional[List[str]] = None
    virtualenv: Optional[Dict] = None  # Python virtualenv config


class Provisioner:
    """Handles tool and package installation"""

    def __init__(self, config_dir: Path):
        self.config_dir = config_dir
        self.os_type = platform.system().lower()
        self.arch = platform.machine()
        self.shell = os.environ.get('SHELL', '/bin/bash')

        # Package managers by platform
        self.package_managers = {
            'darwin': ['brew', 'port', 'nix'],
            'linux': ['apt', 'yum', 'dnf', 'pacman', 'zypper', 'snap', 'nix'],
            'windows': ['choco', 'scoop', 'winget']
        }

    def provision(self, manifest: Dict) -> Dict[str, Any]:
        """Provision a complete development environment"""
        results = {
            'system': {},
            'packages': [],
            'tools': [],
            'languages': [],
            'virtualenvs': [],
            'errors': []
        }

        # 1. Ensure package manager is installed
        if manifest.get('ensure_package_manager'):
            results['system']['package_manager'] = self._ensure_package_manager()

        # 2. Install system packages
        for pkg_config in manifest.get('packages', []):
            try:
                package = Package(**pkg_config)
                if self._should_install(package.condition):
                    installed = self._install_package(package)
                    results['packages'].append({
                        'name': package.name,
                        'status': 'installed' if installed else 'failed'
                    })
            except Exception as e:
                results['errors'].append(f"Package {pkg_config.get('name')}: {e}")

        # 3. Install development tools
        for tool_config in manifest.get('tools', []):
            try:
                tool = Tool(**tool_config)
                installed = self._install_tool(tool)
                results['tools'].append({
                    'name': tool.name,
                    'status': 'installed' if installed else 'already_installed'
                })
            except Exception as e:
                results['errors'].append(f"Tool {tool_config.get('name')}: {e}")

        # 4. Setup programming languages
        for lang in manifest.get('languages', []):
            try:
                setup = self._setup_language(lang)
                results['languages'].append(setup)
            except Exception as e:
                results['errors'].append(f"Language {lang.get('name')}: {e}")

        # 5. Create virtual environments
        for venv_config in manifest.get('virtualenvs', []):
            try:
                venv = self._create_virtualenv(venv_config)
                results['virtualenvs'].append(venv)
            except Exception as e:
                results['errors'].append(f"Virtualenv {venv_config.get('name')}: {e}")

        return results

    def _ensure_package_manager(self) -> Dict:
        """Ensure primary package manager is installed"""
        if self.os_type == 'darwin':
            return self._ensure_homebrew()
        elif self.os_type == 'linux':
            return self._detect_linux_package_manager()
        elif self.os_type == 'windows':
            return self._ensure_chocolatey()

    def _ensure_homebrew(self) -> Dict:
        """Install Homebrew on macOS if not present"""
        if shutil.which('brew'):
            # Update Homebrew
            subprocess.run(['brew', 'update'], capture_output=True)
            return {'name': 'homebrew', 'status': 'updated'}

        # Install Homebrew
        print("Installing Homebrew...")
        install_script = '''
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        '''

        subprocess.run(install_script, shell=True, check=True)

        # Add to PATH for Apple Silicon
        if self.arch == 'arm64':
            brew_path = '/opt/homebrew/bin'
        else:
            brew_path = '/usr/local/bin'

        # Add to shell profile
        self._add_to_shell_profile(f'export PATH="{brew_path}:$PATH"')

        return {'name': 'homebrew', 'status': 'installed'}

    def _install_package(self, package: Package) -> bool:
        """Install a package using appropriate package manager"""
        manager = package.manager or self._detect_package_manager()

        if not manager:
            raise Exception(f"No package manager found for {self.os_type}")

        install_commands = {
            'brew': ['brew', 'install', package.name],
            'apt': ['sudo', 'apt-get', 'install', '-y', package.name],
            'yum': ['sudo', 'yum', 'install', '-y', package.name],
            'dnf': ['sudo', 'dnf', 'install', '-y', package.name],
            'pacman': ['sudo', 'pacman', '-S', '--noconfirm', package.name],
            'snap': ['sudo', 'snap', 'install', package.name],
            'choco': ['choco', 'install', '-y', package.name],
            'scoop': ['scoop', 'install', package.name],
            'pip': ['pip', 'install', package.name],
            'npm': ['npm', 'install', '-g', package.name],
            'cargo': ['cargo', 'install', package.name],
        }

        if package.version and manager in ['brew', 'apt']:
            if manager == 'brew':
                install_commands[manager].append(f'--version={package.version}')
            else:
                install_commands[manager][-1] = f'{package.name}={package.version}'

        # Check if already installed
        if self._is_package_installed(package.name, manager):
            return True

        # Install
        cmd = install_commands.get(manager)
        if not cmd:
            raise Exception(f"Unknown package manager: {manager}")

        result = subprocess.run(cmd, capture_output=True)

        # Run post-install commands
        if result.returncode == 0 and package.post_install:
            for cmd in package.post_install:
                subprocess.run(cmd, shell=True)

        return result.returncode == 0

    def _install_tool(self, tool: Tool) -> bool:
        """Install a development tool"""
        # Check if already installed
        if subprocess.run(
            tool.test_command,
            shell=True,
            capture_output=True
        ).returncode == 0:
            return False  # Already installed

        # Get install commands for this platform
        install_cmds = tool.install_commands.get(self.os_type)
        if not install_cmds:
            raise Exception(f"No install commands for {tool.name} on {self.os_type}")

        # Run install commands
        for cmd in install_cmds:
            result = subprocess.run(cmd, shell=True, check=True)

        # Run post-install
        if tool.post_install:
            for cmd in tool.post_install:
                subprocess.run(cmd, shell=True)

        # Setup virtualenv if specified
        if tool.virtualenv:
            self._create_virtualenv(tool.virtualenv)

        return True

    def _setup_language(self, lang_config: Dict) -> Dict:
        """Setup a programming language environment"""
        name = lang_config['name']
        version = lang_config.get('version')

        if name == 'python':
            return self._setup_python(version, lang_config)
        elif name == 'node':
            return self._setup_node(version, lang_config)
        elif name == 'rust':
            return self._setup_rust(version, lang_config)
        elif name == 'go':
            return self._setup_go(version, lang_config)
        else:
            raise Exception(f"Unknown language: {name}")

    def _setup_python(self, version: Optional[str], config: Dict) -> Dict:
        """Setup Python environment"""
        result = {'name': 'python', 'version': version}

        if self.os_type == 'darwin':
            # Use pyenv for version management
            if not shutil.which('pyenv'):
                subprocess.run(['brew', 'install', 'pyenv'], check=True)
                self._add_to_shell_profile('eval "$(pyenv init --path)"')
                self._add_to_shell_profile('eval "$(pyenv init -)"')

            if version:
                # Install specific Python version
                subprocess.run(['pyenv', 'install', '-s', version], check=True)
                subprocess.run(['pyenv', 'global', version], check=True)
                result['version'] = version

        # Install global packages
        for package in config.get('packages', []):
            subprocess.run(['pip', 'install', package], check=True)

        result['packages'] = config.get('packages', [])
        return result

    def _create_virtualenv(self, venv_config: Dict) -> Dict:
        """Create a Python virtual environment"""
        path = Path(venv_config['path']).expanduser()
        name = venv_config.get('name', path.name)
        python_version = venv_config.get('python', 'python3')
        requirements = venv_config.get('requirements')
        packages = venv_config.get('packages', [])

        # Create virtualenv
        if not path.exists():
            subprocess.run([python_version, '-m', 'venv', str(path)], check=True)

        # Install requirements
        pip_path = path / 'bin' / 'pip'

        if requirements:
            req_file = Path(requirements).expanduser()
            if req_file.exists():
                subprocess.run([str(pip_path), 'install', '-r', str(req_file)], check=True)

        # Install packages
        for package in packages:
            subprocess.run([str(pip_path), 'install', package], check=True)

        return {
            'name': name,
            'path': str(path),
            'python': python_version,
            'packages': packages
        }

    def _detect_package_manager(self) -> Optional[str]:
        """Detect available package manager"""
        managers = self.package_managers.get(self.os_type, [])

        for manager in managers:
            if shutil.which(manager):
                return manager

        return None

    def _detect_linux_package_manager(self) -> Dict:
        """Detect Linux distribution and package manager"""
        if os.path.exists('/etc/debian_version'):
            return {'name': 'apt', 'distro': 'debian/ubuntu'}
        elif os.path.exists('/etc/redhat-release'):
            if shutil.which('dnf'):
                return {'name': 'dnf', 'distro': 'fedora'}
            else:
                return {'name': 'yum', 'distro': 'rhel/centos'}
        elif os.path.exists('/etc/arch-release'):
            return {'name': 'pacman', 'distro': 'arch'}
        elif os.path.exists('/etc/SUSE-release'):
            return {'name': 'zypper', 'distro': 'suse'}
        else:
            return {'name': 'unknown', 'distro': 'unknown'}

    def _is_package_installed(self, package: str, manager: str) -> bool:
        """Check if a package is already installed"""
        check_commands = {
            'brew': ['brew', 'list', package],
            'apt': ['dpkg', '-l', package],
            'yum': ['rpm', '-q', package],
            'dnf': ['rpm', '-q', package],
            'pacman': ['pacman', '-Q', package],
            'pip': ['pip', 'show', package],
            'npm': ['npm', 'list', '-g', package],
        }

        cmd = check_commands.get(manager)
        if cmd:
            result = subprocess.run(cmd, capture_output=True)
            return result.returncode == 0

        return False

    def _should_install(self, condition: Optional[str]) -> bool:
        """Evaluate installation condition"""
        if not condition:
            return True

        # Simple condition evaluation (can be enhanced)
        try:
            return eval(condition, {
                'os': self.os_type,
                'arch': self.arch,
                'platform': platform.platform()
            })
        except:
            return True

    def _add_to_shell_profile(self, line: str):
        """Add line to shell profile if not already present"""
        if 'zsh' in self.shell:
            profile_file = Path.home() / '.zshrc'
        elif 'bash' in self.shell:
            profile_file = Path.home() / '.bashrc'
        else:
            profile_file = Path.home() / '.profile'

        # Check if line already exists
        if profile_file.exists():
            content = profile_file.read_text()
            if line in content:
                return

        # Append line
        with open(profile_file, 'a') as f:
            f.write(f'\n{line}\n')