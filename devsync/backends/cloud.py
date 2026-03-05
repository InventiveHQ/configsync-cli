"""Cloud backend for DevSync SaaS"""

import json
import base64
import hashlib
from typing import Optional, Dict
from pathlib import Path
import httpx
from datetime import datetime


class CloudBackend:
    """Cloud sync backend for DevSync SaaS"""

    def __init__(self, api_url: str, api_key: str, machine_id: Optional[str] = None):
        self.api_url = api_url.rstrip('/')
        self.api_key = api_key
        self.machine_id = machine_id or self._generate_machine_id()
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30.0
        )

    def _generate_machine_id(self) -> str:
        """Generate unique machine identifier"""
        import platform
        import uuid

        # Combine machine info for fingerprint
        info = f"{platform.node()}-{platform.system()}-{platform.machine()}"

        # Try to get MAC address for better uniqueness
        try:
            mac = uuid.getnode()
            info += f"-{mac}"
        except:
            pass

        return hashlib.sha256(info.encode()).hexdigest()[:16]

    def push(self, state: Dict, crypto_manager) -> bool:
        """Push encrypted state to cloud"""
        try:
            # Add metadata
            state["machine"] = {
                "id": self.machine_id,
                "hostname": platform.node(),
                "platform": platform.system(),
                "pushed_at": datetime.now().isoformat()
            }

            # Encrypt entire state (E2E - server can't decrypt)
            state_json = json.dumps(state)
            encrypted = crypto_manager.encrypt(state_json.encode())

            # Base64 for transport
            payload = {
                "machine_id": self.machine_id,
                "encrypted_state": base64.b64encode(encrypted).decode(),
                "timestamp": datetime.now().isoformat(),
                "version": "1.0"
            }

            response = self.client.post(
                f"{self.api_url}/api/machines/{self.machine_id}/push",
                json=payload
            )

            if response.status_code == 200:
                return True
            else:
                raise Exception(f"Push failed: {response.status_code} - {response.text}")

        except Exception as e:
            raise Exception(f"Failed to push state: {e}")

    def pull(self, crypto_manager) -> Optional[Dict]:
        """Pull and decrypt state from cloud"""
        try:
            response = self.client.get(
                f"{self.api_url}/api/machines/latest"
            )

            if response.status_code == 404:
                return None  # No state exists yet

            if response.status_code != 200:
                raise Exception(f"Pull failed: {response.status_code}")

            data = response.json()

            # Decode and decrypt
            encrypted = base64.b64decode(data["encrypted_state"])
            decrypted = crypto_manager.decrypt(encrypted)
            state = json.loads(decrypted)

            return state

        except Exception as e:
            raise Exception(f"Failed to pull state: {e}")

    def list_machines(self) -> list:
        """List all machines for this user"""
        try:
            response = self.client.get(f"{self.api_url}/api/machines")

            if response.status_code != 200:
                raise Exception(f"List failed: {response.status_code}")

            return response.json()["machines"]

        except Exception as e:
            raise Exception(f"Failed to list machines: {e}")

    def delete_machine(self, machine_id: Optional[str] = None) -> bool:
        """Remove a machine from sync"""
        try:
            target_id = machine_id or self.machine_id
            response = self.client.delete(
                f"{self.api_url}/api/machines/{target_id}"
            )

            return response.status_code == 200

        except Exception as e:
            raise Exception(f"Failed to delete machine: {e}")

    def register_machine(self, name: Optional[str] = None) -> Dict:
        """Register this machine with the service"""
        try:
            import platform

            payload = {
                "machine_id": self.machine_id,
                "name": name or platform.node(),
                "platform": platform.system(),
                "arch": platform.machine(),
                "python_version": platform.python_version()
            }

            response = self.client.post(
                f"{self.api_url}/api/machines/register",
                json=payload
            )

            if response.status_code != 200:
                raise Exception(f"Registration failed: {response.status_code}")

            return response.json()

        except Exception as e:
            raise Exception(f"Failed to register machine: {e}")

    def get_usage(self) -> Dict:
        """Get usage statistics and limits"""
        try:
            response = self.client.get(f"{self.api_url}/api/usage")

            if response.status_code != 200:
                raise Exception(f"Usage fetch failed: {response.status_code}")

            return response.json()

        except Exception as e:
            raise Exception(f"Failed to get usage: {e}")


class CloudAuthenticator:
    """Handle authentication with DevSync cloud"""

    @staticmethod
    def login(email: str, password: str, api_url: str) -> Dict:
        """Login and get API key"""
        client = httpx.Client()

        response = client.post(
            f"{api_url}/api/auth/login",
            json={"email": email, "password": password}
        )

        if response.status_code != 200:
            raise Exception(f"Login failed: {response.text}")

        return response.json()  # Returns api_key and user info

    @staticmethod
    def register(email: str, password: str, api_url: str) -> Dict:
        """Register new account"""
        client = httpx.Client()

        response = client.post(
            f"{api_url}/api/auth/register",
            json={"email": email, "password": password}
        )

        if response.status_code != 201:
            raise Exception(f"Registration failed: {response.text}")

        return response.json()

    @staticmethod
    def verify_token(api_key: str, api_url: str) -> bool:
        """Verify API key is valid"""
        client = httpx.Client(
            headers={"Authorization": f"Bearer {api_key}"}
        )

        response = client.get(f"{api_url}/api/auth/verify")
        return response.status_code == 200