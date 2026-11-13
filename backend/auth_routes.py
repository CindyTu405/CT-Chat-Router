"""OAuth 登入 / 回呼 / 登出路由 (Google + GitHub)。

流程：
    GET /auth/{provider}/login      -> 轉去 provider 的授權頁 (authlib 會把 state 存進 session)
    GET /auth/{provider}/callback   -> 換 token、取 userinfo、upsert User、發 session cookie
    POST /auth/guest                -> 建立訪客身分（伺服器建 User＋session cookie；每 IP 每日上限）
    GET /auth/me                    -> 目前登入者 (email / provider / is_guest / openrouter_connected / guest_claim)
    POST /auth/guest-claim          -> (G2-4) 把 guest_session 指向的訪客對話合併（merge）或刪除（discard）到目前登入帳號
    POST /auth/logout               -> 刪掉 DB 裡的 AuthSession、清 cookie

安全設計：
    - 原始 session token 只放在 httpOnly cookie，資料庫只存 sha256 hash。
    - 所有 datetime 一律 naive UTC（與 models.py / database.py 的慣例一致）。
"""

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel
from sqlmodel import Session, select

import guest
from database import get_session
from models import GUEST_PROVIDER, AuthSession, OpenRouterCredential, User
from oauth import is_provider_configured, oauth
from rate_limit import limiter  # (G2-2) 單一實例，main 也會用

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# 只開放這兩個 provider；其他一律 404（避免 /auth/xxx/login 變成無意義的 500）
SUPPORTED_PROVIDERS = ("google", "github")

# session 存活時間：30 天
SESSION_TTL = timedelta(days=30)
SESSION_COOKIE_NAME = "session"

# (G2-4) 登入時仍有待處理的訪客對話：訪客原始 token 放這個 cookie，TTL 1 天
GUEST_SESSION_COOKIE_NAME = "guest_session"
GUEST_CLAIM_TTL = timedelta(days=1)


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


def frontend_url() -> str:
    """前端網址（去掉結尾 /，避免組出 //?）。"""
    return (os.getenv("FRONTEND_URL", "http://localhost:5173") or "").rstrip("/")


def auth_error_redirect(code: str) -> RedirectResponse:
    """OAuth 失敗一律 303 導回前端，帶 auth_error 代碼（不洩漏細節）。"""
    return RedirectResponse(url=f"{frontend_url()}/?auth_error={code}", status_code=303)


def allowed_origins() -> list[str]:
    """允許的前端來源（CORS_ORIGINS，逗號分隔；解析方式同 main.py；每次呼叫都重讀環境變數）。"""
    return [
        o.strip()
        for o in os.getenv(
            "CORS_ORIGINS", "http://localhost:5173,http://localhost:8000"
        ).split(",")
        if o.strip()
    ]


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


# ===== FastAPI 依賴：取得目前登入的使用者 =====

def find_valid_session_user(session: Session, raw_token: Optional[str]) -> Optional[User]:
    """同 get_current_user 的查詢，但無效時回 None 而不是丟 401；不刪除任何列。"""
    if not raw_token:
        return None
    auth_session = session.exec(
        select(AuthSession).where(AuthSession.token_hash == hash_token(raw_token))
    ).first()
    if auth_session is None or auth_session.expires_at <= utcnow_naive():
        return None
    return session.get(User, auth_session.user_id)


def get_current_user(
    request: Request,
    session: Session = Depends(get_session),
) -> User:
    """從 session cookie 解析出目前的使用者；任何無效狀況一律 401。

    流程：讀 cookie -> sha256 -> 查 AuthSession -> 檢查過期（過期就順手刪掉）->
    查 User -> 回傳。原始 token 不落 DB，所以比對的是 hash。
    """
    raw_token = request.cookies.get(SESSION_COOKIE_NAME)
    if not raw_token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    auth_session = session.exec(
        select(AuthSession).where(AuthSession.token_hash == hash_token(raw_token))
    ).first()
    if auth_session is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # expires_at 是 naive UTC，直接用 naive UTC 比較
    if auth_session.expires_at <= utcnow_naive():
        session.delete(auth_session)
        session.commit()
        raise HTTPException(status_code=401, detail="Session expired")

    user = session.get(User, auth_session.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return user


def pending_guest(request: Request, session: Session, current_user: User) -> Optional[User]:
    """(G2-4) guest_session cookie 指向的訪客，且目前登入者是非訪客、兩者不同人，才回傳該訪客；否則 None。"""
    g = find_valid_session_user(session, request.cookies.get(GUEST_SESSION_COOKIE_NAME))
    if g is None or not g.is_guest:
        return None
    if current_user.is_guest or g.id == current_user.id:
        return None
    return g


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


def set_guest_session_cookie(response, token: str) -> None:
    """(G2-4) 把訪客的原始 token 寫進 httpOnly 的 guest_session cookie（1 天）。"""
    response.set_cookie(
        key=GUEST_SESSION_COOKIE_NAME,
        value=token,
        max_age=int(GUEST_CLAIM_TTL.total_seconds()),
        httponly=True,
        samesite="lax",
        secure=cookie_secure(),
        path="/",
    )


def clear_guest_session_cookie(response) -> None:
    """(G2-4) 清掉 guest_session cookie（屬性同 set_guest_session_cookie）。"""
    response.delete_cookie(
        key=GUEST_SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        samesite="lax",
        secure=cookie_secure(),
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
        return auth_error_redirect("provider_unavailable")

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
        return auth_error_redirect("provider_unavailable")

    client = getattr(oauth, provider)
    sub = None
    email = None
    try:
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
    except Exception as e:
        # 只記例外型別：不記 token、不記 provider 回應內容
        logger.warning("OAuth callback failed (%s): %s", provider, type(e).__name__)
        return auth_error_redirect("login_failed")

    if not sub:
        logger.warning("OAuth callback failed (%s): missing sub", provider)
        return auth_error_redirect("login_failed")

    user = upsert_user(session, provider=provider, sub=str(sub), email=email)
    user_id = user.id  # 先取純值，之後的 commit 不再碰 ORM 物件

    # (G2-4) 登入前瀏覽器帶著有效的訪客 session：今日次數併入帳號；沒有對話的訪客直接刪除，
    # 有對話的訪客保留，原始 token 改放 guest_session cookie 等使用者決定 merge / discard。
    incoming_token = request.cookies.get(SESSION_COOKIE_NAME)
    guest_raw_token = None
    g = find_valid_session_user(session, incoming_token)
    if g is not None and g.is_guest and g.id != user_id:
        guest_id = g.id
        guest.transfer_today_usage(session, guest_id, user_id, guest.taiwan_today())
        if guest.count_chat_roots(session, guest_id) == 0:
            guest.delete_guest_user(session, guest_id, keep_data=False)
            session.commit()
        else:
            session.commit()
            guest_raw_token = incoming_token

    raw_token = create_session_token(session, user)

    response = RedirectResponse(
        url=frontend_url(),
        status_code=303,
    )
    set_session_cookie(response, raw_token)
    if guest_raw_token is not None:
        set_guest_session_cookie(response, guest_raw_token)
    return response


@router.post("/guest")
@limiter.limit("5/minute")
def create_guest(request: Request, session: Session = Depends(get_session)):
    """建立訪客身分（沒有有效登入 cookie 時才建立）。

    順序：已有有效 session → 不建立；Origin 不在白名單 → 403；
    該 IP 今日訪客數已滿 → 429 guest_ip_limit（不建立任何列）；否則建立訪客與 session cookie。
    不記錄 IP 或其雜湊。
    """
    no_store = {"Cache-Control": "no-store"}

    if find_valid_session_user(session, request.cookies.get(SESSION_COOKIE_NAME)) is not None:
        return JSONResponse({"status": "ok", "created": False}, headers=no_store)

    origin = request.headers.get("origin")
    if origin is not None and origin not in allowed_origins():
        raise HTTPException(status_code=403, detail={"code": "bad_origin"})

    day = guest.taiwan_today()
    ip_hash = guest.hash_ip(guest.client_ip(request))
    if not guest.try_count_guest_creation(session, ip_hash, day):
        raise HTTPException(status_code=429, detail={"code": "guest_ip_limit"})

    # 同一交易：這次 commit 也會寫入上面的 IP 計數
    user = User(oauth_provider=GUEST_PROVIDER, oauth_sub=secrets.token_hex(16), email=None)
    session.add(user)
    session.commit()
    session.refresh(user)
    raw_token = create_session_token(session, user)

    response = JSONResponse({"status": "ok", "created": True}, headers=no_store)
    set_session_cookie(response, raw_token)
    return response


@router.get("/me")
def me(
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """目前登入者資訊（不回 id、不回金鑰任何片段）。

    (G2-4) guest_claim：guest_session 指向的訪客且至少有一個對話 root 時為 {"chat_count": n}，否則 None。唯讀，不刪任何列。
    """
    openrouter_connected = session.get(OpenRouterCredential, user.id) is not None
    guest_claim = None
    g = pending_guest(request, session, user)
    if g is not None:
        n = guest.count_chat_roots(session, g.id)
        if n > 0:
            guest_claim = {"chat_count": n}
    return JSONResponse(
        {
            "email": user.email,
            "provider": user.oauth_provider,
            "is_guest": user.is_guest,
            "openrouter_connected": openrouter_connected,
            "guest_claim": guest_claim,
        },
        headers={"Cache-Control": "no-store"},
    )


class GuestClaimRequest(BaseModel):
    action: Literal["merge", "discard"]


@router.post("/guest-claim")
@limiter.limit("10/minute")
def guest_claim(
    payload: GuestClaimRequest,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """(G2-4) 把 guest_session 指向的訪客對話合併到目前登入帳號（merge），或直接刪除（discard）。

    身分只來自兩個 cookie（session＝登入者、guest_session＝訪客），請求 body 不接受任何 user／guest／chat id。
    單一交易：merge 先搬移再刪訪客列；discard 直接刪訪客與其資料；最後一次 commit。
    """
    if user.is_guest:
        raise HTTPException(status_code=403, detail={"code": "guest_cannot_claim"})

    g = pending_guest(request, session, user)
    if g is None:
        response = JSONResponse(status_code=409, content={"detail": {"code": "no_pending_claim"}})
        clear_guest_session_cookie(response)
        return response

    guest_id = g.id
    user_id = user.id
    n = guest.count_chat_roots(session, guest_id)
    if payload.action == "merge":
        guest.move_user_data(session, guest_id, user_id)
        guest.delete_guest_user(session, guest_id, keep_data=True)
    else:
        guest.delete_guest_user(session, guest_id, keep_data=False)
    session.commit()

    response = JSONResponse(
        {"status": "ok", "action": payload.action, "chat_count": n},
        headers={"Cache-Control": "no-store"},
    )
    clear_guest_session_cookie(response)
    return response


@router.post("/logout")
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
