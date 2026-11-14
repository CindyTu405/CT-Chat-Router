"""(G2-8) OpenRouter 連結（OAuth PKCE）測試腳本：connect / callback / DELETE、加密儲存、state 一次性、跨身分、洩漏檢查。

用法（只用臨時資料庫 g2_tmp，不要指向正式 chat_db）：
    cd backend && POSTGRES_DB=g2_tmp SQL_ECHO=false uv run python dev/openrouter_connect_harness.py 2>&1 | grep -v sqlalchemy | tail -5

做的事：
- 在一個自由 port 起真的 uvicorn（背景 thread），proxy_headers=True。
- 每次執行在程序內產生新的 Fernet 金鑰放進 CREDENTIAL_ENCRYPTION_KEY（不讀任何 .env）。
- 把 openrouter_connect.exchange_code_for_key 換成假函式：記錄參數，回傳假金鑰 sk-or-v1-FAKEKEY-*。絕不呼叫 OpenRouter。
- 包裝 openrouter_connect.secrets，記下伺服器產生的每個 code_verifier 與 state，供最後的洩漏檢查使用。
- stdout、stderr 與所有 logger（含 uvicorn.access，INFO 等級）都寫進 CAPTURE，最後檢查裡面沒有任何機密。
- 結束時（即使失敗）只清掉本腳本建立的 user、session、openrouter_credential 與 guest_ip_usage 列。
"""
import contextlib
import io
import logging
import os
import random
import secrets as _real_secrets
import socket
import sys
import threading
import time
import uuid
from urllib.parse import parse_qs, urlencode, urlparse

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

os.environ["CORS_ORIGINS"] = "http://localhost:5173"
os.environ["FRONTEND_URL"] = "http://localhost:5173"
os.environ["ALLOWED_MODELS"] = "gemini*"

from cryptography.fernet import Fernet  # noqa: E402
import httpx  # noqa: E402
import uvicorn  # noqa: E402
from sqlalchemy import delete as sa_delete  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from database import engine  # noqa: E402

# 防呆：只允許 g2_tmp（在 import main 之前就停）
if engine.url.database != "g2_tmp":
    print("REFUSED: this harness only runs against the g2_tmp database (POSTGRES_DB=g2_tmp)")
    sys.exit(1)

# ---------- log / stdout 擷取（必須在 uvicorn 建立 config 之前安裝）----------
CAPTURE = io.StringIO()


class _Tee(io.TextIOBase):
    def __init__(self, orig):
        self.orig = orig

    def write(self, s):
        CAPTURE.write(s)
        return self.orig.write(s)

    def flush(self):
        self.orig.flush()


sys.stdout = _Tee(sys.stdout)
sys.stderr = _Tee(sys.stderr)

_log_handler = logging.StreamHandler(CAPTURE)
_log_handler.setLevel(logging.DEBUG)
_log_handler.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
for _name in ["", "uvicorn", "uvicorn.error", "uvicorn.access"]:
    logging.getLogger(_name).addHandler(_log_handler)
logging.getLogger().setLevel(logging.DEBUG)
# 測試端的 httpx／httpcore client 會把它發出的請求網址（含 code、state）寫進 log；那是測試端的 log，不是伺服器的，關掉。
for _name in ["httpx", "httpcore"]:
    logging.getLogger(_name).setLevel(logging.WARNING)

# 測試用的加密金鑰：每次執行新產生，只存在這個程序裡
FERNET_KEY = Fernet.generate_key().decode("ascii")
os.environ["CREDENTIAL_ENCRYPTION_KEY"] = FERNET_KEY

import main  # noqa: E402
import auth_routes  # noqa: E402
import crypto_utils  # noqa: E402
import openrouter_connect as oc  # noqa: E402
import guest  # noqa: E402
from models import AuthSession, DailyUsage, GuestIpUsage, OpenRouterCredential, User, GUEST_PROVIDER  # noqa: E402
from crypto_utils import CredentialKeyError, decrypt_key, encrypt_key  # noqa: E402

engine.echo = False
main.limiter.enabled = False

FRONTEND = "http://localhost:5173"
OR_AUTH = "https://openrouter.ai/auth"

# ---------- 假的 exchange 與 secrets 間諜 ----------
EX = {"calls": [], "key": None, "mode": "key"}   # mode: "key" 回傳 EX["key"]；"none" 回傳 None
ALL_KEYS: list[str] = []      # 本次測試產生過的假金鑰
ALL_CODES: list[str] = []     # 送進 callback 的 code
GENERATED: list[str] = []     # 伺服器產生的 code_verifier 與 state（由 secrets 間諜記下）
CIPHERS: list[str] = []       # 從資料庫讀到的密文


async def fake_exchange(code: str, code_verifier: str):
    EX["calls"].append((code, code_verifier))
    if EX["mode"] == "none":
        return None
    return EX["key"]


oc.exchange_code_for_key = fake_exchange


class _SecretsSpy:
    def token_urlsafe(self, nbytes=None):
        v = _real_secrets.token_urlsafe(nbytes)
        GENERATED.append(v)
        return v

    def __getattr__(self, name):
        return getattr(_real_secrets, name)


oc.secrets = _SecretsSpy()

# 過期測試：讓 callback 看到的「現在」往後推
TIME_SHIFT = {"sec": 0}
_real_now_unix = oc._now_unix


def _shifted_now_unix() -> int:
    return _real_now_unix() + TIME_SHIFT["sec"]


oc._now_unix = _shifted_now_unix


def new_fake_key() -> str:
    k = f"sk-or-v1-FAKEKEY-{_real_secrets.token_hex(12)}"
    ALL_KEYS.append(k)
    return k


# ---------- 結果 ----------
RESULTS: list[tuple[str, bool, str]] = []
CREATED_UIDS: list[uuid.UUID] = []
PREFIX = f"10.{random.randint(0, 255)}.{random.randint(0, 255)}"
GUEST_IPS: list[str] = []
S: dict = {}
OPEN_CLIENTS: list[httpx.Client] = []


def check(name: str, cond: bool, detail: str = ""):
    RESULTS.append((name, bool(cond), detail))
    if cond:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name}: {detail}")


def run(fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        check(fn.__name__, False, f"exception: {type(e).__name__}")


@contextlib.contextmanager
def env(**kv):
    old = {k: os.environ.get(k) for k in kv}
    for k, v in kv.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ---------- 身分與 client ----------

def mk_client() -> httpx.Client:
    c = httpx.Client(base_url=BASE, timeout=30, follow_redirects=False)
    OPEN_CLIENTS.append(c)
    return c


def with_session(token: str) -> httpx.Client:
    c = mk_client()
    c.cookies.set("session", token, domain="127.0.0.1", path="/")
    return c


def new_account(label: str) -> tuple[str, uuid.UUID]:
    """用 harness 直接建立登入帳號（同 guest_harness 的 auth_routes 寫法）。回傳 (session token, user id)。"""
    with Session(engine) as s:
        u = auth_routes.upsert_user(s, "github", f"g2-8-{label}-{uuid.uuid4()}", None)
        uid = u.id
        token = auth_routes.create_session_token(s, u)
    CREATED_UIDS.append(uid)
    return token, uid


def new_guest() -> tuple[httpx.Client, uuid.UUID]:
    ip = f"{PREFIX}.{len(GUEST_IPS) + 1}"
    GUEST_IPS.append(ip)
    c = mk_client()
    r = c.post("/auth/guest", headers={"X-Forwarded-For": ip})
    token = c.cookies.get("session")
    with Session(engine) as s:
        a = s.exec(select(AuthSession).where(AuthSession.token_hash == auth_routes.hash_token(token))).first()
        uid = a.user_id
    CREATED_UIDS.append(uid)
    if r.status_code != 200:
        raise RuntimeError(f"guest create failed: {r.status_code}")
    return c, uid


def cred_row(uid: uuid.UUID) -> str | None:
    with Session(engine) as s:
        row = s.get(OpenRouterCredential, uid)
        val = row.key_encrypted if row else None
    if val is not None:
        CIPHERS.append(val)
    return val


def cred_count(uid: uuid.UUID) -> int:
    with Session(engine) as s:
        return len(s.exec(select(OpenRouterCredential).where(OpenRouterCredential.user_id == uid)).all())


def loc(r: httpx.Response) -> str:
    return r.headers.get("location", "")


def connect_params(r: httpx.Response) -> dict:
    return {k: v[0] for k, v in parse_qs(urlparse(loc(r)).query).items()}


def start_connect(c: httpx.Client) -> tuple[httpx.Response, str, str]:
    """回傳 (connect 回應, state, code_challenge)。"""
    r = c.get("/auth/openrouter/connect")
    p = connect_params(r)
    return r, p.get("state", ""), p.get("code_challenge", "")


def do_callback(c: httpx.Client, state: str | None, code: str | None) -> httpx.Response:
    q = {}
    if state is not None:
        q["state"] = state
    if code is not None:
        q["code"] = code
    if code is not None:
        ALL_CODES.append(code)
    return c.get("/auth/openrouter/callback?" + urlencode(q))


def fresh_code() -> str:
    return f"FAKECODE-{_real_secrets.token_hex(12)}"


def err_loc(code: str) -> str:
    return f"{FRONTEND}/?openrouter_error={code}"


CONNECTED_LOC = f"{FRONTEND}/?openrouter=connected"


def connect_and_finish(c: httpx.Client, key: str) -> tuple[httpx.Response, str]:
    """完整成功流程（給後面案例用）。回傳 (callback 回應, 這次送出的 code)。"""
    EX["mode"] = "key"
    EX["key"] = key
    r, state, _ = start_connect(c)
    code = fresh_code()
    return do_callback(c, state, code), code


# ---------- 案例 ----------

def c01_connect_redirect():
    token, uid = new_account("A")
    S["tokA"], S["uidA"] = token, uid
    cA = with_session(token)
    S["cA"] = cA
    r, state, challenge = start_connect(cA)
    S["state1"], S["challenge1"] = state, challenge
    u = urlparse(loc(r))
    p = connect_params(r)
    check("G2-8-1a connect → 303 to https://openrouter.ai/auth",
          r.status_code == 303 and f"{u.scheme}://{u.netloc}{u.path}" == OR_AUTH,
          f"status={r.status_code} loc={loc(r)[:80]}")
    check("G2-8-1b callback_url ends with /auth/openrouter/callback and code_challenge_method=S256",
          p.get("callback_url", "").endswith("/auth/openrouter/callback") and p.get("code_challenge_method") == "S256",
          str({k: v for k, v in p.items() if k != "state"}))
    check("G2-8-1c key_label=FluentBranch, state present, code_challenge present",
          p.get("key_label") == "FluentBranch" and len(state) > 20 and len(challenge) > 20,
          f"label={p.get('key_label')} state_len={len(state)}")
    check("G2-8-1d connect response Cache-Control no-store",
          r.headers.get("cache-control") == "no-store", str(r.headers.get("cache-control")))


def c02_callback_success():
    cA = S["cA"]
    S["key1"] = new_fake_key()
    EX["mode"], EX["key"] = "key", S["key1"]
    before_calls = len(EX["calls"])
    code = fresh_code()
    S["code1"] = code
    r = do_callback(cA, S["state1"], code)
    check("G2-8-2a callback with correct state → 303 /?openrouter=connected",
          r.status_code == 303 and loc(r) == CONNECTED_LOC, f"status={r.status_code} loc={loc(r)[:100]}")
    check("G2-8-2b callback response Cache-Control no-store",
          r.headers.get("cache-control") == "no-store", str(r.headers.get("cache-control")))
    enc = cred_row(S["uidA"])
    check("G2-8-2c DB row exists for user A", enc is not None, "no row")
    check("G2-8-2d key_encrypted != fake key and does not contain it",
          enc is not None and enc != S["key1"] and S["key1"] not in enc, "plaintext or equal in DB")
    try:
        dec = decrypt_key(enc) if enc else None
    except CredentialKeyError:
        dec = None
    check("G2-8-2e decrypt_key(key_encrypted) == fake key", dec == S["key1"], "decrypt mismatch")
    calls = EX["calls"][before_calls:]
    check("G2-8-2f fake exchange received the code and the verifier matching the challenge",
          len(calls) == 1 and calls[0][0] == code
          and oc._code_challenge(calls[0][1]) == S["challenge1"],
          f"calls={len(calls)}")
    S["verifier1"] = calls[0][1] if calls else None


def c03_me_connected():
    cA = S["cA"]
    r = cA.get("/auth/me")
    body = r.json() if r.status_code == 200 else {}
    text = r.text
    enc = cred_row(S["uidA"]) or ""
    check("G2-8-3a /auth/me → openrouter_connected true",
          r.status_code == 200 and body.get("openrouter_connected") is True, f"status={r.status_code} body={text[:200]}")
    check("G2-8-3b /auth/me text contains neither the fake key nor the ciphertext",
          S["key1"] not in text and enc not in text and "FAKEKEY" not in text, "leak in /auth/me")


def c04_replay():
    cA = S["cA"]
    n_calls = len(EX["calls"])
    before = cred_row(S["uidA"])
    r = do_callback(cA, S["state1"], S["code1"])
    check("G2-8-4a replay of the same callback URL → state_mismatch",
          r.status_code == 303 and loc(r) == err_loc("state_mismatch"), f"loc={loc(r)[:100]}")
    check("G2-8-4b replay: exchange call count unchanged",
          len(EX["calls"]) == n_calls, f"{len(EX['calls'])}/{n_calls}")
    check("G2-8-4c replay: row unchanged", cred_row(S["uidA"]) == before, "row changed")


def c05_wrong_state_then_right():
    cA = S["cA"]
    _, state, _ = start_connect(cA)
    n_calls = len(EX["calls"])
    r = do_callback(cA, "WRONG-" + state[6:], fresh_code())
    check("G2-8-5a wrong state → state_mismatch with fixed Location",
          r.status_code == 303 and loc(r) == err_loc("state_mismatch"), f"loc={loc(r)[:100]}")
    check("G2-8-5b wrong state: exchange not called", len(EX["calls"]) == n_calls, str(len(EX["calls"])))
    r = do_callback(cA, state, fresh_code())
    check("G2-8-5c then RIGHT state → still state_mismatch (state consumed)",
          r.status_code == 303 and loc(r) == err_loc("state_mismatch") and len(EX["calls"]) == n_calls,
          f"loc={loc(r)[:100]} calls={len(EX['calls'])}/{n_calls}")


def c06_missing_code():
    cA = S["cA"]
    _, state, _ = start_connect(cA)
    n_calls = len(EX["calls"])
    r = do_callback(cA, state, None)
    check("G2-8-6a missing code → state_mismatch", loc(r) == err_loc("state_mismatch"), f"loc={loc(r)[:100]}")
    check("G2-8-6b missing code: exchange not called", len(EX["calls"]) == n_calls, "exchange called")


def c07_cross_account_cookie():
    before_a = cred_row(S["uidA"])
    tokB, uidB = new_account("B")
    S["uidB"], S["tokB"] = uidB, tokB
    cX = with_session(S["tokA"])
    _, state, _ = start_connect(cX)
    n_calls = len(EX["calls"])
    cX.cookies.set("session", tokB, domain="127.0.0.1", path="/")  # 同一瀏覽器，session 換成 B
    r = do_callback(cX, state, fresh_code())
    check("G2-8-7a A starts, B's session at callback → state_mismatch",
          loc(r) == err_loc("state_mismatch"), f"loc={loc(r)[:100]}")
    check("G2-8-7b no row for B", cred_count(uidB) == 0, str(cred_count(uidB)))
    check("G2-8-7c A's row unchanged and exchange not called",
          cred_row(S["uidA"]) == before_a and len(EX["calls"]) == n_calls, "changed")


def c08_guest_and_anonymous():
    cG, uidG = new_guest()
    S["uidG"] = uidG
    r, state, _ = start_connect(cG)
    check("G2-8-8a guest connect → login_required",
          r.status_code == 303 and loc(r) == err_loc("login_required"), f"loc={loc(r)[:100]}")
    check("G2-8-8b guest connect response Cache-Control no-store",
          r.headers.get("cache-control") == "no-store", str(r.headers.get("cache-control")))
    n_calls = len(EX["calls"])
    r = do_callback(cG, "anything", fresh_code())
    check("G2-8-8c guest callback → login_required and exchange not called",
          loc(r) == err_loc("login_required") and len(EX["calls"]) == n_calls, f"loc={loc(r)[:100]}")
    anon = mk_client()
    r = anon.get("/auth/openrouter/connect")
    check("G2-8-8d no cookie connect → login_required", loc(r) == err_loc("login_required"), f"loc={loc(r)[:100]}")
    r = do_callback(anon, "anything", fresh_code())
    check("G2-8-8e no cookie callback → login_required", loc(r) == err_loc("login_required"), f"loc={loc(r)[:100]}")
    check("G2-8-8f guest has no credential row", cred_count(uidG) == 0, "row exists")


def c09_encryption_unconfigured():
    cB = with_session(S["tokB"])
    with env(CREDENTIAL_ENCRYPTION_KEY=None):
        r = cB.get("/auth/openrouter/connect")
    check("G2-8-9a key unset → connect gives unavailable",
          loc(r) == err_loc("unavailable"), f"loc={loc(r)[:100]}")
    with env(CREDENTIAL_ENCRYPTION_KEY="not-a-valid-fernet-key"):
        r = cB.get("/auth/openrouter/connect")
    check("G2-8-9b invalid key → connect gives unavailable",
          loc(r) == err_loc("unavailable"), f"loc={loc(r)[:100]}")
    check("G2-8-9c encryption_configured() False when unset, True again after restore",
          os.environ.get("CREDENTIAL_ENCRYPTION_KEY") == FERNET_KEY and crypto_utils.encryption_configured(),
          "not restored")


def c10_exchange_failed():
    cB = with_session(S["tokB"])
    EX["mode"] = "none"
    _, state, _ = start_connect(cB)
    n_calls = len(EX["calls"])
    r = do_callback(cB, state, fresh_code())
    EX["mode"] = "key"
    check("G2-8-10a exchange returns None → exchange_failed",
          loc(r) == err_loc("exchange_failed"), f"loc={loc(r)[:100]}")
    check("G2-8-10b exchange was called once and B has no row",
          len(EX["calls"]) == n_calls + 1 and cred_count(S["uidB"]) == 0, f"calls={len(EX['calls']) - n_calls}")


def c11_reconnect_replaces():
    cA = S["cA"]
    old = cred_row(S["uidA"])
    k2 = new_fake_key()
    r, _ = connect_and_finish(cA, k2)
    check("G2-8-11a second connect for A → connected", loc(r) == CONNECTED_LOC, f"loc={loc(r)[:100]}")
    new = cred_row(S["uidA"])
    check("G2-8-11b still exactly one row for A", cred_count(S["uidA"]) == 1, str(cred_count(S["uidA"])))
    check("G2-8-11c row replaced: ciphertext changed and decrypts to the new key",
          new != old and new is not None and decrypt_key(new) == k2, "not replaced")
    S["key2"] = k2


def c12_delete_self():
    cA = S["cA"]
    # 先確定 A 有列，驗證 Origin 被擋時列保留
    r = cA.delete("/auth/openrouter", headers={"Origin": "https://evil.example"})
    check("G2-8-12a DELETE with bad Origin → 403 bad_origin",
          r.status_code == 403 and r.json().get("detail", {}).get("code") == "bad_origin",
          f"status={r.status_code} body={r.text[:120]}")
    check("G2-8-12b ... and A's row kept", cred_count(S["uidA"]) == 1, str(cred_count(S["uidA"])))
    r = cA.delete("/auth/openrouter")
    check("G2-8-12c DELETE → 200 {status ok} and row gone",
          r.status_code == 200 and r.json() == {"status": "ok"} and cred_count(S["uidA"]) == 0,
          f"status={r.status_code} count={cred_count(S['uidA'])}")
    r = cA.delete("/auth/openrouter")
    check("G2-8-12d DELETE again → 200", r.status_code == 200 and r.json() == {"status": "ok"}, str(r.status_code))
    r = mk_client().delete("/auth/openrouter")
    check("G2-8-12e DELETE without session → 401", r.status_code == 401, str(r.status_code))


def c13_delete_does_not_touch_other():
    cA = S["cA"]
    rB, _ = connect_and_finish(with_session(S["tokB"]), new_fake_key())
    check("G2-8-13a B connects → connected", loc(rB) == CONNECTED_LOC, f"loc={loc(rB)[:100]}")
    rA, _ = connect_and_finish(cA, new_fake_key())
    check("G2-8-13b A connects again → connected", loc(rA) == CONNECTED_LOC, f"loc={loc(rA)[:100]}")
    b_before = cred_row(S["uidB"])
    r = cA.delete("/auth/openrouter")
    check("G2-8-13c A's DELETE → 200 and A's row gone",
          r.status_code == 200 and cred_count(S["uidA"]) == 0, f"status={r.status_code}")
    check("G2-8-13d A's DELETE did not remove B's row",
          cred_count(S["uidB"]) == 1 and cred_row(S["uidB"]) == b_before, "B's row affected")


def c14_expired_state():
    cA = with_session(S["tokA"])
    _, state, _ = start_connect(cA)
    n_calls = len(EX["calls"])
    before = cred_row(S["uidA"])
    TIME_SHIFT["sec"] = 700
    try:
        r = do_callback(cA, state, fresh_code())
    finally:
        TIME_SHIFT["sec"] = 0
    check("G2-8-14a pending state older than 600s → state_mismatch",
          loc(r) == err_loc("state_mismatch"), f"loc={loc(r)[:100]}")
    check("G2-8-14b expired: exchange not called and row unchanged",
          len(EX["calls"]) == n_calls and cred_row(S["uidA"]) == before, "changed")


def c16_crypto_wrong_key():
    plain = f"sk-or-v1-FAKEKEY-{_real_secrets.token_hex(12)}"
    ALL_KEYS.append(plain)
    enc = encrypt_key(plain)
    CIPHERS.append(enc)
    other = Fernet.generate_key().decode("ascii")
    ALL_KEYS.append(other)
    with env(CREDENTIAL_ENCRYPTION_KEY=other):
        try:
            decrypt_key(enc)
            raised = None
        except CredentialKeyError as e:
            raised = e
    msg = str(raised) if raised else ""
    check("G2-8-16a decrypt with a different key raises CredentialKeyError", raised is not None, "no exception")
    check("G2-8-16b exception text contains neither key, token nor plaintext",
          raised is not None and not any(x in msg for x in (FERNET_KEY, other, enc, plain)), f"msg={msg!r}")


def c17_route_order():
    """/auth/openrouter/callback 必須由 openrouter 的 callback 處理，不能落到 oauth_callback（會回 404）。"""
    r = mk_client().get("/auth/openrouter/callback?state=x&code=y")
    check("G2-8-17 /auth/openrouter/callback handled by openrouter route (303 openrouter_error, not 404)",
          r.status_code == 303 and loc(r) == err_loc("login_required"), f"status={r.status_code} loc={loc(r)[:100]}")


def c15_leak_check():
    text = CAPTURE.getvalue()
    secrets_seen = set(ALL_KEYS) | set(ALL_CODES) | set(GENERATED) | set(CIPHERS) | {FERNET_KEY}
    secrets_seen = {x for x in secrets_seen if x}
    hits = [x for x in secrets_seen if x in text]
    check("G2-8-15 captured logs/stdout contain no key, code, state, verifier, ciphertext or encryption key",
          not hits and len(text) > 0, f"hits={len(hits)} captured_len={len(text)}")


def c18_access_log_redacted():
    """access log 必須開著（不是靠關掉 log 才通過 case 15）：應看到 /auth/openrouter/callback?[redacted]，且沒有 state= / code=。"""
    needle = "/auth/openrouter/callback?[redacted]"
    seen = wait_for(lambda: needle in CAPTURE.getvalue(), timeout=5.0)
    text = CAPTURE.getvalue()
    check("G2-8-18a access log is on: a callback access line with ?[redacted] was captured",
          seen and needle in text, "no redacted callback access line captured")
    check("G2-8-18b no 'state=' or 'code=' substring anywhere in the captured output",
          "state=" not in text and "code=" not in text, "query value leaked into captured output")


def wait_for(pred, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return pred()


CASES = [
    c01_connect_redirect, c02_callback_success, c03_me_connected, c04_replay,
    c05_wrong_state_then_right, c06_missing_code, c07_cross_account_cookie,
    c08_guest_and_anonymous, c09_encryption_unconfigured, c10_exchange_failed,
    c11_reconnect_replaces, c12_delete_self, c13_delete_does_not_touch_other,
    c14_expired_state, c16_crypto_wrong_key, c17_route_order, c18_access_log_redacted,
]


# ---------- server / cleanup ----------

def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = free_port()
BASE = f"http://127.0.0.1:{PORT}"


def start_server() -> uvicorn.Server:
    config = uvicorn.Config(
        main.app,
        host="127.0.0.1",
        port=PORT,
        log_level="info",
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError(f"uvicorn did not start on 127.0.0.1:{PORT}")
    return server


def cleanup():
    try:
        with Session(engine) as s:
            for uid in dict.fromkeys(CREATED_UIDS):
                s.execute(sa_delete(OpenRouterCredential).where(OpenRouterCredential.user_id == uid))
                s.execute(sa_delete(DailyUsage).where(DailyUsage.user_id == uid))
                for a in s.exec(select(AuthSession).where(AuthSession.user_id == uid)).all():
                    s.delete(a)
                s.commit()
                u = s.get(User, uid)
                if u is not None:
                    s.delete(u)
                    s.commit()
        if GUEST_IPS:
            hashes = [guest.hash_ip(ip) for ip in GUEST_IPS]
            with Session(engine) as s:
                s.execute(sa_delete(GuestIpUsage).where(GuestIpUsage.ip_hash.in_(hashes)))
                s.commit()
    except Exception as e:  # noqa: BLE001
        print(f"cleanup FAILED: {type(e).__name__}")


def main_entry() -> int:
    server = None
    try:
        server = start_server()
        for fn in CASES:
            run(fn)
        run(c15_leak_check)
    except Exception as e:  # noqa: BLE001
        check("harness setup", False, f"exception: {type(e).__name__}")
    finally:
        for c in OPEN_CLIENTS:
            c.close()
        if server is not None:
            server.should_exit = True
        cleanup()

    total = len(RESULTS)
    failed = [(n, d) for n, ok, d in RESULTS if not ok]
    for n, d in failed:
        print(f"  FAIL {n}: {d}", file=sys.__stdout__)
    if failed or total == 0:
        print(f"FAILED ({len(failed)})", file=sys.__stdout__)
        return 1
    print(f"ALL PASS ({total})", file=sys.__stdout__)
    return 0


if __name__ == "__main__":
    sys.exit(main_entry())
