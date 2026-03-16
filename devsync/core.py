"""Core DevSync functionality"""

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
import yaml
from datetime import datetime

from .crypto import CryptoManager
from .env_manager import EnvManager


@dataclass
class GitRepo:
    """Git repository configuration"""
    url: str
    path: str
    branch: Optional[str] = "main"
    shallow: bool = False
    auto_pull: bool = True

    def to_dict(self):
        return {
            "url": self.url,
            "path": self.path,
            "branch": self.branch,
            "shallow": self.shallow,
            "auto_pull": self.auto_pull
        }


@dataclass
class ConfigFile:
    """Configuration file to sync"""
    source: str
    encrypt: bool = False
    exclude_patterns: List[str] = field(default_factory=list)

    def to_dict(self):
        return {
            "source": self.source,
            "encrypt": self.encrypt,
            "exclude_patterns": self.exclude_patterns
        }


@dataclass
class EnvFile:
    """Environment file configuration"""
    project_path: str
    filename: str = ".env.local"
    encrypt: bool = True

    def to_dict(self):
        return {
            "project_path": self.project_path,
            "filename": self.filename,
            "encrypt": self.encrypt
        }


class DevSync:
    """Main DevSync manager"""

    def __init__(self, config_dir: Optional[Path] = None):
        self.config_dir = config_dir or Path.home() / ".devsync"
        self.config_dir.mkdir(exist_ok=True)

        self.config_file = self.config_dir / "config.yaml"
        self.state_dir = self.config_dir / "state"
        self.state_dir.mkdir(exist_ok=True)
        self.backup_dir = self.config_dir / "backups"
        self.backup_dir.mkdir(exist_ok=True)

        self.crypto = CryptoManager(self.config_dir)
        self.env_manager = EnvManager(self.crypto)

    def init(self, profile: str = "default", sync_backend: str = "local"):
        """Initialize a new DevSync configuration"""
        if self.config_file.exists():
            raise ValueError(f"Config already exists at {self.config_file}")

        config = {
            "version": "1.0",
            "profile": profile,
            "repos": [],
            "configs": [
                {"source": "~/.mcp.json", "encrypt": True},
                {"source": "~/.gitconfig", "encrypt": False},
                {"source": "~/Library/Application Support/Claude", "encrypt": True,
                 "exclude_patterns": ["cache/", "*.log", "*.tmp"]},
            ],
            "env_files": [],
            "secrets": {
                "provider": "builtin",  # builtin, keyring, 1password, bitwarden
                "config": {}
            },
            "sync": {
                "backend": sync_backend,  # local, s3, github, dropbox
                "config": {
                    "path": str(self.state_dir) if sync_backend == "local" else None
                }
            }
        }

        with open(self.config_file, 'w') as f:
            yaml.dump(config, f, default_flow_style=False, sort_keys=False)

        # Initialize the crypto manager with a master password
        self.crypto.initialize()

        return config

    def add_repo(self, url: str, path: str, branch: str = "main", auto_pull: bool = True):
        """Add a git repository to track"""
        config = self.load_config()

        repo = GitRepo(url=url, path=path, branch=branch, auto_pull=auto_pull)
        config["repos"].append(repo.to_dict())

        self.save_config(config)
        return repo

    def add_env_file(self, project_path: str, filename: str = ".env.local"):
        """Add an environment file to track"""
        config = self.load_config()

        env_file = EnvFile(project_path=project_path, filename=filename)
        config["env_files"].append(env_file.to_dict())

        self.save_config(config)
        return env_file

    def set_secret(self, key: str, value: Optional[str] = None, interactive: bool = True):
        """Store a secret in the built-in vault"""
        if value is None and interactive:
            import getpass
            value = getpass.getpass(f"Enter value for {key}: ")

        encrypted = self.crypto.encrypt_secret(key, value)

        # Store in secrets file
        secrets_file = self.config_dir / "secrets.enc"
        secrets = {}
        if secrets_file.exists():
            with open(secrets_file, 'rb') as f:
                secrets = json.loads(self.crypto.decrypt(f.read()))

        secrets[key] = encrypted

        with open(secrets_file, 'wb') as f:
            f.write(self.crypto.encrypt(json.dumps(secrets).encode()))

        return True

    def get_secret(self, key: str) -> Optional[str]:
        """Retrieve a secret from the vault"""
        secrets_file = self.config_dir / "secrets.enc"
        if not secrets_file.exists():
            return None

        with open(secrets_file, 'rb') as f:
            secrets = json.loads(self.crypto.decrypt(f.read()))

        if key not in secrets:
            return None

        return self.crypto.decrypt_secret(key, secrets[key])

    def push(self, message: Optional[str] = None):
        """Push current environment state"""
        config = self.load_config()
        timestamp = datetime.now().isoformat()

        state = {
            "timestamp": timestamp,
            "message": message or f"Pushed from {os.uname().nodename}",
            "repos": [],
            "configs": {},
            "env_files": {},
        }

        # Capture repo states
        for repo_config in config.get("repos", []):
            repo_path = Path(repo_config["path"]).expanduser()
            if repo_path.exists():
                repo_state = self._capture_repo_state(repo_path, repo_config)
                state["repos"].append(repo_state)

        # Capture config files
        for config_item in config.get("configs", []):
            source = Path(config_item["source"]).expanduser()
            if source.exists():
                state["configs"][str(source)] = self._capture_config(source, config_item)

        # Capture env files
        for env_config in config.get("env_files", []):
            env_path = Path(env_config["project_path"]).expanduser() / env_config["filename"]
            if env_path.exists():
                state["env_files"][str(env_path)] = self.env_manager.capture_env_file(
                    env_path, encrypt=env_config.get("encrypt", True)
                )

        # Save state
        self._save_state(state, config)

        return state

    def pull(self, force: bool = False):
        """Pull and restore environment state"""
        config = self.load_config()
        state = self._load_state(config)

        if not state:
            raise ValueError("No state found. Run 'devsync push' on source machine first.")

        results = {
            "repos_cloned": [],
            "repos_updated": [],
            "configs_restored": [],
            "env_files_restored": [],
            "warnings": []
        }

        # Restore repos
        for repo_state in state.get("repos", []):
            repo_path = Path(repo_state["path"]).expanduser()

            if not repo_path.exists():
                # Clone the repo
                self._clone_repo(repo_state, repo_path)
                results["repos_cloned"].append(str(repo_path))
            else:
                # Update existing repo
                if repo_state.get("auto_pull", True):
                    self._update_repo(repo_path, repo_state)
                    results["repos_updated"].append(str(repo_path))

                if repo_state.get("has_uncommitted"):
                    results["warnings"].append(
                        f"Repo {repo_path} has uncommitted changes on source"
                    )

        # Restore config files
        for path, config_data in state.get("configs", {}).items():
            target = Path(path).expanduser()
            self._restore_config(target, config_data, force)
            results["configs_restored"].append(str(target))

        # Restore env files
        for path, env_data in state.get("env_files", {}).items():
            target = Path(path).expanduser()
            self.env_manager.restore_env_file(target, env_data, force)
            results["env_files_restored"].append(str(target))

        return results

    def status(self) -> Dict[str, Any]:
        """Get current sync status"""
        config = self.load_config()

        status = {
            "profile": config.get("profile", "default"),
            "repos": [],
            "configs": [],
            "env_files": [],
            "secrets": [],
        }

        # Check repos
        for repo in config.get("repos", []):
            path = Path(repo["path"]).expanduser()
            repo_status = {
                "path": repo["path"],
                "url": repo["url"],
                "exists": path.exists(),
                "branch": None,
                "clean": None
            }

            if path.exists() and (path / ".git").exists():
                try:
                    os.chdir(path)
                    branch = subprocess.check_output(
                        ["git", "branch", "--show-current"],
                        text=True, stderr=subprocess.DEVNULL
                    ).strip()
                    repo_status["branch"] = branch

                    changes = subprocess.check_output(
                        ["git", "status", "--porcelain"],
                        text=True, stderr=subprocess.DEVNULL
                    )
                    repo_status["clean"] = not bool(changes)
                except subprocess.CalledProcessError:
                    pass

            status["repos"].append(repo_status)

        # Check configs
        for cfg in config.get("configs", []):
            path = Path(cfg["source"]).expanduser()
            status["configs"].append({
                "path": cfg["source"],
                "exists": path.exists(),
                "encrypted": cfg.get("encrypt", False)
            })

        # Check env files
        for env in config.get("env_files", []):
            path = Path(env["project_path"]).expanduser() / env["filename"]
            status["env_files"].append({
                "path": str(path),
                "exists": path.exists(),
                "encrypted": env.get("encrypt", True)
            })

        # Check secrets (just list keys, not values)
        secrets_file = self.config_dir / "secrets.enc"
        if secrets_file.exists():
            try:
                with open(secrets_file, 'rb') as f:
                    secrets = json.loads(self.crypto.decrypt(f.read()))
                    status["secrets"] = list(secrets.keys())
            except Exception:
                status["secrets"] = ["<unable to decrypt>"]

        return status

    def _capture_repo_state(self, repo_path: Path, config: dict) -> dict:
        """Capture the state of a git repository"""
        os.chdir(repo_path)

        branch = subprocess.check_output(
            ["git", "branch", "--show-current"],
            text=True
        ).strip()

        status = subprocess.check_output(
            ["git", "status", "--porcelain"],
            text=True
        )

        # Get latest commit
        try:
            commit = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                text=True
            ).strip()
        except subprocess.CalledProcessError:
            commit = None

        return {
            "url": config["url"],
            "path": str(repo_path),
            "branch": branch,
            "commit": commit,
            "has_uncommitted": bool(status),
            "auto_pull": config.get("auto_pull", True)
        }

    def _capture_config(self, source: Path, config: dict) -> dict:
        """Capture a configuration file or directory"""
        import base64

        if source.is_file():
            content = source.read_bytes()
        else:
            # For directories, create a tar archive
            import tarfile
            import io

            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
                # Apply exclusions
                exclude_patterns = config.get("exclude_patterns", [])

                def filter_func(tarinfo):
                    for pattern in exclude_patterns:
                        if pattern in tarinfo.name:
                            return None
                    return tarinfo

                tar.add(source, arcname=".", filter=filter_func)

            content = buffer.getvalue()

        if config.get("encrypt", False):
            content = self.crypto.encrypt(content)

        return {
            "content": base64.b64encode(content).decode(),
            "encrypted": config.get("encrypt", False),
            "is_directory": source.is_dir()
        }

    def _restore_config(self, target: Path, data: dict, force: bool):
        """Restore a configuration file or directory"""
        import base64

        # Backup existing
        if target.exists() and not force:
            backup = self.backup_dir / f"{target.name}.{datetime.now():%Y%m%d_%H%M%S}"
            if target.is_dir():
                shutil.copytree(target, backup)
            else:
                shutil.copy2(target, backup)

        content = base64.b64decode(data["content"])

        if data.get("encrypted"):
            content = self.crypto.decrypt(content)

        if data.get("is_directory"):
            # Extract tar archive
            import tarfile
            import io

            buffer = io.BytesIO(content)
            with tarfile.open(fileobj=buffer, mode='r:gz') as tar:
                tar.extractall(target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)

    def _clone_repo(self, repo_state: dict, repo_path: Path):
        """Clone a git repository"""
        repo_path.parent.mkdir(parents=True, exist_ok=True)

        cmd = ["git", "clone", repo_state["url"], str(repo_path)]
        if repo_state.get("shallow"):
            cmd.extend(["--depth", "1"])

        subprocess.run(cmd, check=True)

        # Checkout correct branch
        if repo_state["branch"] != "main" and repo_state["branch"] != "master":
            os.chdir(repo_path)
            subprocess.run(["git", "checkout", repo_state["branch"]], check=True)

    def _update_repo(self, repo_path: Path, repo_state: dict):
        """Update an existing repository"""
        os.chdir(repo_path)

        # Stash any local changes
        subprocess.run(["git", "stash"], capture_output=True)

        # Pull latest
        subprocess.run(["git", "pull"], check=True)

        # Checkout correct branch if different
        current_branch = subprocess.check_output(
            ["git", "branch", "--show-current"],
            text=True
        ).strip()

        if current_branch != repo_state["branch"]:
            subprocess.run(["git", "checkout", repo_state["branch"]], check=True)

    def _get_cloud_backend(self, config: dict):
        """Create a CloudBackend instance from config"""
        from .backends.cloud import CloudBackend

        sync_config = config["sync"]["config"]
        api_url = sync_config.get("api_url", "https://configsync.dev")
        api_key = sync_config.get("api_key")

        if not api_key:
            raise ValueError("Not logged in. Run 'devsync login --token <your-token>' first.")

        return CloudBackend(api_url, api_key)

    def _save_state(self, state: dict, config: dict):
        """Save state to configured backend"""
        backend = config["sync"]["backend"]

        if backend == "local":
            state_file = Path(config["sync"]["config"]["path"]) / "state.json"
            state_file.parent.mkdir(parents=True, exist_ok=True)

            with open(state_file, 'w') as f:
                json.dump(state, f, indent=2)

        elif backend == "cloud":
            cloud = self._get_cloud_backend(config)
            cloud.register_machine()
            cloud.push(state, self.crypto)

        elif backend == "s3":
            raise NotImplementedError("S3 backend not yet implemented")

    def _load_state(self, config: dict) -> Optional[dict]:
        """Load state from configured backend"""
        backend = config["sync"]["backend"]

        if backend == "local":
            state_file = Path(config["sync"]["config"]["path"]) / "state.json"
            if not state_file.exists():
                return None

            with open(state_file) as f:
                return json.load(f)

        elif backend == "cloud":
            cloud = self._get_cloud_backend(config)
            return cloud.pull(self.crypto)

        elif backend == "s3":
            raise NotImplementedError("S3 backend not yet implemented")

        return None

    def load_config(self) -> dict:
        """Load the configuration file"""
        if not self.config_file.exists():
            raise ValueError(f"No config found. Run 'devsync init' first.")

        with open(self.config_file) as f:
            return yaml.safe_load(f)

    def save_config(self, config: dict):
        """Save the configuration file"""
        with open(self.config_file, 'w') as f:
            yaml.dump(config, f, default_flow_style=False, sort_keys=False)