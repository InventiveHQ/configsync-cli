"""Environment file (.env, .env.local) management"""

import os
import re
import base64
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dotenv import dotenv_values


class EnvManager:
    """Manages .env and .env.local files with encryption support"""

    def __init__(self, crypto_manager):
        self.crypto = crypto_manager

    def capture_env_file(self, env_path: Path, encrypt: bool = True) -> Dict:
        """Capture an environment file's contents"""
        if not env_path.exists():
            raise FileNotFoundError(f"Environment file not found: {env_path}")

        # Read and parse the env file
        env_vars = dotenv_values(env_path)

        # Also preserve comments and empty lines for better restoration
        with open(env_path) as f:
            raw_content = f.read()

        # Extract structure (comments, empty lines, order)
        structure = self._extract_structure(raw_content)

        data = {
            "variables": env_vars,
            "structure": structure,
            "raw_content": raw_content,
            "encrypted": encrypt
        }

        if encrypt:
            # Encrypt the sensitive content
            encrypted_content = self.crypto.encrypt(raw_content.encode())
            data["raw_content"] = base64.b64encode(encrypted_content).decode()

            # Encrypt variable values individually for partial access
            encrypted_vars = {}
            for key, value in env_vars.items():
                if value:
                    encrypted_vars[key] = self.crypto.encrypt_secret(key, value)
                else:
                    encrypted_vars[key] = ""
            data["variables"] = encrypted_vars

        return data

    def restore_env_file(self, env_path: Path, data: Dict, force: bool = False):
        """Restore an environment file"""
        if env_path.exists() and not force:
            # Backup existing
            backup_path = env_path.with_suffix(f"{env_path.suffix}.backup")
            env_path.rename(backup_path)

        env_path.parent.mkdir(parents=True, exist_ok=True)

        if data.get("encrypted"):
            # Decrypt the content
            encrypted_content = base64.b64decode(data["raw_content"])
            raw_content = self.crypto.decrypt(encrypted_content).decode()
        else:
            raw_content = data["raw_content"]

        with open(env_path, 'w') as f:
            f.write(raw_content)

        # Set appropriate permissions (readable only by owner)
        os.chmod(env_path, 0o600)

    def merge_env_files(self, local_path: Path, remote_data: Dict,
                       strategy: str = "remote_priority") -> str:
        """Merge local and remote env files intelligently"""
        local_vars = dotenv_values(local_path) if local_path.exists() else {}

        # Decrypt remote variables if needed
        remote_vars = {}
        if remote_data.get("encrypted"):
            for key, encrypted_value in remote_data["variables"].items():
                if encrypted_value:
                    remote_vars[key] = self.crypto.decrypt_secret(key, encrypted_value)
                else:
                    remote_vars[key] = ""
        else:
            remote_vars = remote_data["variables"]

        # Apply merge strategy
        if strategy == "remote_priority":
            merged = {**local_vars, **remote_vars}
        elif strategy == "local_priority":
            merged = {**remote_vars, **local_vars}
        elif strategy == "union":
            merged = {**local_vars, **remote_vars}
            # Keep local values for conflicts
            for key in set(local_vars.keys()) & set(remote_vars.keys()):
                if local_vars[key] != remote_vars[key]:
                    merged[f"{key}_LOCAL"] = local_vars[key]
                    merged[f"{key}_REMOTE"] = remote_vars[key]
        else:
            raise ValueError(f"Unknown merge strategy: {strategy}")

        # Reconstruct the env file
        return self._reconstruct_env_file(merged, remote_data.get("structure", []))

    def diff_env_files(self, local_path: Path, remote_data: Dict) -> Dict:
        """Compare local and remote env files"""
        local_vars = dotenv_values(local_path) if local_path.exists() else {}

        # Decrypt remote variables if needed
        remote_vars = {}
        if remote_data.get("encrypted"):
            for key, encrypted_value in remote_data["variables"].items():
                if encrypted_value:
                    remote_vars[key] = self.crypto.decrypt_secret(key, encrypted_value)
                else:
                    remote_vars[key] = ""
        else:
            remote_vars = remote_data["variables"]

        diff = {
            "added": {},     # In remote but not local
            "removed": {},   # In local but not remote
            "changed": {},   # Different values
            "unchanged": {}  # Same values
        }

        all_keys = set(local_vars.keys()) | set(remote_vars.keys())

        for key in all_keys:
            local_val = local_vars.get(key)
            remote_val = remote_vars.get(key)

            if key not in local_vars:
                diff["added"][key] = remote_val
            elif key not in remote_vars:
                diff["removed"][key] = local_val
            elif local_val != remote_val:
                diff["changed"][key] = {"local": local_val, "remote": remote_val}
            else:
                diff["unchanged"][key] = local_val

        return diff

    def validate_env_file(self, env_path: Path) -> List[str]:
        """Validate an environment file for common issues"""
        issues = []

        if not env_path.exists():
            return ["File does not exist"]

        with open(env_path) as f:
            content = f.read()

        lines = content.split('\n')

        for i, line in enumerate(lines, 1):
            # Skip comments and empty lines
            if line.strip().startswith('#') or not line.strip():
                continue

            # Check for valid KEY=VALUE format
            if '=' not in line:
                issues.append(f"Line {i}: Invalid format (missing '='): {line}")
                continue

            key, value = line.split('=', 1)
            key = key.strip()

            # Check key format
            if not re.match(r'^[A-Z_][A-Z0-9_]*$', key):
                issues.append(f"Line {i}: Invalid key format '{key}' (should be UPPER_SNAKE_CASE)")

            # Check for unquoted values with spaces
            value = value.strip()
            if ' ' in value and not (
                (value.startswith('"') and value.endswith('"')) or
                (value.startswith("'") and value.endswith("'"))
            ):
                issues.append(f"Line {i}: Value with spaces should be quoted: {key}")

            # Check for exposed secrets
            sensitive_patterns = [
                r'(api[_-]?key|secret|password|token|auth)',
                r'(aws|azure|gcp|github|gitlab)',
                r'(private[_-]?key|credential)'
            ]

            key_lower = key.lower()
            for pattern in sensitive_patterns:
                if re.search(pattern, key_lower):
                    if value and not value.startswith('${') and len(value) < 10:
                        issues.append(f"Line {i}: Suspiciously short secret value for '{key}'")
                    break

        # Check file permissions
        stat = os.stat(env_path)
        if stat.st_mode & 0o077:
            issues.append("File has too broad permissions (should be 600 or 640)")

        return issues

    def _extract_structure(self, content: str) -> List[Dict]:
        """Extract the structure of an env file (order, comments, spacing)"""
        structure = []
        lines = content.split('\n')

        for i, line in enumerate(lines):
            if line.strip().startswith('#'):
                structure.append({"type": "comment", "line": i, "content": line})
            elif not line.strip():
                structure.append({"type": "empty", "line": i})
            elif '=' in line:
                key = line.split('=', 1)[0].strip()
                structure.append({"type": "variable", "line": i, "key": key})

        return structure

    def _reconstruct_env_file(self, variables: Dict, structure: List[Dict]) -> str:
        """Reconstruct an env file maintaining structure"""
        if not structure:
            # Simple reconstruction
            lines = []
            for key, value in variables.items():
                # Quote values with spaces
                if value and ' ' in value and not (
                    (value.startswith('"') and value.endswith('"')) or
                    (value.startswith("'") and value.endswith("'"))
                ):
                    value = f'"{value}"'
                lines.append(f"{key}={value}")
            return '\n'.join(lines)

        # Reconstruction with structure
        lines = []
        used_keys = set()

        for item in structure:
            if item["type"] == "comment":
                lines.append(item["content"])
            elif item["type"] == "empty":
                lines.append("")
            elif item["type"] == "variable":
                key = item["key"]
                if key in variables:
                    value = variables[key]
                    if value and ' ' in value and not (
                        (value.startswith('"') and value.endswith('"')) or
                        (value.startswith("'") and value.endswith("'"))
                    ):
                        value = f'"{value}"'
                    lines.append(f"{key}={value}")
                    used_keys.add(key)

        # Add any new variables not in the original structure
        for key, value in variables.items():
            if key not in used_keys:
                if value and ' ' in value and not (
                    (value.startswith('"') and value.endswith('"')) or
                    (value.startswith("'") and value.endswith("'"))
                ):
                    value = f'"{value}"'
                lines.append(f"{key}={value}")

        return '\n'.join(lines)