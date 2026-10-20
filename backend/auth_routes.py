"""OAuth 登入 / 回呼 / 登出路由 (Google + GitHub)。

流程：
    GET /auth/{provider}/login      -> 轉去 provider 的授權頁 (authlib 會把 state 存進 session)
    GET /auth/{provider}/callback   -> 換 token、取 userinfo、upsert User、發 session cookie
    GET /auth/logout                -> 刪掉 DB 裡的 AuthSession、清 cookie

安全設計：
    - 原始 session token 只放在 httpOnly cookie，資料庫只存 sha256 hash。
    - 所有 datetime 一律 naive UTC（與 models.py / database.py 的慣例一致）。
"""

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlmodel import Session, select

from database import get_session
from models import AuthSession, User
from oauth import is_provider_configured, oauth

router = APIRouter(prefix="/auth", tags=["auth"])

# 只開放這兩個 provider；其他一律 404（避免 /auth/xxx/login 變成無意義的 500）
SUPPORTED_PROVIDERS = ("google", "github")

# session 存活時間：30 天
SESSION_TTL = timedelta(days=30)
SESSION_COOKIE_NAME = "session"


# ===== 小工具 =====

def utcnow_naive() -> datetime:
    """統一的 naive UTC 現在時間（資料庫欄位是 TIMESTAMP WITHOUT TIME ZONE）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def hash_token(token: str) -> str:
    """session token 的 sha256 hex digest（資料庫只存這個）。"""
    return hashlib.sha256(token.encode()).hexdigest()


def generate_session_token() -> str:
    """產生高熵的原始 session token（只回給 cookie，不落 DB）。"""
    return secrets.token_urlsafe(32)


def cookie_secure() -> bool:
    """cookie 是否加 Secure 旗標，由環境變數控制（本機 http 開發預設 False）。"""
    return (os.getenv("SESSION_COOKIE_SECURE", "false") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def ensure_supported_provider(provider: str) -> str:
    """provider 不在白名單就 404。"""
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=404, detail=f"Unknown OAuth provider: {provider}")
    return provider


# ===== 核心商業邏輯（測試會直接呼叫這幾支）=====

def upsert_user(
    session: Session,
    provider: str,
    sub: str,
    email: Optional[str] = None,
) -> User:
    """依 (oauth_provider, oauth_sub) 找使用者，沒有就建一筆。

    同一組 provider+sub 重複呼叫不會產生第二列（idempotent）。
    email 有變動時順便更新。
    """
    user = session.exec(
        select(User).where(User.oauth_provider == provider, User.oauth_sub == sub)
    ).first()

    if user is None:
        user = User(oauth_provider=provider, oauth_sub=sub, email=email)
        session.add(user)
        session.commit()
        session.refresh(user)
        return user

    if email and user.email != email:
        user.email = email
        session.add(user)
        session.commit()
        session.refresh(user)

    return user


def create_session_token(session: Session, user: User) -> str:
    """替 user 建一筆 AuthSession，回傳「原始 token」（DB 只存 hash）。"""
    token = generate_session_token()
    auth_session = AuthSession(
        user_id=user.id,
        token_hash=hash_token(token),
        expires_at=utcnow_naive() + SESSION_TTL,
    )
    session.add(auth_session)
    session.commit()
    return token


def set_session_cookie(response, token: str) -> None:
    """把原始 token 寫進 httpOnly cookie。"""
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=int(SESSION_TTL.total_seconds()),
        httponly=True,
        samesite="lax",
        secure=cookie_secure(),
        path="/",
    )


async def _fetch_github_user(token: dict) -> dict:
    """打 GitHub /user API 拿使用者資料（id / email）。"""
    resp = await oauth.github.get("user", token=token)
    return resp.json()


# ===== 路由 =====

@router.get("/{provider}/login")
async def oauth_login(provider: str, request: Request):
    """導向 provider 的授權頁。"""
    ensure_supported_provider(provider)

    if not is_provider_configured(provider):
        raise HTTPException(
            status_code=503,
            detail=f"OAuth provider '{provider}' is not configured on this server",
        )

    redirect_uri = str(request.url_for("oauth_callback", provider=provider))
    client = getattr(oauth, provider)
    return await client.authorize_redirect(request, redirect_uri)


@router.get("/{provider}/callback", name="oauth_callback")
async def oauth_callback(
    provider: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """provider 導回來的入口：換 token -> 取 userinfo -> upsert user -> 發 cookie。"""
    ensure_supported_provider(provider)

    if not is_provider_configured(provider):
        raise HTTPException(
            status_code=503,
            detail=f"OAuth provider '{provider}' is not configured on this server",
        )

    client = getattr(oauth, provider)
    token = await client.authorize_access_token(request)

    if provider == "google":
        userinfo = token.get("userinfo") or {}
        sub = userinfo.get("sub")
        email = userinfo.get("email")
    else:  # github
        gh_user = await _fetch_github_user(token)
        gh_id = gh_user.get("id")
        sub = str(gh_id) if gh_id is not None else None
        email = gh_user.get("email")

    if not sub:
        raise HTTPException(status_code=400, detail=f"{provider} did not return a user id")

    user = upsert_user(session, provider=provider, sub=str(sub), email=email)
    raw_token = create_session_token(session, user)

    response = RedirectResponse(
        url=os.getenv("FRONTEND_URL", "http://localhost:5173"),
        status_code=303,
    )
    set_session_cookie(response, raw_token)
    return response


@router.get("/logout")
def logout(request: Request, session: Session = Depends(get_session)):
    """登出：刪掉對應的 AuthSession 並清 cookie。"""
    raw_token = request.cookies.get(SESSION_COOKIE_NAME)

    if raw_token:
        token_hash = hash_token(raw_token)
        auth_sessions = session.exec(
            select(AuthSession).where(AuthSession.token_hash == token_hash)
        ).all()
        for auth_session in auth_sessions:
            session.delete(auth_session)
        if auth_sessions:
            session.commit()

    response = JSONResponse({"status": "ok", "message": "Logged out"})
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        samesite="lax",
        secure=cookie_secure(),
    )
    return response
