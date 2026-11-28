import base64
import hashlib
import hmac
import os
import re
import secrets
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
_PASSWORD_N = 1 << 15
_PASSWORD_R = 8
_PASSWORD_P = 1
_PASSWORD_BYTES = 64
_SECRET_AAD = b"isk-ozon-api-key-v1"
_WB_TOKEN_AAD = b"isk-wb-api-token-v1"
_PAYLOAD_AAD = b"isk-sqlite-payload-v1"


def load_encryption_key():
    raw = ""
    key_file = os.getenv("ISK_ENCRYPTION_KEY_FILE", "/run/secrets/isk_encryption_key")
    try:
        raw = Path(key_file).read_text(encoding="ascii").strip()
    except (OSError, UnicodeError):
        raw = os.getenv("ISK_ENCRYPTION_KEY", "").strip()
    if not raw:
        return None
    try:
        key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except (ValueError, TypeError) as exc:
        raise RuntimeError("ISK encryption key must be URL-safe base64.") from exc
    if len(key) != 32:
        raise RuntimeError("ISK encryption key must decode to exactly 32 bytes.")
    return key


def _encrypt(value, key, aad):
    if not key:
        raise RuntimeError("Server-side encryption is not configured.")
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(key).encrypt(nonce, value.encode("utf-8"), aad)
    return "v1:" + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")


def _decrypt(value, key, aad):
    if not key:
        raise RuntimeError("Encryption key is unavailable; encrypted data cannot be read.")
    if not isinstance(value, str) or not value.startswith("v1:"):
        raise ValueError("Unsupported encrypted value.")
    packed = base64.urlsafe_b64decode(value[3:] + "=" * (-len(value[3:]) % 4))
    if len(packed) < 29:
        raise ValueError("Encrypted value is truncated.")
    return AESGCM(key).decrypt(packed[:12], packed[12:], aad).decode("utf-8")


def encrypt_secret(value, key):
    return _encrypt(value, key, _SECRET_AAD)


def decrypt_secret(value, key):
    return _decrypt(value, key, _SECRET_AAD)


def encrypt_wb_token(value, key):
    return _encrypt(value, key, _WB_TOKEN_AAD)


def decrypt_wb_token(value, key):
    return _decrypt(value, key, _WB_TOKEN_AAD)


def encrypt_payload(data, key):
    import json
    if not key:
        return json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return "enc:" + _encrypt(
        json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
        key,
        _PAYLOAD_AAD,
    )


def decrypt_payload(value, key):
    import json
    if isinstance(value, str) and value.startswith("enc:v1:"):
        return json.loads(_decrypt(value[4:], key, _PAYLOAD_AAD))
    return json.loads(value)


def hash_password(password):
    if len(password) < 12 or len(password) > 256:
        raise ValueError("Пароль должен содержать от 12 до 256 символов.")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_PASSWORD_N, r=_PASSWORD_R,
        p=_PASSWORD_P, dklen=_PASSWORD_BYTES, maxmem=128 * 1024 * 1024,
    )
    encoded_salt = base64.urlsafe_b64encode(salt).decode("ascii")
    encoded_digest = base64.urlsafe_b64encode(digest).decode("ascii")
    return "scrypt$" + str(_PASSWORD_N) + "$" + str(_PASSWORD_R) + "$" + str(_PASSWORD_P) + "$" + encoded_salt + "$" + encoded_digest


def verify_password(password, encoded):
    try:
        algorithm, n, r, p, salt_text, digest_text = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt_text)
        expected = base64.urlsafe_b64decode(digest_text)
        actual = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=int(n), r=int(r), p=int(p),
            dklen=len(expected), maxmem=128 * 1024 * 1024,
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError, MemoryError):
        return False


def token_digest(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def valid_username(username):
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,31}", username or ""))
