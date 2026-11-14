"""(G2-8) 使用者連結自己的 OpenRouter 帳號：OAuth PKCE 流程，金鑰加密後存進 openrouter_credential。

路由（掛在 /auth/openrouter，必須比 auth_routes 先 include，否則 /{provider}/callback 會先匹配）：
    GET    /auth/openrouter/connect    -> 產生 code_verifier／state，存進 Starlette session，303 去 OpenRouter 授權頁
    GET    /auth/openrouter/callback   -> 驗證 state（一次性）→ 換金鑰 → Fernet 加密 → upsert → 303 回首頁
    DELETE /auth/openrouter            -> 刪除自己的連結（沒有列也回 200）

安全設計：
    - 兩個 GET 路由用 cookie 直接查使用者（不用 get_current_user），失敗一律 303 導回首頁帶固定代碼。
    - 錯誤代碼只有四個固定字串；不回顯任何 query 參數。
    - 任何路徑都不記錄 code、code_verifier、state、金鑰、密文或 OpenRouter 回應內容。
"""

import base64
import hashlib
import hmac
import logging
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlmodel import Session

from auth_routes import (
    SESSION_COOKIE_NAME,
    allowed_origins,
    find_valid_session_user,
    frontend_url,
    get_current_user,
)
from crypto_utils import CredentialKeyError, encrypt_key, encryption_configured
from database import get_session
from models import GUEST_PROVIDER, OpenRouterCredential, User
from rate_limit import limiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/openrouter", tags=["openrouter"])

OPENROUTER_AUTH_URL = "https://openrouter.ai/auth"
OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys"
KEY_LABEL = "FluentBranch"

# session 內待完成的連結：超過這個秒數就視為過期（state 仍然會被移除）
PKCE_MAX_AGE_SECONDS = 600
PKCE_SESSION_KEY = "openrouter_pkce"

NO_STORE = {"Cache-Control": "no-store"}


# ===== 小工具 =====

def _now_unix() -> int:
    """目前的 unix 秒數（獨立成函式，harness 可換掉來測過期）。"""
    return int(time.time())


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _redirect(error_code: str | None = None) -> RedirectResponse:
    """303 回首頁。error_code 只能是固定代碼；None 代表連結成功。"""
    if error_code is None:
        url = f"{frontend_url()}/?openrouter=connected"
    else:
        url = f"{frontend_url()}/?openrouter_error={error_code}"
    return RedirectResponse(url=url, status_code=303, headers=NO_STORE)


def _code_challenge(verifier: str) -> str:
    """PKCE S256：base64url(sha256(verifier))，去掉結尾的 =。"""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


async def exchange_code_for_key(code: str, code_verifier: str) -> str | None:
    """用授權碼與 code_verifier 向 OpenRouter 換取金鑰。成功回傳 key，失敗回 None。

    只記錄狀態碼或例外型別；不記錄 code、verifier、回應內容。
    """
    payload = {
        "code": code,
        "code_verifier": code_verifier,
        "code_challenge_method": "S256",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(OPENROUTER_EXCHANGE_URL, json=payload)
    except httpx.HTTPError as e:
        logger.warning("OpenRouter key exchange failed: %s", type(e).__name__)
        return None

    if resp.status_code != 200:
        logger.warning("OpenRouter key exchange failed: status %s", resp.status_code)
        return None

    try:
        data = resp.json()
    except ValueError as e:
        logger.warning("OpenRouter key exchange failed: %s", type(e).__name__)
        return None

    key = data.get("key") if isinstance(data, dict) else None
    if not isinstance(key, str) or not key:
        logger.warning("OpenRouter key exchange failed: no key in response")
        return None
    return key


# ===== 路由 =====

@router.get("/connect", name="openrouter_connect")
@limiter.limit("10/minute")
def openrouter_connect(request: Request, session: Session = Depends(get_session)):
    """導向 OpenRouter 授權頁。只有已登入且非訪客的使用者可以發起。"""
    user = find_valid_session_user(session, request.cookies.get(SESSION_COOKIE_NAME))
    if user is None or user.oauth_provider == GUEST_PROVIDER:
        return _redirect("login_required")
    if not encryption_configured():
        return _redirect("unavailable")

    code_verifier = secrets.token_urlsafe(64)
    state = secrets.token_urlsafe(32)
    # 覆寫任何先前未完成的嘗試：session 裡永遠只有一組待完成的連結
    request.session[PKCE_SESSION_KEY] = {
        "state": state,
        "code_verifier": code_verifier,
        "user_id": str(user.id),
        "created": _now_unix(),
    }

    params = {
        "callback_url": str(request.url_for("openrouter_callback")),
        "code_challenge": _code_challenge(code_verifier),
        "code_challenge_method": "S256",
        "state": state,
        "key_label": KEY_LABEL,
    }
    response = RedirectResponse(
        url=f"{OPENROUTER_AUTH_URL}?{urlencode(params)}",
        status_code=303,
        headers=NO_STORE,
    )
    return response


@router.get("/callback", name="openrouter_callback")
@limiter.limit("10/minute")
async def openrouter_callback(request: Request, session: Session = Depends(get_session)):
    """OpenRouter 導回來的入口：驗證 state → 換金鑰 → 加密後存進 openrouter_credential。"""
    # 第一件事：不論後續成功或失敗，pending 都一次性移除（state 只能用一次）
    pending = request.session.pop(PKCE_SESSION_KEY, None)

    user = find_valid_session_user(session, request.cookies.get(SESSION_COOKIE_NAME))
    if user is None or user.oauth_provider == GUEST_PROVIDER:
        return _redirect("login_required")

    state_param = request.query_params.get("state") or ""
    code = request.query_params.get("code") or ""
    if not isinstance(pending, dict) or not state_param or not code:
        return _redirect("state_mismatch")

    pending_state = pending.get("state")
    pending_verifier = pending.get("code_verifier")
    pending_user = pending.get("user_id")
    created = pending.get("created")
    if (
        not isinstance(pending_state, str)
        or not isinstance(pending_verifier, str)
        or not isinstance(created, int)
        or not hmac.compare_digest(pending_state.encode("utf-8"), state_param.encode("utf-8"))
        or pending_user != str(user.id)
        or _now_unix() - created > PKCE_MAX_AGE_SECONDS
    ):
        return _redirect("state_mismatch")

    if not encryption_configured():
        return _redirect("unavailable")

    key = await exchange_code_for_key(code, pending_verifier)
    if key is None:
        return _redirect("exchange_failed")

    try:
        encrypted = encrypt_key(key)
    except CredentialKeyError:
        logger.warning("OpenRouter credential encryption unavailable")
        return _redirect("unavailable")

    row = session.get(OpenRouterCredential, user.id)
    if row is None:
        session.add(OpenRouterCredential(
            user_id=user.id, key_encrypted=encrypted, created_at=_utcnow_naive()
        ))
    else:
        row.key_encrypted = encrypted
        row.created_at = _utcnow_naive()
        session.add(row)
    session.commit()
    return _redirect()


@router.delete("")
def openrouter_disconnect(
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """中斷自己的 OpenRouter 連結。不接受任何 id；沒有列也回 200。"""
    origin = request.headers.get("origin")
    if origin is not None and origin not in allowed_origins():
        raise HTTPException(status_code=403, detail={"code": "bad_origin"})

    row = session.get(OpenRouterCredential, user.id)
    if row is not None:
        session.delete(row)
        session.commit()
    return JSONResponse({"status": "ok"}, headers=NO_STORE)
