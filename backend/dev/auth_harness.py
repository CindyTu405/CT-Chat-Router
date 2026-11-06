"""(S-U1 / B10) OAuth 登入流程測試腳本（假 provider，不打任何外部網路）。

用法：cd backend && uv run python dev/auth_harness.py

做的事：
- 在 127.0.0.1:8767 起真的 uvicorn（背景 thread）。
- patch 假的 GitHub provider：authorize_redirect / authorize_access_token / _fetch_github_user。
- 用 subprocess curl（-b/-c cookie 檔、-D 取原始標頭）逐步重播登入流程。
  不用 httpx / TestClient 的 cookie jar 判斷，因為 Python 的 jar 會掩蓋 B10（同名 cookie 被覆蓋）。
- (S-U1-4) 路由保護與隔離測試：列舉 app.routes 驗證未登入全部 401、使用者 B 打 A 的資料全部 404 且 A 的資料
  與假 LLM 呼叫次數都沒變、生成中 B 讀不到緩衝、A 自己的完整流程、父子 user_id 一致、回應不含 user_id。
  假 LLM（絕不呼叫真模型）。
- (S-U1-9) 擁有者必填：以原始 SQL 寫入 user_id 為 NULL 的 message 與 branch，各自都必須 IntegrityError 且回復。
- 結束時只刪本腳本建立的 user、auth_session、分支與訊息。
"""
import asyncio
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import httpx

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

import uvicorn  # noqa: E402
from authlib.integrations.base_client import OAuthError  # noqa: E402
from fastapi.responses import RedirectResponse  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402
from sqlalchemy import text as sa_text  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

import auth_routes  # noqa: E402
import main  # noqa: E402
from database import engine  # noqa: E402
from models import AuthSession, Branch, Message, User  # noqa: E402

engine.echo = False
main.limiter.enabled = False
main.BUFFER_RETENTION_SECONDS = 2
# 不讓白名單檢查去抓 OpenRouter 免費模型清單（外部網路）
main.get_free_models = lambda session, force_refresh=False: []

# (S-U1-4) 假 LLM：記錄每次呼叫；message 以 "GATED" 開頭時在中途等 GATE（用來測「生成中」）。
LLM_CALLS: list = []
GATE = threading.Event()
GATE.set()


async def fake_llm_stream(message, history, model):
    LLM_CALLS.append(message)
    yield "MOCK-"
    if message.startswith("GATED"):
        while not GATE.is_set():
            await asyncio.sleep(0.02)
    yield "REPLY"


main.gemini_chat_stream = fake_llm_stream
main.openrouter_chat_stream = fake_llm_stream

PORT = 8767
BASE = f"http://127.0.0.1:{PORT}"

UNIQ = uuid.uuid4().hex[:12]
FAKE_SUB = int(UNIQ, 16)
DIRECT_SUB = f"{FAKE_SUB}-direct"
FAKE_EMAIL = f"auth-harness-{UNIQ}@example.invalid"

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = ""):
    RESULTS.append((name, bool(cond), detail))
    print(f"PASS {name}" if cond else f"FAIL {name}: {detail}")


# ===== 假 provider =====

async def fake_authorize_redirect(request, redirect_uri):
    state = uuid.uuid4().hex
    request.session[f"_state_github_{state}"] = {"data": {}}
    return RedirectResponse(f"{redirect_uri}?code=fake-code&state={state}", status_code=302)


async def fake_authorize_access_token(request):
    state = request.query_params.get("state")
    popped = request.session.pop(f"_state_github_{state}", None)
    if popped is None:
        raise RuntimeError("state not found in session (cookie lost)")
    return {"access_token": "fake"}


async def fake_fetch_github_user(token):
    return {"id": FAKE_SUB, "email": FAKE_EMAIL}


auth_routes.is_provider_configured = lambda provider: True
auth_routes.oauth.github.authorize_redirect = fake_authorize_redirect
auth_routes.oauth.github.authorize_access_token = fake_authorize_access_token
auth_routes._fetch_github_user = fake_fetch_github_user


# ===== curl 工具 =====

def curl(url: str, jar: str, hdr_file: str) -> tuple[str, dict[str, str]]:
    """GET（不跟隨轉址），回傳 (原始標頭文字, 解析後的標頭 dict，key 小寫、只留最後一個)。"""
    subprocess.run(
        ["curl", "-s", "-o", os.devnull, "-b", jar, "-c", jar, "-D", hdr_file, url],
        check=True, timeout=30,
    )
    with open(hdr_file, encoding="utf-8") as f:
        raw = f.read()
    hdrs: dict[str, str] = {}
    for line in raw.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            hdrs[k.strip().lower()] = v.strip()
    return raw, hdrs


def set_cookies(raw: str) -> list[tuple[str, str, str]]:
    """從原始標頭取出所有 Set-Cookie：(name, value, 整行)。"""
    out = []
    for line in raw.splitlines():
        if line.lower().startswith("set-cookie:"):
            full = line.split(":", 1)[1].strip()
            nv = full.split(";", 1)[0]
            name, _, value = nv.partition("=")
            out.append((name.strip(), value.strip(), full))
    return out


def jar_cookies(jar: str) -> dict[str, str]:
    out = {}
    with open(jar, encoding="utf-8") as f:
        lines = f.read().splitlines()
    for line in lines:
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#") or not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) >= 7:
            out[parts[5]] = parts[6]
    return out


def run_login_flow():
    tmp = tempfile.mkdtemp(prefix="auth-harness-")
    jar = os.path.join(tmp, "jar.txt")
    open(jar, "w").close()
    try:
        raw1, h1 = curl(f"{BASE}/auth/github/login", jar, os.path.join(tmp, "h1.txt"))
        sc1 = set_cookies(raw1)
        names1 = [n for n, _, _ in sc1]
        check("a. login sets oauth_state", "oauth_state" in names1, f"Set-Cookie names: {names1}")
        check("a. login does not set session", "session" not in names1, f"Set-Cookie names: {names1}")

        location = h1.get("location", "")
        check("a. login redirects to callback with state",
              "/auth/github/callback" in location and "state" in parse_qs(urlparse(location).query),
              f"Location: {location}")

        raw2, _ = curl(location, jar, os.path.join(tmp, "h2.txt"))
        sc2 = set_cookies(raw2)
        sess = [c for c in sc2 if c[0] == "session"]
        token = sess[0][1] if sess else ""
        check("b. callback sets session exactly once", len(sess) == 1, f"count={len(sess)}; {sc2}")
        check("b. session value not null and non-empty",
              len(sess) >= 1 and token not in ("", "null", '"null"'), f"value={token!r}")

        st = [c for c in sc2 if c[0] == "oauth_state"]
        cleared = any(
            v in ("", "null", '"null"') or "max-age=0" in full.lower() or "1970" in full
            for _, v, full in st
        )
        check("c. callback clears oauth_state", cleared, f"oauth_state Set-Cookie: {st}")

        jc = jar_cookies(jar)
        check("d. cookie jar has session matching callback token",
              bool(token) and jc.get("session") == token, f"jar session={jc.get('session')!r}")

        with Session(engine) as s:
            user = s.exec(select(User).where(
                User.oauth_provider == "github", User.oauth_sub == str(FAKE_SUB))).first()
            row = None
            if user is not None and token:
                row = s.exec(select(AuthSession).where(
                    AuthSession.user_id == user.id,
                    AuthSession.token_hash == auth_routes.hash_token(token))).first()
        check("e. hash_token(token) exists in auth_session for created user", row is not None,
              f"user={'found' if user else 'missing'}")
    finally:
        for f in os.listdir(tmp):
            os.remove(os.path.join(tmp, f))
        os.rmdir(tmp)


def counts() -> tuple[int, int]:
    with Session(engine) as s:
        return (len(s.exec(select(User)).all()), len(s.exec(select(AuthSession)).all()))


def hit(method: str, path: str, token: str | None = None) -> httpx.Response:
    cookies = {"session": token} if token else None
    return httpx.request(method, BASE + path, cookies=cookies, follow_redirects=False, timeout=30)


def run_endpoint_checks():
    # /auth/me
    check("me: no cookie -> 401", hit("GET", "/auth/me").status_code == 401)
    check("me: bogus token -> 401", hit("GET", "/auth/me", "made-up-token").status_code == 401)

    with Session(engine) as s:
        user = User(oauth_provider="github", oauth_sub=DIRECT_SUB, email=FAKE_EMAIL)
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    with Session(engine) as s2:
        try:
            s2.add(User(oauth_provider="github", oauth_sub=DIRECT_SUB, email=FAKE_EMAIL))
            s2.commit()
            dup_rejected = False
        except IntegrityError:
            s2.rollback()
            dup_rejected = True
    check("duplicate (oauth_provider, oauth_sub) -> IntegrityError", dup_rejected)
    with Session(engine) as s:
        exp_token = auth_routes.generate_session_token()
        s.add(AuthSession(user_id=uid, token_hash=auth_routes.hash_token(exp_token),
                          expires_at=auth_routes.utcnow_naive() - timedelta(minutes=1)))
        s.commit()
    r = hit("GET", "/auth/me", exp_token)
    with Session(engine) as s:
        left = s.exec(select(AuthSession).where(
            AuthSession.token_hash == auth_routes.hash_token(exp_token))).first()
    check("me: expired -> 401", r.status_code == 401, str(r.status_code))
    check("me: expired row deleted", left is None)

    with Session(engine) as s:
        u = s.get(User, uid)
        token = auth_routes.create_session_token(s, u)
    r = hit("GET", "/auth/me", token)
    check("me: valid -> 200", r.status_code == 200, str(r.status_code))
    body = r.json() if r.status_code == 200 else {}
    check("me: keys exactly email, provider", set(body) == {"email", "provider"}, str(body))
    check("me: values correct", body.get("email") == FAKE_EMAIL and body.get("provider") == "github", str(body))
    check("me: Cache-Control no-store", r.headers.get("cache-control") == "no-store",
          str(r.headers.get("cache-control")))

    # logout
    check("logout: GET -> 405", hit("GET", "/auth/logout", token).status_code == 405)
    r = hit("POST", "/auth/logout", token)
    check("logout: POST -> 200", r.status_code == 200, str(r.status_code))
    sc = [h for h in r.headers.get_list("set-cookie") if h.startswith("session=")]
    check("logout: Set-Cookie deletes session",
          bool(sc) and ("max-age=0" in sc[0].lower() or "1970" in sc[0]), str(sc))
    check("logout: token then /auth/me -> 401", hit("GET", "/auth/me", token).status_code == 401)

    # unknown provider
    check("unknown provider login -> 404", hit("GET", "/auth/nope/login").status_code == 404)
    check("unknown provider callback -> 404", hit("GET", "/auth/nope/callback").status_code == 404)

    # provider not configured
    auth_routes.is_provider_configured = lambda provider: False
    try:
        for path in ("/auth/github/login", "/auth/github/callback"):
            r = hit("GET", path)
            loc = r.headers.get("location", "")
            check(f"unconfigured {path} -> 303 provider_unavailable",
                  r.status_code == 303 and "auth_error=provider_unavailable" in loc and "//?" not in loc,
                  f"{r.status_code} {loc}")
    finally:
        auth_routes.is_provider_configured = lambda provider: True

    # callback failures
    orig_token, orig_fetch = auth_routes.oauth.github.authorize_access_token, auth_routes._fetch_github_user

    async def raise_oauth(request):
        raise OAuthError(error="access_denied")

    async def raise_generic(request):
        raise RuntimeError("boom")

    async def ok_token(request):
        return {"access_token": "fake"}

    async def no_id(token):
        return {"email": FAKE_EMAIL}

    cases = [
        ("OAuthError", raise_oauth, orig_fetch),
        ("generic Exception", raise_generic, orig_fetch),
        ("no id from provider", ok_token, no_id),
    ]
    for name, tok_fn, fetch_fn in cases:
        auth_routes.oauth.github.authorize_access_token = tok_fn
        auth_routes._fetch_github_user = fetch_fn
        try:
            before = counts()
            r = hit("GET", "/auth/github/callback?code=x&state=y")
            loc = r.headers.get("location", "")
            check(f"callback {name} -> 303 login_failed",
                  r.status_code == 303 and "auth_error=login_failed" in loc, f"{r.status_code} {loc}")
            check(f"callback {name}: no session cookie",
                  not any(h.startswith("session=") for h in r.headers.get_list("set-cookie")))
            check(f"callback {name}: user/auth_session counts unchanged", counts() == before)
        finally:
            auth_routes.oauth.github.authorize_access_token = orig_token
            auth_routes._fetch_github_user = orig_fetch


# ===== (S-U1-4) 路由保護與隔離 =====

ISO_UIDS: list = []          # 本腳本建立的使用者 id
DOC_PATHS = {"/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"}


def make_user(label: str) -> tuple[uuid.UUID, str]:
    """直接建立 User + AuthSession，回傳 (user_id, 原始 token)。"""
    with Session(engine) as s:
        u = User(oauth_provider="github", oauth_sub=f"iso-{label}-{UNIQ}",
                 email=f"iso-{label}-{UNIQ}@example.invalid")
        s.add(u)
        s.commit()
        s.refresh(u)
        ISO_UIDS.append(u.id)
        token = auth_routes.create_session_token(s, u)
        return u.id, token


def snap(uids: list) -> tuple[dict, dict]:
    """這些使用者所有訊息與分支欄位的快照（用來證明沒被改動）。"""
    with Session(engine) as s:
        msgs = s.exec(select(Message).where(Message.user_id.in_(uids))).all()
        brs = s.exec(select(Branch).where(Branch.user_id.in_(uids))).all()
        return (
            {str(m.id): (m.content, m.title, m.parent_id, m.branch_id, m.anchor_message_id,
                         m.has_branch, m.model_used, m.role, m.user_id) for m in msgs},
            {str(b.id): (b.root_message_id, b.anchor_message_id, b.attach_root_id, b.is_orphaned,
                         b.anchor_text, b.anchor_start, b.anchor_end, b.title,
                         b.parent_branch_id, b.user_id) for b in brs},
        )


def post_stream(client: httpx.Client, path: str, body: dict):
    """POST 並讀完整個 body，回傳 (status, headers, text)。"""
    with client.stream("POST", path, json=body) as r:
        txt = r.read().decode("utf-8")
        return r.status_code, r.headers, txt


def wait_db_content(msg_id, expected: str, timeout: float = 5.0) -> bool:
    """生成結束後 DB 寫回稍晚於串流結束，輪詢等它。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with Session(engine) as s:
            m = s.get(Message, uuid.UUID(str(msg_id)))
            if m is not None and m.content == expected:
                return True
        time.sleep(0.05)
    return False


def db_owner(msg_id):
    with Session(engine) as s:
        m = s.get(Message, uuid.UUID(str(msg_id)))
        return m.user_id if m is not None else "MISSING"


def make_msg(uid, role: str, content: str, parent_id=None, branch_id=None, title=None) -> uuid.UUID:
    with Session(engine) as s:
        m = Message(role=role, content=content, parent_id=parent_id, branch_id=branch_id,
                    title=title, user_id=uid,
                    model_used="gemini-2.5-flash" if role == "assistant" else None)
        s.add(m)
        s.commit()
        s.refresh(m)
        return m.id


def make_orphan(uid, title: str, root_message_id=None) -> uuid.UUID:
    with Session(engine) as s:
        b = Branch(title=title, anchor_text="x", is_orphaned=True, root_message_id=root_message_id,
                   user_id=uid)
        s.add(b)
        s.commit()
        s.refresh(b)
        return b.id


def foreign_matrix(c: httpx.Client, root, ai, br, own_root, own_ai, own_br, model: str) -> list:
    """以 c 的身分，對「不屬於 c 的資源」(root/ai/br) 呼叫上表每條路由。回傳 [(name, status)]，期望全是 404。
    own_* 是 c 自己的資源，用來把「只有一個參數不屬於自己」的情況單獨測出來。"""
    def branch_body(anchor):
        return {"anchor_message_id": str(anchor), "anchor_text": "x", "anchor_start": 0, "anchor_end": 1}

    def relink_body(rt, an):
        return {"root_id": str(rt), "anchor_message_id": str(an), "anchor_start": 0,
                "anchor_end": 1, "anchor_text": "x"}

    def chat_body(**kw):
        return {"message": "hack", "model": model, **{k: str(v) for k, v in kw.items()}}

    reqs = [
        ("history", "GET", f"/chats/{root}/history", None),
        ("tree", "GET", f"/chats/{root}/tree", None),
        ("list branches", "GET", f"/chats/{root}/branches", None),
        ("title", "PATCH", f"/chats/{root}/title", {"title": "HACKED"}),
        ("delete", "DELETE", f"/chats/{root}", None),
        ("create branch (root+anchor foreign)", "POST", f"/chats/{root}/branches", branch_body(ai)),
        ("create branch (root own, anchor foreign)", "POST", f"/chats/{own_root}/branches", branch_body(ai)),
        ("create branch (root foreign, anchor own)", "POST", f"/chats/{root}/branches", branch_body(own_ai)),
        ("stream ai", "GET", f"/messages/{ai}/stream", None),
        ("stream user msg", "GET", f"/messages/{root}/stream", None),
        ("regenerate", "POST", f"/messages/{ai}/regenerate", {"model": model}),
        ("chat parent_id", "POST", "/chat", chat_body(parent_id=ai)),
        ("chat branch_id", "POST", "/chat", chat_body(branch_id=br)),
        ("chat anchor_message_id", "POST", "/chat", chat_body(anchor_message_id=ai)),
        ("relink all foreign", "POST", f"/branches/{br}/relink", relink_body(root, ai)),
        ("relink branch foreign only", "POST", f"/branches/{br}/relink", relink_body(own_root, own_ai)),
        ("relink root foreign only", "POST", f"/branches/{own_br}/relink", relink_body(root, own_ai)),
        ("relink anchor foreign only", "POST", f"/branches/{own_br}/relink", relink_body(own_root, ai)),
    ]
    out = []
    for name, method, path, body in reqs:
        r = c.request(method, path, json=body) if body is not None else c.request(method, path)
        out.append((name, r.status_code))
    return out


def run_route_enumeration():
    """從 app.routes 動態列舉（不寫死），未登入呼叫每條受保護路由都必須 401。"""
    docs_on = main._DOCS_ON
    routes: list[tuple[str, str]] = []
    for route in main.app.routes:
        methods = getattr(route, "methods", None)
        path = getattr(route, "path", None)
        if not methods or not path:
            continue
        for m in sorted(set(methods) - {"HEAD", "OPTIONS"}):
            routes.append((m, path))

    present_docs = sorted({p for _, p in routes} & DOC_PATHS)
    check("enum: doc routes absent (ENABLE_API_DOCS off)", docs_on or not present_docs, str(present_docs))
    for p in ("/docs", "/openapi.json", "/redoc"):
        if not docs_on:
            check(f"enum: GET {p} -> 404", hit("GET", p).status_code == 404)

    protected = [(m, p) for m, p in routes
                 if p != "/" and not p.startswith("/auth/") and not (docs_on and p in DOC_PATHS)]
    check("enum: found >= 13 protected routes", len(protected) >= 13, f"found {len(protected)}: {protected}")
    calls_before = len(LLM_CALLS)
    for method, path in protected:
        url = re.sub(r"\{[^}]+\}", lambda _m: str(uuid.uuid4()), path)
        kw = {"json": {}} if method in ("POST", "PUT", "PATCH") else {}
        r = httpx.request(method, BASE + url, follow_redirects=False, timeout=30, **kw)
        check(f"enum: no cookie {method} {path} -> 401", r.status_code == 401, str(r.status_code))
    check("enum: LLM not called without login", len(LLM_CALLS) == calls_before)
    check("enum: GET / stays public", hit("GET", "/").status_code == 200)


def run_isolation_checks():
    model = next((m for m in ["gemini-2.5-flash-lite", "gemini-2.5-flash"] if main.is_model_allowed(m)), None)
    check("iso setup: an allowed gemini model exists", model is not None, "no allowed model")
    if model is None:
        return

    uid_a, tok_a = make_user("a")
    uid_b, tok_b = make_user("b")
    with httpx.Client(base_url=BASE, timeout=30, cookies={"session": tok_a}) as ca, \
            httpx.Client(base_url=BASE, timeout=30, cookies={"session": tok_b}) as cb:
        _run_isolation(ca, cb, uid_a, uid_b, model)


def _run_isolation(ca: httpx.Client, cb: httpx.Client, uid_a, uid_b, model: str):
    # ---------- A 的完整流程（第一段：送、列、取、建分支、分支內送、幽靈化）----------
    st, h, body = post_stream(ca, "/chat", {"message": "hello A", "model": model})
    check("A flow: send /chat -> 200 and mock reply", st == 200 and body == "MOCK-REPLY", f"{st} {body!r}")
    R, A1 = h.get("x-user-message-id"), h.get("x-message-id")
    check("A flow: user and AI messages carry user_id=A", db_owner(R) == uid_a and db_owner(A1) == uid_a,
          f"{db_owner(R)} {db_owner(A1)}")
    check("A flow: AI content persisted", wait_db_content(A1, "MOCK-REPLY"))
    r = ca.patch(f"/chats/{R}/title", json={"title": "A title"})
    check("A flow: title -> 200", r.status_code == 200 and r.json().get("title") == "A title", r.text[:200])

    for sort_by in ("created", "updated"):
        r = ca.get("/chats/roots", params={"sort_by": sort_by})
        ids_in = [i["id"] for i in r.json()] if r.status_code == 200 else []
        check(f"A flow: roots sort_by={sort_by} lists R", r.status_code == 200 and R in ids_in, f"{r.status_code}")
        check(f"A flow: roots sort_by={sort_by} no user_id key", "user_id" not in r.text)
    for name in ("history", "tree"):
        r = ca.get(f"/chats/{R}/{name}")
        ids_in = [i["id"] for i in r.json()] if r.status_code == 200 else []
        check(f"A flow: {name} contains R and A1", R in ids_in and A1 in ids_in, f"{r.status_code}")
        check(f"A flow: {name} no user_id key", "user_id" not in r.text)

    r = ca.post(f"/chats/{R}/branches", json={"anchor_message_id": A1, "anchor_text": "MOCK",
                                             "anchor_start": 0, "anchor_end": 4})
    check("A flow: create branch -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("A flow: create branch response no user_id", "user_id" not in r.text)
    BR = r.json().get("branch_id")
    with Session(engine) as s:
        b = s.get(Branch, uuid.UUID(BR))
        check("A flow: branch carries user_id=A", b is not None and b.user_id == uid_a)

    st, h, body = post_stream(ca, "/chat", {"message": "branch Q", "model": model, "parent_id": A1,
                                            "branch_id": BR, "anchor_message_id": A1})
    check("A flow: send in branch -> 200", st == 200 and body == "MOCK-REPLY", f"{st} {body!r}")
    RB1, RB1_AI = h.get("x-user-message-id"), h.get("x-message-id")
    check("A flow: branch messages carry user_id=A", db_owner(RB1) == uid_a and db_owner(RB1_AI) == uid_a)
    check("A flow: branch AI content persisted", wait_db_content(RB1_AI, "MOCK-REPLY"))
    with Session(engine) as s:
        b = s.get(Branch, uuid.UUID(BR))
        check("A flow: branch root_message_id filled by first message", b.root_message_id == uuid.UUID(RB1))
    r = ca.get(f"/chats/{R}/branches")
    check("A flow: list branches contains BR", r.status_code == 200 and any(i["id"] == BR for i in r.json()))
    check("A flow: list branches no user_id key", "user_id" not in r.text)

    st, h, body = post_stream(ca, f"/messages/{A1}/regenerate", {"model": model})
    check("A flow: regenerate A1 -> 200", st == 200 and body == "MOCK-REPLY", f"{st} {body!r}")
    check("A flow: regenerate orphans BR (header)", BR in h.get("x-orphaned-branch-ids", ""))
    r = ca.get("/branches/orphaned")
    items = r.json() if r.status_code == 200 else []
    check("A flow: orphaned lists BR with exact keys",
          any(i["id"] == BR for i in items)
          and all(set(i) == {"id", "title", "anchor_text", "root_message_id", "created_at"} for i in items),
          f"{r.status_code} {r.text[:200]}")
    check("A flow: orphaned no user_id key", "user_id" not in r.text)

    # ---------- B 的資料 ----------
    B_ROOT = make_msg(uid_b, "user", "B root", title="B title")
    B_AI = make_msg(uid_b, "assistant", "B-AI-CONTENT", parent_id=B_ROOT)
    B_BR = make_orphan(uid_b, "B orphan")

    snap0 = snap([uid_a, uid_b])
    calls0 = len(LLM_CALLS)

    # ---------- B 對 A 的資料：每條路由 404 ----------
    res = foreign_matrix(cb, R, A1, BR, B_ROOT, B_AI, B_BR, model)
    for name, status in res:
        check(f"B vs A: {name} -> 404", status == 404, str(status))
    # B 單獨用 A 的 parent_id / branch_id / anchor_message_id 打 /chat（上面已含，這裡再確認筆數）
    check("B vs A: A's/B's rows unchanged", snap([uid_a, uid_b]) == snap0)
    check("B vs A: message count unchanged", len(snap([uid_a, uid_b])[0]) == len(snap0[0]))
    check("B vs A: A title unchanged", snap([uid_a])[0][R][1] == "A title")
    check("B vs A: LLM not called", len(LLM_CALLS) == calls0, f"{len(LLM_CALLS) - calls0} calls")
    for sort_by in ("created", "updated"):
        r = cb.get("/chats/roots", params={"sort_by": sort_by})
        ids_in = [i["id"] for i in r.json()] if r.status_code == 200 else []
        check(f"B vs A: B roots sort_by={sort_by} has only B's", str(B_ROOT) in ids_in and R not in ids_in,
              str(ids_in))
    r = cb.get("/branches/orphaned")
    ids_in = [i["id"] for i in r.json()] if r.status_code == 200 else []
    check("B vs A: B orphaned lists only B's", str(B_BR) in ids_in and BR not in ids_in, str(ids_in))
    check("B control: own history works", cb.get(f"/chats/{B_ROOT}/history").status_code == 200)
    check("B control: /api/free-models with login -> 200", cb.get("/api/free-models").status_code == 200)

    # ---------- 生成中：B 讀不到緩衝（先查擁有者、再查 GENERATIONS）----------
    GATE.clear()
    try:
        with ca.stream("POST", "/chat", json={"message": "GATED run", "model": model}) as ra:
            ai_if = ra.headers.get("x-message-id")
            user_if = ra.headers.get("x-user-message-id")
            buf = main.GENERATIONS.get(ai_if)
            check("in-flight: generation is really in flight", ra.status_code == 200 and buf is not None
                  and not buf["done"], f"{ra.status_code} buf={buf}")
            with cb.stream("GET", f"/messages/{ai_if}/stream") as rb:
                check("in-flight: B stream -> 404", rb.status_code == 404, str(rb.status_code))
            with httpx.stream("GET", f"{BASE}/messages/{ai_if}/stream", timeout=10) as rn:
                check("in-flight: no cookie stream -> 401", rn.status_code == 401, str(rn.status_code))
            with ca.stream("GET", f"/messages/{ai_if}/stream", params={"offset": 0}) as rs:
                check("in-flight: A own stream -> 200", rs.status_code == 200, str(rs.status_code))
                GATE.set()
                resumed = rs.read().decode("utf-8")
            check("in-flight: A stream reaches the end", resumed == "MOCK-REPLY", repr(resumed))
            first = ra.read().decode("utf-8")
            check("in-flight: A original response complete", first == "MOCK-REPLY", repr(first))
    finally:
        GATE.set()
    check("in-flight: AI content persisted", wait_db_content(ai_if, "MOCK-REPLY"))
    with cb.stream("GET", f"/messages/{ai_if}/stream") as rb:
        check("in-flight: B stream after done -> 404", rb.status_code == 404, str(rb.status_code))
    check("in-flight: rows unchanged for others", snap([uid_b])[0] == {k: v for k, v in snap0[0].items()
                                                                        if v[-1] == uid_b})

    # ---------- A 的完整流程（第二段：重連、再送、刪除）----------
    r = ca.post(f"/branches/{BR}/relink", json={"root_id": R, "anchor_message_id": A1, "anchor_start": 0,
                                               "anchor_end": 4, "anchor_text": "MOCK"})
    check("A flow: relink -> 200", r.status_code == 200 and r.json().get("reused") is False,
          f"{r.status_code} {r.text[:200]}")
    check("A flow: relink response no user_id", "user_id" not in r.text)
    r = ca.get("/branches/orphaned")
    check("A flow: orphaned no longer lists BR", BR not in [i["id"] for i in r.json()])
    r = ca.get(f"/chats/{R}/branches")
    check("A flow: BR precise after relink", any(i["id"] == BR and i["precise"] is True for i in r.json()))
    st, h, body = post_stream(ca, "/chat", {"message": "after relink", "model": model,
                                            "parent_id": RB1_AI, "branch_id": BR})
    check("A flow: send in relinked branch -> 200", st == 200 and body == "MOCK-REPLY", f"{st} {body!r}")
    wait_db_content(h.get("x-message-id"), "MOCK-REPLY")

    # ---------- 父子 user_id 一致（限本次資料）----------
    uids = [str(uid_a), str(uid_b)]
    with Session(engine) as s:
        mismatch = s.exec(sa_text(
            "SELECT count(*) FROM message c JOIN message p ON c.parent_id = p.id "
            "WHERE c.user_id IS DISTINCT FROM p.user_id "
            "AND (c.user_id = ANY(CAST(:u AS uuid[])) OR p.user_id = ANY(CAST(:u AS uuid[])))"
        ), params={"u": uids}).scalar()
    check("parent/child user_id mismatch count (this run) == 0", mismatch == 0, str(mismatch))

    # 刪除含分支的那串 R（B11）：R、A1、分支 BR 的首則與回覆、重連後的兩則 → 6 則訊息、1 條分支，回 200。
    r = ca.delete(f"/chats/{R}")
    check("A flow: delete chat with branch -> 200 (6 messages, 1 branch)",
          r.status_code == 200 and r.json() == {"status": "ok", "deleted_count": 6, "deleted_branches": 1},
          f"{r.status_code} {r.text[:200]}")
    check("A flow: history after delete -> 404", ca.get(f"/chats/{R}/history").status_code == 404)
    with Session(engine) as s:
        check("A flow: branch BR gone after delete", s.get(Branch, uuid.UUID(BR)) is None)
    check("B rows still exist after A delete", snap([uid_b])[0].keys() == {k for k, v in snap0[0].items()
                                                                          if v[-1] == uid_b})


# ===== (S-U1-9) 擁有者必填 =====

NULL_PROBE = f"owner-null-probe-{UNIQ}"


def run_owner_constraint_checks():
    """以原始 SQL 寫入 user_id 為 NULL：DB 必須 IntegrityError（指名 user_id），且該列不得留下。"""
    for table, model, sql, params in [
        ("message", Message,
         "INSERT INTO message (id, content, role, created_at, has_branch, user_id) "
         "VALUES (:id, :content, 'user', now(), false, NULL)",
         lambda i: {"id": i, "content": NULL_PROBE}),
        ("branch", Branch,
         "INSERT INTO branch (id, is_orphaned, created_at, user_id) "
         "VALUES (:id, false, now(), NULL)",
         lambda i: {"id": i}),
    ]:
        probe_id = uuid.uuid4()
        err = None
        with Session(engine) as s:
            try:
                s.execute(sa_text(sql), params(probe_id))
                s.commit()
            except IntegrityError as e:
                s.rollback()
                err = str(e.orig)
        check(f"owner: raw NULL user_id {table} -> IntegrityError on user_id",
              err is not None and "user_id" in err, str(err))
        with Session(engine) as s:
            left = s.get(model, probe_id)
        check(f"owner: raw NULL user_id {table} rolled back (no row)", left is None, str(left))


def cleanup_iso():
    """刪除本腳本在隔離測試建立的資料：訊息、分支、auth_session、使用者。"""
    try:
        with Session(engine) as s:
            msgs = s.exec(select(Message).where(Message.user_id.in_(ISO_UIDS))).all() if ISO_UIDS else []
            msg_ids = {m.id for m in msgs}
            branch_ids = {m.branch_id for m in msgs if m.branch_id}
            if ISO_UIDS:
                branch_ids |= set(s.exec(select(Branch.id).where(Branch.user_id.in_(ISO_UIDS))).all())
            if msg_ids:
                branch_ids |= set(s.exec(select(Branch.id).where(
                    Branch.anchor_message_id.in_(msg_ids)
                    | Branch.root_message_id.in_(msg_ids)
                    | Branch.attach_root_id.in_(msg_ids)
                )).all())
        if branch_ids:
            with Session(engine) as s:
                for b in s.exec(select(Branch).where(Branch.id.in_(branch_ids))).all():
                    b.root_message_id = None
                    b.anchor_message_id = None
                    b.attach_root_id = None
                    b.parent_branch_id = None
                    s.add(b)
                s.commit()
        if msg_ids:
            with Session(engine) as s:
                for m in s.exec(select(Message).where(Message.id.in_(msg_ids))).all():
                    m.parent_id = None
                    m.branch_id = None
                    m.anchor_message_id = None
                    s.add(m)
                s.commit()
            with Session(engine) as s:
                for m in s.exec(select(Message).where(Message.id.in_(msg_ids))).all():
                    s.delete(m)
                s.commit()
        if branch_ids:
            with Session(engine) as s:
                for b in s.exec(select(Branch).where(Branch.id.in_(branch_ids))).all():
                    s.delete(b)
                s.commit()
        if ISO_UIDS:
            with Session(engine) as s:
                for a in s.exec(select(AuthSession).where(AuthSession.user_id.in_(ISO_UIDS))).all():
                    s.delete(a)
                s.commit()
                for u in s.exec(select(User).where(User.id.in_(ISO_UIDS))).all():
                    s.delete(u)
                s.commit()
        print(f"cleanup: isolation data removed ({len(msg_ids)} message(s), {len(branch_ids)} branch(es), "
              f"{len(ISO_UIDS)} user(s))")
    except Exception as e:
        print(f"cleanup (isolation) FAILED: {e}")


def cleanup():
    try:
        with Session(engine) as s:
            users = s.exec(select(User).where(
                User.oauth_provider == "github",
                User.oauth_sub.in_([str(FAKE_SUB), DIRECT_SUB]))).all()
            for u in users:
                for a in s.exec(select(AuthSession).where(AuthSession.user_id == u.id)).all():
                    s.delete(a)
                s.flush()
                s.delete(u)
            s.commit()
        print(f"cleanup: removed {len(users)} user(s)")
    except Exception as e:
        print(f"cleanup FAILED: {e}")


def start_server() -> uvicorn.Server:
    config = uvicorn.Config(main.app, host="127.0.0.1", port=PORT, log_level="warning")
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError(f"uvicorn did not start on 127.0.0.1:{PORT}")
    return server


def db_totals() -> tuple:
    with Session(engine) as s:
        return tuple(int(s.execute(sa_text(q)).scalar()) for q in (
            "SELECT count(*) FROM message", "SELECT count(*) FROM branch"))


def main_entry() -> int:
    server = None
    totals0 = db_totals()
    print(f"info: baseline messages/branches = {totals0}")
    try:
        server = start_server()
        run_login_flow()
        run_endpoint_checks()
        run_route_enumeration()
        run_isolation_checks()
        run_owner_constraint_checks()
    except Exception as e:
        import traceback
        traceback.print_exc()
        check("harness setup", False, f"exception: {e!r}")
    finally:
        if server is not None:
            server.should_exit = True
        GATE.set()
        cleanup_iso()
        cleanup()
        totals1 = db_totals()
        check("final: real rows unchanged (message/branch counts)",
              totals1 == totals0, f"{totals0} -> {totals1}")

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = [n for n, ok, _ in RESULTS if not ok]
    print(f"--- {passed} PASS, {len(failed)} FAIL ---")
    if failed or passed == 0:
        print("SOME FAIL")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main_entry())
