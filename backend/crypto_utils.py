"""(G2-8) 使用者 OpenRouter 金鑰的 Fernet 加解密。

設計：
    - 金鑰來自環境變數 CREDENTIAL_ENCRYPTION_KEY（Fernet 金鑰），每次呼叫都重讀，不做模組層快取。
    - 沒有預設金鑰；未設定或格式錯誤 → encryption_configured() 為 False，加解密一律拋 CredentialKeyError。
    - 例外訊息是固定文字：絕不包含明碼、密文或加密金鑰。
"""

import os

from cryptography.fernet import Fernet, InvalidToken

ENCRYPTION_KEY_ENV = "CREDENTIAL_ENCRYPTION_KEY"


class CredentialKeyError(Exception):
    """加密金鑰未設定／無效，或密文無法用目前的金鑰解開。訊息固定，不含任何機密。"""


def _load_fernet() -> Fernet | None:
    """讀取環境變數並建立 Fernet；未設定或格式錯誤回 None。"""
    raw = (os.getenv(ENCRYPTION_KEY_ENV) or "").strip()
    if not raw:
        return None
    try:
        return Fernet(raw.encode("ascii"))
    except (ValueError, TypeError, UnicodeEncodeError):
        return None


def encryption_configured() -> bool:
    """只有環境變數存在且是有效的 Fernet 金鑰才回 True。"""
    return _load_fernet() is not None


def encrypt_key(plain: str) -> str:
    fernet = _load_fernet()
    if fernet is None:
        raise CredentialKeyError("credential encryption key is not configured")
    return fernet.encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_key(token: str) -> str:
    fernet = _load_fernet()
    if fernet is None:
        raise CredentialKeyError("credential encryption key is not configured")
    try:
        return fernet.decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError):
        raise CredentialKeyError("stored credential cannot be decrypted with the current key") from None
