"""Keyring-based secret storage provider"""

from typing import Optional, List
from .base import SecretProvider


class KeyringProvider(SecretProvider):
    """System keyring integration"""

    def __init__(self):
        self.keyring = None
        self.service_name = "devsync"

    def name(self) -> str:
        return "keyring"

    def is_available(self) -> bool:
        """Check if keyring is available"""
        try:
            import keyring
            self.keyring = keyring
            return True
        except ImportError:
            return False

    def authenticate(self, **kwargs) -> bool:
        """No authentication needed for keyring"""
        return self.is_available()

    def get_secret(self, key: str, **kwargs) -> Optional[str]:
        """Retrieve a secret from keyring"""
        if not self.keyring:
            return None
        return self.keyring.get_password(self.service_name, key)

    def set_secret(self, key: str, value: str, **kwargs) -> bool:
        """Store a secret in keyring"""
        if not self.keyring:
            return False
        self.keyring.set_password(self.service_name, key, value)
        return True

    def delete_secret(self, key: str, **kwargs) -> bool:
        """Delete a secret from keyring"""
        if not self.keyring:
            return False
        try:
            self.keyring.delete_password(self.service_name, key)
            return True
        except Exception:
            return False

    def list_secrets(self, **kwargs) -> List[str]:
        """List is not supported by keyring"""
        return []  # Keyring doesn't support listing