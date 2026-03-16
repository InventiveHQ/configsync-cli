"""Encryption and security management for DevSync"""

import base64
import json
import os
from pathlib import Path
from typing import Optional
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.backends import default_backend
import secrets
import hashlib


class CryptoManager:
    """Handles all encryption/decryption operations"""

    def __init__(self, config_dir: Path):
        self.config_dir = config_dir
        self.key_file = config_dir / ".key"
        self.salt_file = config_dir / ".salt"
        self._fernet: Optional[Fernet] = None

    def initialize(self, password: Optional[str] = None):
        """Initialize the crypto system with a master password"""
        if self.key_file.exists():
            raise ValueError("Crypto already initialized. Use 'unlock' instead.")

        if password is None:
            import getpass
            password = getpass.getpass("Enter master password: ")
            confirm = getpass.getpass("Confirm master password: ")
            if password != confirm:
                raise ValueError("Passwords don't match")

        # Generate a random salt
        salt = secrets.token_bytes(32)
        with open(self.salt_file, 'wb') as f:
            f.write(salt)

        # Derive key from password
        key = self._derive_key(password, salt)

        # Save key (encrypted with itself for verification)
        fernet = Fernet(key)
        verification = fernet.encrypt(b"DEVSYNC_VERIFICATION")

        key_data = {
            "verification": base64.b64encode(verification).decode(),
            "version": "1.0"
        }

        with open(self.key_file, 'w') as f:
            json.dump(key_data, f)

        self._fernet = fernet
        return True

    def unlock(self, password: Optional[str] = None) -> bool:
        """Unlock the crypto system with the master password"""
        if self._fernet is not None:
            return True  # Already unlocked

        if not self.key_file.exists():
            raise ValueError("Crypto not initialized. Run 'devsync init' first.")

        if password is None:
            import getpass
            password = getpass.getpass("Enter master password: ")

        # Load salt
        with open(self.salt_file, 'rb') as f:
            salt = f.read()

        # Derive key
        key = self._derive_key(password, salt)
        fernet = Fernet(key)

        # Verify password
        with open(self.key_file) as f:
            key_data = json.load(f)

        try:
            verification = base64.b64decode(key_data["verification"])
            decrypted = fernet.decrypt(verification)
            if decrypted != b"DEVSYNC_VERIFICATION":
                raise ValueError("Invalid password")
        except Exception:
            raise ValueError("Invalid password")

        self._fernet = fernet
        return True

    def is_locked(self) -> bool:
        """Check if crypto is locked"""
        return self._fernet is None

    def encrypt(self, data: bytes) -> bytes:
        """Encrypt data"""
        if self._fernet is None:
            self.unlock()
        return self._fernet.encrypt(data)

    def decrypt(self, data: bytes) -> bytes:
        """Decrypt data"""
        if self._fernet is None:
            self.unlock()
        return self._fernet.decrypt(data)

    def encrypt_secret(self, key: str, value: str) -> str:
        """Encrypt a secret value with additional key-specific encryption"""
        if self._fernet is None:
            self.unlock()

        # Add key-specific salt
        key_salt = hashlib.sha256(key.encode()).digest()[:16]
        salted_value = key_salt + value.encode()

        encrypted = self._fernet.encrypt(salted_value)
        return base64.b64encode(encrypted).decode()

    def decrypt_secret(self, key: str, encrypted: str) -> str:
        """Decrypt a secret value"""
        if self._fernet is None:
            self.unlock()

        encrypted_bytes = base64.b64decode(encrypted)
        decrypted = self._fernet.decrypt(encrypted_bytes)

        # Remove key-specific salt
        key_salt = hashlib.sha256(key.encode()).digest()[:16]
        if decrypted[:16] != key_salt:
            raise ValueError("Invalid key for this secret")

        return decrypted[16:].decode()

    def change_password(self, old_password: str, new_password: str):
        """Change the master password"""
        # Verify old password
        self.unlock(old_password)

        # Generate new salt
        new_salt = secrets.token_bytes(32)

        # Derive new key
        new_key = self._derive_key(new_password, new_salt)
        new_fernet = Fernet(new_key)

        # Re-encrypt all secrets with new key
        secrets_file = self.config_dir / "secrets.enc"
        if secrets_file.exists():
            # Decrypt with old key
            with open(secrets_file, 'rb') as f:
                secrets_data = self.decrypt(f.read())

            # Encrypt with new key
            with open(secrets_file, 'wb') as f:
                f.write(new_fernet.encrypt(secrets_data))

        # Save new salt
        with open(self.salt_file, 'wb') as f:
            f.write(new_salt)

        # Save new verification
        verification = new_fernet.encrypt(b"DEVSYNC_VERIFICATION")
        key_data = {
            "verification": base64.b64encode(verification).decode(),
            "version": "1.0"
        }

        with open(self.key_file, 'w') as f:
            json.dump(key_data, f)

        self._fernet = new_fernet
        return True

    def _derive_key(self, password: str, salt: bytes) -> bytes:
        """Derive encryption key from password"""
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000,
            backend=default_backend()
        )
        key = base64.urlsafe_b64encode(kdf.derive(password.encode()))
        return key

    def export_secrets(self, output_file: Path, password: Optional[str] = None):
        """Export secrets to an encrypted file with optional password"""
        if password is None:
            import getpass
            password = getpass.getpass("Enter export password: ")

        secrets_file = self.config_dir / "secrets.enc"
        if not secrets_file.exists():
            raise ValueError("No secrets to export")

        # Read and decrypt secrets
        with open(secrets_file, 'rb') as f:
            secrets_data = self.decrypt(f.read())

        # Create export encryption
        export_salt = secrets.token_bytes(32)
        export_key = self._derive_key(password, export_salt)
        export_fernet = Fernet(export_key)

        # Encrypt for export
        export_data = {
            "salt": base64.b64encode(export_salt).decode(),
            "data": base64.b64encode(export_fernet.encrypt(secrets_data)).decode(),
            "version": "1.0"
        }

        with open(output_file, 'w') as f:
            json.dump(export_data, f, indent=2)

        return True

    def import_secrets(self, input_file: Path, password: Optional[str] = None):
        """Import secrets from an exported file"""
        if password is None:
            import getpass
            password = getpass.getpass("Enter import password: ")

        with open(input_file) as f:
            export_data = json.load(f)

        # Decrypt export
        export_salt = base64.b64decode(export_data["salt"])
        export_key = self._derive_key(password, export_salt)
        export_fernet = Fernet(export_key)

        encrypted_data = base64.b64decode(export_data["data"])
        secrets_data = export_fernet.decrypt(encrypted_data)

        # Re-encrypt with our key
        if self._fernet is None:
            self.unlock()

        secrets_file = self.config_dir / "secrets.enc"
        with open(secrets_file, 'wb') as f:
            f.write(self.encrypt(secrets_data))

        return True