"""Built-in encrypted secret storage provider"""

import json
from pathlib import Path
from typing import Optional, List


class BuiltinProvider:
    """Built-in encrypted secret storage"""

    def __init__(self, crypto_manager, storage_path: Path):
        self.crypto = crypto_manager
        self.storage_path = storage_path

    def name(self) -> str:
        return "builtin"

    def is_available(self) -> bool:
        return True  # Always available

    def authenticate(self, **kwargs) -> bool:
        """Ensure crypto is unlocked"""
        if self.crypto.is_locked():
            return self.crypto.unlock(kwargs.get("password"))
        return True

    def get_secret(self, key: str, **kwargs) -> Optional[str]:
        """Retrieve a secret value"""
        if not self.storage_path.exists():
            return None

        with open(self.storage_path, 'rb') as f:
            secrets = json.loads(self.crypto.decrypt(f.read()))

        if key not in secrets:
            return None

        return self.crypto.decrypt_secret(key, secrets[key])

    def set_secret(self, key: str, value: str, **kwargs) -> bool:
        """Store a secret value"""
        secrets = {}
        if self.storage_path.exists():
            with open(self.storage_path, 'rb') as f:
                secrets = json.loads(self.crypto.decrypt(f.read()))

        secrets[key] = self.crypto.encrypt_secret(key, value)

        with open(self.storage_path, 'wb') as f:
            f.write(self.crypto.encrypt(json.dumps(secrets).encode()))

        return True

    def delete_secret(self, key: str, **kwargs) -> bool:
        """Delete a secret"""
        if not self.storage_path.exists():
            return False

        with open(self.storage_path, 'rb') as f:
            secrets = json.loads(self.crypto.decrypt(f.read()))

        if key not in secrets:
            return False

        del secrets[key]

        with open(self.storage_path, 'wb') as f:
            f.write(self.crypto.encrypt(json.dumps(secrets).encode()))

        return True

    def list_secrets(self, **kwargs) -> List[str]:
        """List available secret keys"""
        if not self.storage_path.exists():
            return []

        with open(self.storage_path, 'rb') as f:
            secrets = json.loads(self.crypto.decrypt(f.read()))

        return list(secrets.keys())