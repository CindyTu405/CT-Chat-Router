"""(S-U1 / B10) OAuth 登入流程測試腳本（假 provider，不打任何外部網路）。

用法：cd backend && uv run python dev/auth_harness.py

做的事：
- 在 127.0.0.1:8767 起真的 uvicorn（背景 thread）。
- patch 假的 GitHub provider：authorize_redirect / authorize_access_token / _fetch_github_user。
- 用 subprocess curl（-b/-c cookie 檔、-D 取原始標頭）逐步重播登入流程。
  不用 httpx / TestClient 的 cookie jar 判斷，因為 Python 的 jar 會掩蓋 B10（同名 cookie 被覆蓋）。
- 結束時只刪本腳本建立的 user 與 auth_session。
"""
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from urllib.parse import parse_qs, urlparse

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

import uvicorn  # noqa: E402
from fastapi.responses import RedirectResponse  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

import auth_routes  # noqa: E402
import main  # noqa: E402
from database import engine  # noqa: E402
from models import AuthSession, User  # noqa: E402

engine.echo = False
main.limiter.enabled = False

PORT = 8767
BASE = f"http://127.0.0.1:{PORT}"

UNIQ = uuid.uuid4().hex[:12]
FAKE_SUB = int(UNIQ, 16)
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


def cleanup():
    try:
        with Session(engine) as s:
            users = s.exec(select(User).where(
                User.oauth_provider == "github", User.oauth_sub == str(FAKE_SUB))).all()
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


def main_entry() -> int:
    server = None
    try:
        server = start_server()
        run_login_flow()
    except Exception as e:
        check("harness setup", False, f"exception: {e!r}")
    finally:
        if server is not None:
            server.should_exit = True
        cleanup()

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
