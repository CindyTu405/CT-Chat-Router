"""(G2-2) 訪客身分的純函式工具。

這個模組不 import main 或 auth_routes，避免循環匯入。
"""
import hashlib
import hmac
import os
from datetime import date, datetime, timedelta, timezone

from slowapi.util import get_remote_address
from sqlalchemy import text
from sqlmodel import Session

# (V1-2) 台灣時區固定 UTC+8（不用 zoneinfo：slim 映像可能缺 tzdata）
TAIPEI_TZ = timezone(timedelta(hours=8))


def taiwan_today() -> date:
    """目前的台灣日期。main.py 有同名函式，這裡重複是為了不讓 auth_routes 匯入 main。"""
    return datetime.now(timezone.utc).astimezone(TAIPEI_TZ).date()


def _int_env(name: str, default: int) -> int:
    """讀整數環境變數；空白或不是整數就用預設值（同 main.py）。"""
    raw = (os.getenv(name) or "").strip()
    try:
        return int(raw)
    except ValueError:
        return default


def guest_ip_daily_guests() -> int:
    """同一 IP 每個台灣日期最多能建立的訪客數（GUEST_IP_DAILY_GUESTS，預設 10）。每次呼叫都重讀環境變數。"""
    return _int_env("GUEST_IP_DAILY_GUESTS", 10)


def client_ip(request) -> str:
    """來源 IP（沿用 slowapi 的判斷；反向代理設定由 uvicorn 的 proxy_headers 處理）。"""
    return get_remote_address(request)


def hash_ip(ip: str) -> str:
    """IP 的 HMAC-SHA256 hex digest。資料庫只存這個，不存原始 IP。

    金鑰順序：IP_HASH_SECRET → SESSION_SECRET_KEY → 開發預設值。每次呼叫都重讀環境變數。
    """
    secret = (
        os.getenv("IP_HASH_SECRET")
        or os.getenv("SESSION_SECRET_KEY")
        or "dev-secret-change-me"
    )
    return hmac.new(secret.encode(), ip.encode(), hashlib.sha256).hexdigest()


def try_count_guest_creation(session: Session, ip_hash: str, day: date) -> bool:
    """嘗試把該 IP 當日的訪客建立數加一。成功回 True，已達上限回 False。

    只執行一句 INSERT ... ON CONFLICT ... WHERE ... RETURNING（同 charge_daily_quota 的寫法，
    避免併發超發）。不 commit：由呼叫端的 commit 與建立使用者同一交易。
    沒有回傳列時立刻 rollback，釋放該列的鎖（否則要等 session 關閉才釋放）。
    """
    limit = guest_ip_daily_guests()
    if limit < 1:
        return False

    row = session.execute(
        text("""
        INSERT INTO guest_ip_usage (ip_hash, day, guests_created, messages) VALUES (:h, :d, 1, 0)
        ON CONFLICT (ip_hash, day) DO UPDATE SET guests_created = guest_ip_usage.guests_created + 1
        WHERE guest_ip_usage.guests_created < :limit
        RETURNING guests_created
        """),
        {"h": ip_hash, "d": day, "limit": limit},
    ).first()
    if row is None:
        session.rollback()
        return False
    return True
