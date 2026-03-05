"""1Password integration provider"""

import subprocess
import json
from typing import Optional, List
from .base import SecretProvider


class OnePasswordProvider(SecretProvider):
    """1Password CLI integration"""

    def __init__(self):
        self.vault = None
        self.session = None

    def name(self) -> str:
        return "1password"

    def is_available(self) -> bool:
        """Check if 1Password CLI is installed"""
        try:
            result = subprocess.run(
                ["op", "--version"],
                capture_output=True,
                text=True
            )
            return result.returncode == 0
        except FileNotFoundError:
            return False

    def authenticate(self, **kwargs) -> bool:
        """Authenticate with 1Password"""
        try:
            # Try to get account info (will prompt for auth if needed)
            result = subprocess.run(
                ["op", "account", "get"],
                capture_output=True,
                text=True
            )

            if result.returncode == 0:
                account = json.loads(result.stdout)
                self.vault = kwargs.get("vault", "Private")
                return True
            return False
        except Exception:
            return False

    def get_secret(self, key: str, **kwargs) -> Optional[str]:
        """Retrieve a secret from 1Password"""
        try:
            # Try to get the item
            result = subprocess.run(
                ["op", "item", "get", key, "--vault", self.vault or "Private", "--fields", "password"],
                capture_output=True,
                text=True
            )

            if result.returncode == 0:
                return result.stdout.strip()

            # Try as a reference (op://vault/item/field)
            reference = kwargs.get("reference", f"op://{self.vault}/{key}/password")
            result = subprocess.run(
                ["op", "read", reference],
                capture_output=True,
                text=True
            )

            if result.returncode == 0:
                return result.stdout.strip()

            return None
        except Exception:
            return None

    def set_secret(self, key: str, value: str, **kwargs) -> bool:
        """Store a secret in 1Password"""
        try:
            # Create a new password item
            template = {
                "title": key,
                "category": "PASSWORD",
                "fields": [
                    {
                        "id": "password",
                        "type": "CONCEALED",
                        "purpose": "PASSWORD",
                        "label": "password",
                        "value": value
                    }
                ]
            }

            # Check if item exists
            check = subprocess.run(
                ["op", "item", "get", key, "--vault", self.vault],
                capture_output=True
            )

            if check.returncode == 0:
                # Update existing
                result = subprocess.run(
                    ["op", "item", "edit", key, "--vault", self.vault, f"password={value}"],
                    capture_output=True
                )
            else:
                # Create new
                result = subprocess.run(
                    ["op", "item", "create", "--category", "password", "--title", key,
                     "--vault", self.vault, f"password={value}"],
                    capture_output=True
                )

            return result.returncode == 0
        except Exception:
            return False

    def delete_secret(self, key: str, **kwargs) -> bool:
        """Delete a secret from 1Password"""
        try:
            result = subprocess.run(
                ["op", "item", "delete", key, "--vault", self.vault],
                capture_output=True
            )
            return result.returncode == 0
        except Exception:
            return False

    def list_secrets(self, **kwargs) -> List[str]:
        """List secrets in 1Password vault"""
        try:
            result = subprocess.run(
                ["op", "item", "list", "--vault", self.vault, "--format", "json"],
                capture_output=True,
                text=True
            )

            if result.returncode == 0:
                items = json.loads(result.stdout)
                return [item["title"] for item in items]
            return []
        except Exception:
            return []