import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Optional

SECRET_KEY = os.environ.get("GHOSTGRAM_SECRET_KEY", "ghostgram-dev-secret-change-in-prod-9f8e7d6c")
TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"{salt}${base64.b64encode(dk).decode('ascii')}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, encoded = stored.split("$", 1)
        expected = base64.b64decode(encoded.encode("ascii"))
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


def create_token(user_id: int, username: str) -> str:
    payload = {
        "uid": user_id,
        "usr": username,
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    raw = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii")
    sig = hmac.new(SECRET_KEY.encode("utf-8"), raw.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{raw}.{sig}"


def verify_token(token: str) -> Optional[dict]:
    if not token or "." not in token:
        return None
    try:
        raw, sig = token.rsplit(".", 1)
        expected = hmac.new(SECRET_KEY.encode("utf-8"), raw.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        padded = raw + "=" * (-len(raw) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        if payload.get("exp", 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None
