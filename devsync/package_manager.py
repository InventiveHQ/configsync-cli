"""Cross-platform package manager abstraction"""

import os
import platform
import subprocess
import shutil
from typing import Dict, List, Optional, Tuple
from pathlib import Path


class PackageManager:
    """Unified interface for all package managers"""

    def __init__(self):
        self.os_type = platform.system().lower()
        self.distro = self._detect_linux_distro() if self.os_type == 'linux' else None
        self.arch = platform.machine()
        self.manager = self._detect_package_manager()

    def _detect_linux_distro(self) -> str:
        """Detect Linux distribution"""
        try:
            # Try to read from /etc/os-release (most modern distros)
            if os.path.exists('/etc/os-release'):
                with open('/etc/os-release') as f:
                    lines = f.readlines()
                    for line in lines:
                        if line.startswith('ID='):
                            return line.split('=')[1].strip().strip('"')

            # Fallback to checking specific files
            if os.path.exists('/etc/debian_version'):
                return 'debian'
            elif os.path.exists('/etc/redhat-release'):
                return 'rhel'
            elif os.path.exists('/etc/arch-release'):
                return 'arch'
            elif os.path.exists('/etc/alpine-release'):
                return 'alpine'
            elif os.path.exists('/etc/SUSE-release'):
                return 'suse'
        except:
            pass
        return 'unknown'

    def _detect_package_manager(self) -> str:
        """Auto-detect the system's package manager"""
        if self.os_type == 'darwin':
            if shutil.which('brew'):
                return 'homebrew'
            return 'homebrew'  # Will be installed if missing

        elif self.os_type == 'windows':
            if shutil.which('choco'):
                return 'chocolatey'
            elif shutil.which('winget'):
                return 'winget'
            elif shutil.which('scoop'):
                return 'scoop'
            return 'chocolatey'  # Will be installed if missing

        elif self.os_type == 'linux':
            # Check for package managers in order of preference
            if self.distro in ['ubuntu', 'debian', 'linuxmint', 'pop']:
                return 'apt'
            elif self.distro in ['rhel', 'centos', 'fedora', 'rocky', 'almalinux']:
                if shutil.which('dnf'):
                    return 'dnf'
                elif shutil.which('yum'):
                    return 'yum'
            elif self.distro in ['arch', 'manjaro', 'endeavouros']:
                return 'pacman'
            elif self.distro in ['opensuse', 'suse']:
                return 'zypper'
            elif self.distro in ['alpine']:
                return 'apk'

            # Fallback: detect by available commands
            managers = ['apt', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'snap', 'flatpak']
            for mgr in managers:
                if shutil.which(mgr):
                    return mgr

        return 'unknown'

    def ensure_package_manager(self) -> bool:
        """Ensure the primary package manager is installed and ready"""
        if self.os_type == 'darwin':
            return self._ensure_homebrew()
        elif self.os_type == 'windows':
            return self._ensure_chocolatey()
        elif self.os_type == 'linux':
            return self._ensure_linux_package_manager()
        return False

    def _ensure_homebrew(self) -> bool:
        """Install or update Homebrew on macOS"""
        if shutil.which('brew'):
            print("Homebrew found, updating...")
            subprocess.run(['brew', 'update'], check=False)
            return True

        print("Installing Homebrew...")
        install_cmd = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
        result = subprocess.run(install_cmd, shell=True)

        if result.returncode == 0:
            # Add Homebrew to PATH
            if self.arch == 'arm64':  # Apple Silicon
                brew_path = '/opt/homebrew/bin'
            else:  # Intel
                brew_path = '/usr/local/bin'

            # Add to current session
            os.environ['PATH'] = f"{brew_path}:{os.environ['PATH']}"

            # Add to shell profiles
            for profile in ['.zshrc', '.bashrc', '.bash_profile']:
                profile_path = Path.home() / profile
                if profile_path.exists():
                    with open(profile_path, 'a') as f:
                        f.write(f'\nexport PATH="{brew_path}:$PATH"\n')
            return True
        return False

    def _ensure_chocolatey(self) -> bool:
        """Install Chocolatey on Windows"""
        if shutil.which('choco'):
            print("Chocolatey found, updating...")
            subprocess.run(['choco', 'upgrade', 'chocolatey', '-y'], check=False)
            return True

        print("Installing Chocolatey...")
        # Run PowerShell as Administrator
        install_cmd = """
        powershell -NoProfile -InputFormat None -ExecutionPolicy Bypass -Command "
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072;
        iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
        "
        """
        result = subprocess.run(install_cmd, shell=True)
        return result.returncode == 0

    def _ensure_linux_package_manager(self) -> bool:
        """Ensure Linux package manager is updated"""
        if self.manager == 'apt':
            print("Updating APT package lists...")
            subprocess.run(['sudo', 'apt-get', 'update'], check=False)
            return True
        elif self.manager == 'yum':
            print("Cleaning YUM cache...")
            subprocess.run(['sudo', 'yum', 'clean', 'all'], check=False)
            return True
        elif self.manager == 'dnf':
            print("Cleaning DNF cache...")
            subprocess.run(['sudo', 'dnf', 'clean', 'all'], check=False)
            return True
        elif self.manager == 'pacman':
            print("Updating Pacman database...")
            subprocess.run(['sudo', 'pacman', '-Sy'], check=False)
            return True
        elif self.manager == 'zypper':
            print("Refreshing Zypper repositories...")
            subprocess.run(['sudo', 'zypper', 'refresh'], check=False)
            return True
        elif self.manager == 'apk':
            print("Updating APK cache...")
            subprocess.run(['sudo', 'apk', 'update'], check=False)
            return True
        return False

    def install_package(self, package_spec: Dict) -> bool:
        """Install a package based on platform-specific spec"""
        package_name = self._get_package_name(package_spec)
        if not package_name:
            return False

        # Skip if already installed
        if self.is_installed(package_name):
            print(f"✓ {package_spec['name']} already installed")
            return True

        print(f"Installing {package_spec['name']}...")

        # Get the install command
        install_cmd = self._get_install_command(package_name)
        if not install_cmd:
            print(f"No install command for {self.manager}")
            return False

        # Add tap/repository if needed (Homebrew/Linux)
        if self._add_repository(package_spec):
            print(f"Added repository for {package_spec['name']}")

        # Run install
        result = subprocess.run(install_cmd, shell=False)

        # Run post-install commands
        if result.returncode == 0:
            self._run_post_install(package_spec)

        return result.returncode == 0

    def _get_package_name(self, package_spec: Dict) -> Optional[str]:
        """Get platform-specific package name"""
        if self.os_type == 'darwin':
            return package_spec.get('darwin')
        elif self.os_type == 'windows':
            return package_spec.get('windows')
        elif self.os_type == 'linux':
            # Try distro-specific first, then generic linux
            if self.distro and self.distro in package_spec:
                return package_spec.get(self.distro)
            return package_spec.get('linux', package_spec.get('name'))
        return None

    def _get_install_command(self, package: str) -> Optional[List[str]]:
        """Get the install command for the current package manager"""
        commands = {
            # macOS
            'homebrew': ['brew', 'install', package],

            # Windows
            'chocolatey': ['choco', 'install', package, '-y'],
            'winget': ['winget', 'install', package],
            'scoop': ['scoop', 'install', package],

            # Linux - Debian/Ubuntu
            'apt': ['sudo', 'apt-get', 'install', '-y', package],

            # Linux - RHEL/CentOS/Fedora
            'yum': ['sudo', 'yum', 'install', '-y', package],
            'dnf': ['sudo', 'dnf', 'install', '-y', package],

            # Linux - Arch
            'pacman': ['sudo', 'pacman', '-S', '--noconfirm', package],
            'yay': ['yay', '-S', '--noconfirm', package],

            # Linux - SUSE
            'zypper': ['sudo', 'zypper', 'install', '-y', package],

            # Linux - Alpine
            'apk': ['sudo', 'apk', 'add', package],

            # Universal Linux
            'snap': ['sudo', 'snap', 'install', package],
            'flatpak': ['flatpak', 'install', '-y', package],
        }

        return commands.get(self.manager)

    def _add_repository(self, package_spec: Dict) -> bool:
        """Add required repository/tap/PPA"""
        if self.manager == 'homebrew':
            tap = package_spec.get('darwin_tap')
            if tap:
                subprocess.run(['brew', 'tap', tap], check=False)
                return True

        elif self.manager == 'apt':
            ppa = package_spec.get('ubuntu_ppa') or package_spec.get('debian_ppa')
            if ppa:
                subprocess.run(['sudo', 'add-apt-repository', '-y', ppa], check=False)
                subprocess.run(['sudo', 'apt-get', 'update'], check=False)
                return True

        elif self.manager in ['yum', 'dnf']:
            repo = package_spec.get('rhel_repo') or package_spec.get('fedora_repo')
            if repo:
                subprocess.run(['sudo', self.manager, 'config-manager', '--add-repo', repo], check=False)
                return True

        return False

    def _run_post_install(self, package_spec: Dict):
        """Run post-installation commands"""
        post_install = None

        # Get platform-specific post-install
        if self.os_type == 'darwin':
            post_install = package_spec.get('post_install', {}).get('darwin')
        elif self.os_type == 'windows':
            post_install = package_spec.get('post_install', {}).get('windows')
        elif self.os_type == 'linux':
            post_install = package_spec.get('post_install', {}).get('linux')
            if not post_install and self.distro:
                post_install = package_spec.get('post_install', {}).get(self.distro)

        # Fallback to generic post_install
        if not post_install and isinstance(package_spec.get('post_install'), str):
            post_install = package_spec.get('post_install')

        if post_install:
            print(f"Running post-install for {package_spec['name']}...")
            subprocess.run(post_install, shell=True, check=False)

    def is_installed(self, package: str) -> bool:
        """Check if a package is installed"""
        check_commands = {
            # macOS
            'homebrew': ['brew', 'list', package],

            # Windows
            'chocolatey': ['choco', 'list', '--local-only', package],
            'winget': ['winget', 'list', package],
            'scoop': ['scoop', 'info', package],

            # Linux
            'apt': ['dpkg', '-l', package],
            'yum': ['rpm', '-q', package],
            'dnf': ['rpm', '-q', package],
            'pacman': ['pacman', '-Q', package],
            'zypper': ['rpm', '-q', package],
            'apk': ['apk', 'info', '-e', package],
            'snap': ['snap', 'list', package],
            'flatpak': ['flatpak', 'list', '--app', package],
        }

        cmd = check_commands.get(self.manager)
        if cmd:
            result = subprocess.run(cmd, capture_output=True, text=True)
            return result.returncode == 0

        # Fallback: check if command exists
        return shutil.which(package) is not None

    def batch_install(self, packages: List[Dict]) -> Dict[str, List[str]]:
        """Install multiple packages efficiently"""
        results = {
            'installed': [],
            'failed': [],
            'skipped': []
        }

        # Group packages by their actual package manager command
        # This allows us to install multiple packages in one command where possible
        if self.manager in ['apt', 'yum', 'dnf', 'pacman', 'homebrew']:
            to_install = []

            for spec in packages:
                # Check skip conditions
                if self._should_skip(spec):
                    results['skipped'].append(spec['name'])
                    continue

                package_name = self._get_package_name(spec)
                if package_name and not self.is_installed(package_name):
                    to_install.append((package_name, spec))

            # Batch install
            if to_install and self.manager in ['apt', 'yum', 'dnf']:
                package_names = [p[0] for p in to_install]
                print(f"Batch installing {len(package_names)} packages...")

                if self.manager == 'apt':
                    cmd = ['sudo', 'apt-get', 'install', '-y'] + package_names
                elif self.manager == 'yum':
                    cmd = ['sudo', 'yum', 'install', '-y'] + package_names
                elif self.manager == 'dnf':
                    cmd = ['sudo', 'dnf', 'install', '-y'] + package_names

                result = subprocess.run(cmd, check=False)

                if result.returncode == 0:
                    for name, spec in to_install:
                        results['installed'].append(spec['name'])
                        self._run_post_install(spec)
                else:
                    # Fall back to individual installs
                    for name, spec in to_install:
                        if self.install_package(spec):
                            results['installed'].append(spec['name'])
                        else:
                            results['failed'].append(spec['name'])
            else:
                # Individual installs for other package managers
                for spec in packages:
                    if self._should_skip(spec):
                        results['skipped'].append(spec['name'])
                    elif self.install_package(spec):
                        results['installed'].append(spec['name'])
                    else:
                        results['failed'].append(spec['name'])
        else:
            # Individual installs
            for spec in packages:
                if self._should_skip(spec):
                    results['skipped'].append(spec['name'])
                elif self.install_package(spec):
                    results['installed'].append(spec['name'])
                else:
                    results['failed'].append(spec['name'])

        return results

    def _should_skip(self, package_spec: Dict) -> bool:
        """Check if package should be skipped for this platform"""
        if self.os_type == 'darwin' and package_spec.get('skip_darwin'):
            return True
        elif self.os_type == 'windows' and package_spec.get('skip_windows'):
            return True
        elif self.os_type == 'linux' and package_spec.get('skip_linux'):
            return True

        # Check if package has platform-specific definition
        if self.os_type == 'darwin' and 'darwin' not in package_spec:
            return 'skip_darwin' not in package_spec and 'name' not in package_spec
        elif self.os_type == 'windows' and 'windows' not in package_spec:
            return 'skip_windows' not in package_spec and 'name' not in package_spec
        elif self.os_type == 'linux' and 'linux' not in package_spec and self.distro not in package_spec:
            return 'skip_linux' not in package_spec and 'name' not in package_spec

        return False