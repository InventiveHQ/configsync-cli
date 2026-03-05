"""Base class for secret storage providers"""

from abc import ABC, abstractmethod
from typing import Optional, List, Dict


class SecretProvider(ABC):
    """Abstract base class for secret storage providers"""

    @abstractmethod
    def name(self) -> str:
        """Return the provider name"""
        pass

    @abstractmethod
    def is_available(self) -> bool:
        """Check if this provider is available/installed"""
        pass

    @abstractmethod
    def authenticate(self, **kwargs) -> bool:
        """Authenticate with the provider"""
        pass

    @abstractmethod
    def get_secret(self, key: str, **kwargs) -> Optional[str]:
        """Retrieve a secret value"""
        pass

    @abstractmethod
    def set_secret(self, key: str, value: str, **kwargs) -> bool:
        """Store a secret value"""
        pass

    @abstractmethod
    def delete_secret(self, key: str, **kwargs) -> bool:
        """Delete a secret"""
        pass

    @abstractmethod
    def list_secrets(self, **kwargs) -> List[str]:
        """List available secret keys"""
        pass

    def get_config_schema(self) -> Dict:
        """Return configuration schema for this provider"""
        return {}

    def validate_config(self, config: Dict) -> bool:
        """Validate provider configuration"""
        return True