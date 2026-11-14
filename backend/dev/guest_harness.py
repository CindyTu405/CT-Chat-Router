"""(G2-2) 訪客身分的測試腳本：POST /auth/guest、/auth/me 新欄位、IP 雜湊、每 IP 每日訪客上限、跨身分隔離。

用法（只用臨時資料庫，不要指向正式 chat_db）：
    cd backend && POSTGRES_DB=g2_tmp SQL_ECHO=false uv run python dev/guest_harness.py 2>&1 | grep -v sqlalchemy | tail -5

做的事：
- 在 127.0.0.1:8770 起真的 uvicorn（背景 thread），proxy_headers=True，用 X-Forwarded-For 指定每個案例的來源 IP。
- 每個身分用自己的 httpx.Client（自己的 cookie jar）。
- 把 main.gemini_chat_stream / main.openrouter_chat_stream 換成假串流（計數、固定輸出），絕不呼叫真模型。
- 限流關閉（slowapi），避免測試本身被每分鐘 5 次擋住。
- 每個 IP 用隨機前綴（10.x.y.*），重跑同一天也不會撞到前一次的計數。
- 結束時（即使失敗）只清掉本腳本建立的 user（訊息、分支、daily_usage、auth_session 一併）
  與本腳本用過的 IP 的 guest_ip_usage 列。
- (G2-4) 登入時的訪客處理（G2-4-1 起）：假 GitHub provider（patch authorize_access_token /
  _fetch_github_user，不打網路）、merge / discard、額度併入與上限、guest_session cookie、跨身分隔離、
  交易原子性（注入失敗 → 500 且資料不動）。
- (G2-5) 保留期限清理（G2-5-1 起）：直接回填 last_active_at / created_at / guest_ip_usage.day 後呼叫
  guest.purge_expired_guests；背景 task 的啟動次數用計數包裝確認。
"""
import os
import sys
import threading
import time
import uuid
import random
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

# 測試預設值（必須在 import main 之前設定）
os.environ["ALLOWED_MODELS"] = "gemini*"
os.environ["DAILY_MESSAGE_LIMIT"] = "100000"
os.environ["SITE_DAILY_MESSAGE_LIMIT"] = "1000000"
os.environ["GUEST_IP_DAILY_GUESTS"] = "10"
os.environ["GUEST_IP_DAILY_MESSAGES"] = "100000"
os.environ["CORS_ORIGINS"] = "http://localhost:5173"

import contextlib  # noqa: E402
import httpx  # noqa: E402
import uvicorn  # noqa: E402
from sqlalchemy import delete as sa_delete, func as sa_func, text as sa_text  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from database import engine  # noqa: E402

# 防呆：絕不對正式的 chat_db 跑（在 import main 之前就停）
if engine.url.database == "chat_db":
    print("REFUSED: this harness must not run against chat_db; use POSTGRES_DB=g2_tmp")
    sys.exit(1)

import main  # noqa: E402
import auth_routes  # noqa: E402
import guest  # noqa: E402
from models import AuthSession, Branch, DailyUsage, GuestIpUsage, Message, User  # noqa: E402

# (G2-5) 背景清理的啟動計數：在 uvicorn 啟動前包一層；main._guest_purge_loop 每次呼叫時才取 guest.run_purge_once
PURGE_CALLS = {"n": 0}
_real_run_purge_once = guest.run_purge_once


def _counting_run_purge_once() -> int:
    PURGE_CALLS["n"] += 1
    return _real_run_purge_once()


guest.run_purge_once = _counting_run_purge_once

# database.py 的 echo 會印出所有 SQL；這個腳本只看測試結果，關掉它（只影響本腳本）。
engine.echo = False

PORT = 8770
BASE = f"http://127.0.0.1:{PORT}"
MODEL = "gemini-2.5-flash-lite"

# 限流與背景 buffer 保留時間：測試時關掉／調短
main.limiter.enabled = False
main.BUFFER_RETENTION_SECONDS = 2
# 不讓白名單去抓 OpenRouter 免費模型清單；環境變數白名單照常生效
main.get_free_models = lambda session, force_refresh=False: []

LLM_CALLS = {"n": 0}


async def fake_stream(*args, **kwargs):
    """假的 LLM 串流：只計數、固定輸出，不連任何外部服務。
    (G2-3) 訊息以 FAIL0 開頭：還沒吐出任何字就丟例外；以 FAIL1 開頭：吐一段後丟例外。"""
    LLM_CALLS["n"] += 1
    msg = args[0] if args else kwargs.get("message", "")
    if msg.startswith("FAIL0"):
        raise RuntimeError("fake failure before any output")
    yield "GUEST-"
    if msg.startswith("FAIL1"):
        raise RuntimeError("fake failure after one chunk")
    yield "REPLY"


main.gemini_chat_stream = fake_stream
main.openrouter_chat_stream = fake_stream

# (G2-4) 假 GitHub provider：callback 會以 GH_NEXT["id"] 當作 GitHub 使用者 id，不打任何網路。
GH_NEXT: dict = {"id": None}


async def fake_authorize_access_token(request):
    return {"access_token": "fake"}


async def fake_fetch_github_user(token):
    return {"id": GH_NEXT["id"], "email": None}


auth_routes.is_provider_configured = lambda provider: True
auth_routes.oauth.github.authorize_access_token = fake_authorize_access_token
auth_routes._fetch_github_user = fake_fetch_github_user

# 每次執行一個隨機前綴；A..F 各代表一個來源 IP
PREFIX = f"10.{random.randint(0, 255)}.{random.randint(0, 255)}"
IP = {label: f"{PREFIX}.{n}" for n, label in enumerate("ABCDEFGHIJKLMNO", start=1)}

RESULTS: list[tuple[str, bool, str]] = []
CREATED_UIDS: list[uuid.UUID] = []   # 本腳本建立的 user（清理用）
S: dict = {}                         # 案例之間共用的狀態（token、根節點 id 等）
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def check(name: str, cond: bool, detail: str = ""):
    RESULTS.append((name, bool(cond), detail))
    if cond:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name}: {detail}")


def run(fn):
    """單一案例的例外不影響其他案例，但要記成 FAIL。"""
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        check(fn.__name__, False, f"exception: {e!r}")


# ---------- 共用小工具 ----------

def xff(ip: str) -> dict:
    return {"X-Forwarded-For": ip}


def new_client(token: str | None = None, ip: str | None = None) -> httpx.Client:
    """ip 有值時，這個 client 的每個請求都帶同一個 X-Forwarded-For（訪客的來源 IP 要一致）。"""
    cookies = {"session": token} if token else None
    headers = xff(ip) if ip else None
    return httpx.Client(base_url=BASE, timeout=60, cookies=cookies, headers=headers)


@contextlib.contextmanager
def env(**kv):
    """暫時設定（值為 None 則移除）環境變數，結束後還原。讀取是每次呼叫才讀，所以即時生效。"""
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


def daily_count(uid: uuid.UUID) -> int:
    with Session(engine) as s:
        row = s.exec(select(DailyUsage.count).where(
            DailyUsage.user_id == uid, DailyUsage.day == guest.taiwan_today())).first()
        return row or 0


def ip_messages(ip: str) -> int:
    with Session(engine) as s:
        row = s.get(GuestIpUsage, (guest.hash_ip(ip), guest.taiwan_today()))
        return row.messages if row else 0


def last_active(uid: uuid.UUID):
    with Session(engine) as s:
        u = s.get(User, uid)
        return u.last_active_at if u else None


def ai_content(ai_id: str) -> str:
    with Session(engine) as s:
        m = s.get(Message, uuid.UUID(ai_id))
        return m.content if m else ""


def wait_for(pred, timeout: float = 10.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return pred()


def uid_of_token(token: str | None) -> uuid.UUID | None:
    """原始 token → 擁有者的 user id（只查表，不改任何列）。"""
    if not token:
        return None
    with Session(engine) as s:
        a = s.exec(
            select(AuthSession).where(AuthSession.token_hash == auth_routes.hash_token(token))
        ).first()
        return a.user_id if a else None


def create_guest(c: httpx.Client, ip: str, origin: str | None = None) -> httpx.Response:
    headers = xff(ip)
    if origin is not None:
        headers["Origin"] = origin
    r = c.post("/auth/guest", headers=headers)
    if r.status_code == 200 and r.json().get("created") is True:
        uid = uid_of_token(r.cookies.get("session"))
        if uid is not None:
            CREATED_UIDS.append(uid)
    return r


def guest_user_count() -> int:
    with Session(engine) as s:
        return s.exec(select(sa_func.count(User.id)).where(User.oauth_provider == "guest")).one()


def guests_created_for(ip: str) -> int:
    with Session(engine) as s:
        row = s.get(GuestIpUsage, (guest.hash_ip(ip), guest.taiwan_today()))
        return row.guests_created if row else 0


def ip_row_exists(ip: str) -> bool:
    with Session(engine) as s:
        return s.get(GuestIpUsage, (guest.hash_ip(ip), guest.taiwan_today())) is not None


def messages_of(uid: uuid.UUID) -> list[Message]:
    with Session(engine) as s:
        return list(s.exec(select(Message).where(Message.user_id == uid)).all())


def root_of(uid: uuid.UUID) -> uuid.UUID | None:
    with Session(engine) as s:
        m = s.exec(
            select(Message).where(Message.user_id == uid, Message.parent_id == None)  # noqa: E711
        ).first()
        return m.id if m else None


def chat(c: httpx.Client, text_msg: str, parent_id: str | None = None) -> httpx.Response:
    body = {"message": text_msg, "model": MODEL}
    if parent_id is not None:
        body["parent_id"] = parent_id
    return c.post("/chat", json=body)


# ---------- 案例 ----------

def c01_create_guest():
    c = new_client(ip=IP["A"])
    S["cA"] = c
    r = create_guest(c, IP["A"])
    check("G2-2-1a POST /auth/guest IP A → 200 created true",
          r.status_code == 200 and r.json() == {"status": "ok", "created": True},
          f"status={r.status_code} body={r.text[:200]}")
    raw_cookie = r.headers.get("set-cookie", "")
    low = raw_cookie.lower()
    check("G2-2-1b session cookie is HttpOnly and SameSite=lax",
          raw_cookie.startswith("session=") and "httponly" in low and "samesite=lax" in low,
          raw_cookie[:200])
    uid = uid_of_token(c.cookies.get("session"))
    S["uidA"] = uid
    with Session(engine) as s:
        u = s.get(User, uid) if uid else None
        ok = u is not None and u.oauth_provider == "guest" and u.email is None
    check("G2-2-1c DB has one new user with provider guest and email None", ok, f"uid={uid}")


def c02_me_for_guest():
    r = S["cA"].get("/auth/me")
    body = r.json() if r.status_code == 200 else {}
    check("G2-2-2a GET /auth/me as guest → 200", r.status_code == 200, f"status={r.status_code}")
    check("G2-2-2b is_guest true, provider guest, openrouter_connected false, guest_claim None",
          body.get("is_guest") is True and body.get("provider") == "guest"
          and body.get("openrouter_connected") is False and body.get("guest_claim") is None,
          str(body))
    check("G2-2-2c /auth/me has no id or user_id key",
          "id" not in body and "user_id" not in body and set(body) == {
              "email", "provider", "is_guest", "openrouter_connected", "guest_claim"},
          str(sorted(body)))


def c03_same_client_again():
    users_before = guest_user_count()
    r = create_guest(S["cA"], IP["A"])
    check("G2-2-3a same client POST again → 200 created false",
          r.status_code == 200 and r.json().get("created") is False,
          f"status={r.status_code} body={r.text[:200]}")
    check("G2-2-3b no new guest user", guest_user_count() == users_before,
          f"before={users_before} after={guest_user_count()}")
    check("G2-2-3c guests_created for IP A still 1", guests_created_for(IP["A"]) == 1,
          str(guests_created_for(IP["A"])))


def c04_guest_chats():
    before_calls = LLM_CALLS["n"]
    r = chat(S["cA"], "hi")
    check("G2-2-4a guest POST /chat → 200 with non-empty body",
          r.status_code == 200 and len(r.text) > 0, f"status={r.status_code} body={r.text[:200]}")
    msgs = messages_of(S["uidA"])
    check("G2-2-4b two stored messages, both owned by the guest",
          len(msgs) == 2 and all(m.user_id == S["uidA"] for m in msgs), f"count={len(msgs)}")
    check("G2-2-4c fake LLM called once", LLM_CALLS["n"] - before_calls == 1,
          f"delta={LLM_CALLS['n'] - before_calls}")
    S["rootA"] = root_of(S["uidA"])


def c05_ip_b_cap():
    statuses = []
    for _ in range(10):
        statuses.append(create_guest(new_client(), IP["B"]).status_code)
    check("G2-2-5a IP B: 10 sequential guests all 200", statuses == [200] * 10, str(statuses))

    users_before = guest_user_count()
    r = create_guest(new_client(), IP["B"])
    check("G2-2-5b 11th guest from IP B → 429 guest_ip_limit",
          r.status_code == 429 and r.json().get("detail", {}).get("code") == "guest_ip_limit",
          f"status={r.status_code} body={r.text[:200]}")
    check("G2-2-5c 429 sets no cookie", "set-cookie" not in r.headers, r.headers.get("set-cookie", ""))
    check("G2-2-5d user count unchanged after 429", guest_user_count() == users_before,
          f"before={users_before} after={guest_user_count()}")
    check("G2-2-5e guests_created for IP B == 10", guests_created_for(IP["B"]) == 10,
          str(guests_created_for(IP["B"])))


def _concurrent_create(ip: str):
    with httpx.Client(base_url=BASE, timeout=60) as c:
        r = c.post("/auth/guest", headers=xff(ip))
        return r.status_code, r.cookies.get("session")


def c06_ip_c_concurrent():
    users_before = guest_user_count()
    with ThreadPoolExecutor(max_workers=20) as ex:
        results = list(ex.map(_concurrent_create, [IP["C"]] * 20))
    statuses = [st for st, _ in results]
    for _, token in results:
        uid = uid_of_token(token)
        if uid is not None:
            CREATED_UIDS.append(uid)
    check("G2-2-6a 20 concurrent: exactly 10 → 200",
          statuses.count(200) == 10, f"200={statuses.count(200)} 429={statuses.count(429)} other={[s for s in statuses if s not in (200, 429)]}")
    check("G2-2-6b 20 concurrent: exactly 10 → 429",
          statuses.count(429) == 10, f"429={statuses.count(429)}")
    check("G2-2-6c guests_created for IP C == 10", guests_created_for(IP["C"]) == 10,
          str(guests_created_for(IP["C"])))
    check("G2-2-6d exactly 10 new guest users", guest_user_count() - users_before == 10,
          f"delta={guest_user_count() - users_before}")


def c07_ip_d_fresh():
    r = create_guest(new_client(), IP["D"])
    check("G2-2-7 IP D (fresh) after B and C are full → 200",
          r.status_code == 200 and r.json().get("created") is True, f"status={r.status_code}")


def c08_no_raw_ip_in_db():
    raw_ips = list(IP.values())
    with Session(engine) as s:
        raw_hits = s.exec(
            select(sa_func.count()).select_from(GuestIpUsage).where(GuestIpUsage.ip_hash.in_(raw_ips))
        ).one()
        used_hashes = [guest.hash_ip(IP[k]) for k in "ABCD"]
        rows = s.exec(select(GuestIpUsage.ip_hash).where(GuestIpUsage.ip_hash.in_(used_hashes))).all()
    check("G2-2-8a no guest_ip_usage row has a raw IP as ip_hash", raw_hits == 0, f"hits={raw_hits}")
    check("G2-2-8b every stored ip_hash used here is 64 lowercase hex chars",
          len(rows) == 4 and all(HEX64.match(h) for h in rows), f"rows={len(rows)}")
    check("G2-2-8c hash_ip is stable for the same IP and differs between IPs",
          guest.hash_ip(IP["A"]) == guest.hash_ip(IP["A"]) and guest.hash_ip(IP["A"]) != guest.hash_ip(IP["B"]))


def c09_origin():
    users_before = guest_user_count()
    r = create_guest(new_client(), IP["E"], origin="https://evil.example")
    check("G2-2-9a bad Origin → 403 bad_origin",
          r.status_code == 403 and r.json().get("detail", {}).get("code") == "bad_origin",
          f"status={r.status_code} body={r.text[:200]}")
    check("G2-2-9b bad Origin creates no user", guest_user_count() == users_before,
          f"before={users_before} after={guest_user_count()}")
    check("G2-2-9c bad Origin writes no guest_ip_usage row", not ip_row_exists(IP["E"]))
    r2 = create_guest(new_client(), IP["E"], origin="http://localhost:5173")
    check("G2-2-9d allowed Origin → 200", r2.status_code == 200, f"status={r2.status_code}")


def c10_isolation():
    cA = S["cA"]
    rootA = S["rootA"]
    uidA = S["uidA"]

    # 訪客 G2（自己的對話）
    cG2 = new_client(ip=IP["F"])
    r = create_guest(cG2, IP["F"])
    check("G2-2-10a create second guest G2 → 200", r.status_code == 200, f"status={r.status_code}")
    uidG2 = uid_of_token(cG2.cookies.get("session"))
    chat(cG2, "g2 hi")
    rootG2 = root_of(uidG2)

    # 登入帳號 U（github，直接用 harness 建立），自己的對話
    with Session(engine) as s:
        u = auth_routes.upsert_user(s, "github", f"g2-harness-{uuid.uuid4()}", None)
        uidU = u.id
        tokenU = auth_routes.create_session_token(s, u)
    CREATED_UIDS.append(uidU)
    cU = new_client(tokenU)
    chat(cU, "u hi")
    rootU = root_of(uidU)
    check("G2-2-10b every identity has its own root", all([rootA, rootG2, rootU]),
          f"A={rootA} G2={rootG2} U={rootU}")

    calls_before = LLM_CALLS["n"]
    msgs_before = len(messages_of(uidA))

    r = cG2.get(f"/chats/{rootA}/history")
    check("G2-2-10c guest G2 GET history of A's root → 404", r.status_code == 404, str(r.status_code))
    r = cG2.get(f"/chats/{rootA}/tree")
    check("G2-2-10d guest G2 GET tree of A's root → 404", r.status_code == 404, str(r.status_code))
    r = chat(cG2, "steal", parent_id=str(rootA))
    check("G2-2-10e guest G2 POST /chat with A's message as parent → 404",
          r.status_code == 404, str(r.status_code))
    check("G2-2-10f ... and LLM not called, A's messages unchanged",
          LLM_CALLS["n"] == calls_before and len(messages_of(uidA)) == msgs_before,
          f"llm_delta={LLM_CALLS['n'] - calls_before} msgs={len(messages_of(uidA))}/{msgs_before}")
    r = cG2.delete(f"/chats/{rootA}")
    check("G2-2-10g guest G2 DELETE A's root → 404", r.status_code == 404, str(r.status_code))
    check("G2-2-10h ... and A's messages still exist",
          len(messages_of(uidA)) == msgs_before, f"msgs={len(messages_of(uidA))}/{msgs_before}")

    r = cA.get(f"/chats/{rootU}/history")
    check("G2-2-10i guest A GET history of U's root → 404", r.status_code == 404, str(r.status_code))
    r = cU.get(f"/chats/{rootA}/history")
    check("G2-2-10j logged-in U GET history of A's root → 404", r.status_code == 404, str(r.status_code))

    def roots_of(c):
        r = c.get("/chats/roots")
        return {row["id"] for row in r.json()} if r.status_code == 200 else None

    check("G2-2-10k each identity's /chats/roots lists only its own root",
          roots_of(cA) == {str(rootA)} and roots_of(cG2) == {str(rootG2)}
          and roots_of(cU) == {str(rootU)},
          f"A={roots_of(cA)} G2={roots_of(cG2)} U={roots_of(cU)}")
    S["cG2"] = cG2


def c11_no_cookie():
    r = new_client().get("/auth/me")
    check("G2-2-11 GET /auth/me without cookie → 401", r.status_code == 401, str(r.status_code))


def c12_default_limit():
    with env(DAILY_MESSAGE_LIMIT=None):
        v = main.daily_message_limit()
    check("G2-3-1 DAILY_MESSAGE_LIMIT unset → daily_message_limit() == 10", v == 10, str(v))


def c13_daily_limit_ten():
    with env(DAILY_MESSAGE_LIMIT="10"):
        c = new_client(ip=IP["G"])
        r = create_guest(c, IP["G"])
        uid = uid_of_token(c.cookies.get("session"))
        statuses = [chat(c, f"msg {i}").status_code for i in range(10)]
        check("G2-3-2a fresh guest: 10 chats all 200", statuses == [200] * 10, str(statuses))
        n_msgs = len(messages_of(uid))
        calls = LLM_CALLS["n"]
        r = chat(c, "eleventh")
        check("G2-3-2b 11th chat → 429 daily_quota_exceeded",
              r.status_code == 429 and r.json().get("detail", {}).get("code") == "daily_quota_exceeded",
              f"status={r.status_code} body={r.text[:200]}")
        check("G2-3-2c 11th: message count and LLM call count unchanged",
              len(messages_of(uid)) == n_msgs and LLM_CALLS["n"] == calls,
              f"msgs={len(messages_of(uid))}/{n_msgs} llm_delta={LLM_CALLS['n'] - calls}")
    c.close()


def c14_ip_cap_shared():
    with env(DAILY_MESSAGE_LIMIT="100000", GUEST_IP_DAILY_MESSAGES="5"):
        cP = new_client(ip=IP["H"])
        create_guest(cP, IP["H"])
        cQ = new_client(ip=IP["H"])
        create_guest(cQ, IP["H"])
        uidQ = uid_of_token(cQ.cookies.get("session"))
        S["cP"], S["cQ"], S["uidQ"] = cP, cQ, uidQ
        p_st = [chat(cP, f"p {i}").status_code for i in range(3)]
        q_st = [chat(cQ, f"q {i}").status_code for i in range(2)]
        check("G2-3-3a guests P (3) and Q (2) on IP H → all 200", p_st + q_st == [200] * 5,
              str(p_st + q_st))
        calls = LLM_CALLS["n"]
        msgs_q = len(messages_of(uidQ))
        r = chat(cQ, "over cap")
        d = r.json().get("detail", {}) if r.status_code == 429 else {}
        check("G2-3-3b Q's next → 429 guest_ip_limit with reset_at",
              r.status_code == 429 and d.get("code") == "guest_ip_limit" and "reset_at" in d,
              f"status={r.status_code} body={r.text[:200]}")
        check("G2-3-3c Q's daily_usage.count still 2", daily_count(uidQ) == 2, str(daily_count(uidQ)))
        check("G2-3-3d no new message, LLM not called",
              len(messages_of(uidQ)) == msgs_q and LLM_CALLS["n"] == calls,
              f"msgs={len(messages_of(uidQ))}/{msgs_q} llm_delta={LLM_CALLS['n'] - calls}")
        check("G2-3-3e guest_ip_usage.messages == 5", ip_messages(IP["H"]) == 5, str(ip_messages(IP["H"])))


def c15_ip_cap_isolation():
    with env(DAILY_MESSAGE_LIMIT="100000", GUEST_IP_DAILY_MESSAGES="5"):
        cOther = new_client(ip=IP["I"])
        create_guest(cOther, IP["I"])
        r = chat(cOther, "other ip")
        check("G2-3-4a guest on a different IP still → 200", r.status_code == 200, str(r.status_code))

        with Session(engine) as s:
            u = auth_routes.upsert_user(s, "github", f"g2-3-harness-{uuid.uuid4()}", None)
            uidL = u.id
            tokenL = auth_routes.create_session_token(s, u)
        CREATED_UIDS.append(uidL)
        cL = new_client(tokenL, ip=IP["H"])
        r = chat(cL, "logged in from full IP")
        check("G2-3-4b logged-in user from full IP H → 200", r.status_code == 200, str(r.status_code))
        check("G2-3-4c IP H messages still 5 (logged-in user not counted)",
              ip_messages(IP["H"]) == 5, str(ip_messages(IP["H"])))
        cL.close()
    S["cP"].close()
    S["cQ"].close()


def c16_personal_limit_rolls_back_ip():
    with env(DAILY_MESSAGE_LIMIT="2", GUEST_IP_DAILY_MESSAGES="100000"):
        c = new_client(ip=IP["J"])
        create_guest(c, IP["J"])
        uid = uid_of_token(c.cookies.get("session"))
        st = [chat(c, f"t {i}").status_code for i in range(2)]
        check("G2-3-5a guest sends 2 → both 200", st == [200, 200], str(st))
        ip_before = ip_messages(IP["J"])
        r = chat(c, "third")
        check("G2-3-5b 3rd → 429 daily_quota_exceeded",
              r.status_code == 429 and r.json().get("detail", {}).get("code") == "daily_quota_exceeded",
              f"status={r.status_code} body={r.text[:200]}")
        check("G2-3-5c IP messages == 2 (IP increment rolled back)",
              ip_messages(IP["J"]) == 2 and ip_before == 2, f"ip={ip_messages(IP['J'])} before={ip_before}")
        check("G2-3-5d daily_usage.count == 2", daily_count(uid) == 2, str(daily_count(uid)))
    c.close()


def _ai_id_of(r: httpx.Response) -> str:
    return r.headers.get("X-Message-Id", "")


def c17_generation_failed_before_output():
    with env(DAILY_MESSAGE_LIMIT="100000", GUEST_IP_DAILY_MESSAGES="100000"):
        c = new_client(ip=IP["K"])
        create_guest(c, IP["K"])
        uid = uid_of_token(c.cookies.get("session"))
        d0, i0 = daily_count(uid), ip_messages(IP["K"])
        r = chat(c, "FAIL0 please")
        ai_id = _ai_id_of(r)
        ok = wait_for(lambda: guest_failed_text(ai_id))
        check("G2-3-6a FAIL0 generation: AI message holds failure text", r.status_code == 200 and ok,
              f"status={r.status_code} content={ai_content(ai_id)[:80]!r}")
        check("G2-3-6b FAIL0: daily_usage.count and IP messages refunded to before values",
              daily_count(uid) == d0 and ip_messages(IP["K"]) == i0,
              f"daily={daily_count(uid)}/{d0} ip={ip_messages(IP['K'])}/{i0}")
    c.close()


def guest_failed_text(ai_id: str) -> bool:
    return main.GENERATION_FAILED_TEXT in ai_content(ai_id)


def c18_generation_failed_after_output():
    with env(DAILY_MESSAGE_LIMIT="100000", GUEST_IP_DAILY_MESSAGES="100000"):
        c = new_client(ip=IP["L"])
        create_guest(c, IP["L"])
        uid = uid_of_token(c.cookies.get("session"))
        d0, i0 = daily_count(uid), ip_messages(IP["L"])
        r = chat(c, "FAIL1 please")
        ai_id = _ai_id_of(r)
        ok = wait_for(lambda: guest_failed_text(ai_id))
        check("G2-3-7a FAIL1 generation: AI message holds failure text", r.status_code == 200 and ok,
              f"status={r.status_code} content={ai_content(ai_id)[:80]!r}")
        check("G2-3-7b FAIL1 (output already produced): neither counter refunded (+1 each)",
              daily_count(uid) == d0 + 1 and ip_messages(IP["L"]) == i0 + 1,
              f"daily={daily_count(uid)}/{d0 + 1} ip={ip_messages(IP['L'])}/{i0 + 1}")
    c.close()


def c19_model_not_allowed():
    with env(DAILY_MESSAGE_LIMIT="100000", GUEST_IP_DAILY_MESSAGES="100000"):
        c = new_client(ip=IP["M"])
        create_guest(c, IP["M"])
        uid = uid_of_token(c.cookies.get("session"))
        d0, i0, m0 = daily_count(uid), ip_messages(IP["M"]), len(messages_of(uid))
        calls = LLM_CALLS["n"]
        r = c.post("/chat", json={"message": "hi", "model": "not/allowed-model"})
        check("G2-3-8a guest POST /chat with not/allowed-model → 403", r.status_code == 403, str(r.status_code))
        check("G2-3-8b neither counter changed, no new message, LLM not called",
              daily_count(uid) == d0 and ip_messages(IP["M"]) == i0
              and len(messages_of(uid)) == m0 and LLM_CALLS["n"] == calls,
              f"daily={daily_count(uid)}/{d0} ip={ip_messages(IP['M'])}/{i0} msgs={len(messages_of(uid))}/{m0}")
    c.close()


def c20_last_active():
    with env(DAILY_MESSAGE_LIMIT="1", GUEST_IP_DAILY_MESSAGES="100000"):
        c = new_client(ip=IP["N"])
        create_guest(c, IP["N"])
        uid = uid_of_token(c.cookies.get("session"))
        check("G2-3-9a last_active_at is None right after guest creation", last_active(uid) is None,
              str(last_active(uid)))
        r = chat(c, "first")
        check("G2-3-9b one successful chat → last_active_at set", r.status_code == 200 and last_active(uid) is not None,
              f"status={r.status_code} value={last_active(uid)}")
        before = last_active(uid)
        r = chat(c, "second")
        check("G2-3-9c 429 leaves last_active_at unchanged",
              r.status_code == 429 and last_active(uid) == before,
              f"status={r.status_code} before={before} after={last_active(uid)}")
    c.close()


def c21_guest_regenerate():
    with env(DAILY_MESSAGE_LIMIT="100000", GUEST_IP_DAILY_MESSAGES="100000"):
        c = new_client(ip=IP["M"])
        create_guest(c, IP["M"])
        uid = uid_of_token(c.cookies.get("session"))
        r = chat(c, "regen base")
        ai_id = _ai_id_of(r)  # 第一次生成的串流已讀到 done，所以這裡不會與背景生成競爭
        d0, i0 = daily_count(uid), ip_messages(IP["M"])
        r = c.post(f"/messages/{ai_id}/regenerate", json={"model": MODEL})
        check("G2-3-10a guest regenerate on last AI message → 200", r.status_code == 200, f"status={r.status_code}")
        check("G2-3-10b regenerate: daily_usage.count and IP messages both +1",
              daily_count(uid) == d0 + 1 and ip_messages(IP["M"]) == i0 + 1,
              f"daily={daily_count(uid)}/{d0 + 1} ip={ip_messages(IP['M'])}/{i0 + 1}")
    c.close()


def c22_ip_cap_concurrent():
    with env(DAILY_MESSAGE_LIMIT="100000", GUEST_IP_DAILY_MESSAGES="7"):
        tokens = []
        for _ in range(4):
            c = new_client(ip=IP["O"])
            create_guest(c, IP["O"])
            tokens.append(c.cookies.get("session"))
            c.close()
        uids = [uid_of_token(t) for t in tokens]

        def fire(i: int) -> int:
            with httpx.Client(base_url=BASE, timeout=60, cookies={"session": tokens[i % 4]},
                              headers=xff(IP["O"])) as cc:
                return chat(cc, f"burst {i}").status_code

        with ThreadPoolExecutor(max_workers=20) as ex:
            statuses = list(ex.map(fire, range(20)))
        check("G2-3-11a 20 concurrent chats on one IP with cap 7: exactly 7 → 200",
              statuses.count(200) == 7, f"200={statuses.count(200)} 429={statuses.count(429)} other={[s for s in statuses if s not in (200, 429)]}")
        check("G2-3-11b exactly 13 → 429", statuses.count(429) == 13, f"429={statuses.count(429)}")
        check("G2-3-11c guest_ip_usage.messages == 7", ip_messages(IP["O"]) == 7, str(ip_messages(IP["O"])))
        total = sum(daily_count(u) for u in uids)
        check("G2-3-11d sum of the 4 guests' daily_usage.count == 7", total == 7, str(total))


# ---------- (G2-4) 登入時的訪客處理 ----------

G4_PREFIX = f"10.{random.randint(0, 255)}.{random.randint(0, 255)}"
EXTRA_IPS: list[str] = []          # (G2-4) 本次新用的 IP（結束時清 guest_ip_usage）
OPEN_CLIENTS: list[httpx.Client] = []
S4: dict = {}                      # (G2-4) 案例之間共用的狀態


def fresh_ip() -> str:
    """(G2-4) 每個訪客用一個新 IP，避免每 IP 每日 10 個訪客的上限干擾。"""
    ip = f"{G4_PREFIX}.{len(EXTRA_IPS) + 1}"
    EXTRA_IPS.append(ip)
    return ip


def mk(ip: str | None = None) -> httpx.Client:
    """沒有任何 cookie 的新 client。cookie 一律由伺服器回應或 set_cookie 寫入，同一 domain，避免同名 cookie 重複。"""
    c = httpx.Client(base_url=BASE, timeout=60, headers=xff(ip) if ip else None)
    OPEN_CLIENTS.append(c)
    return c


def set_cookie(c: httpx.Client, name: str, value: str) -> None:
    c.cookies.set(name, value, domain="127.0.0.1", path="/")


def tok(c: httpx.Client, name: str = "session") -> str | None:
    for ck in c.cookies.jar:
        if ck.name == name:
            return ck.value
    return None


def raw_cookie(r: httpx.Response, name: str) -> str | None:
    """回傳回應中第一條 name=... 的原始 Set-Cookie 標頭（大小寫不限）。"""
    for h in r.headers.get_list("set-cookie"):
        if h.split("=", 1)[0].strip() == name:
            return h
    return None


def raw_value(header: str) -> str:
    return header.split(";", 1)[0].split("=", 1)[1]


def unique_gh() -> int:
    return int(uuid.uuid4().hex[:15], 16)


def acct_uid_of_gh(gh: int) -> uuid.UUID | None:
    with Session(engine) as s:
        u = s.exec(select(User).where(User.oauth_provider == "github", User.oauth_sub == str(gh))).first()
        return u.id if u else None


def login_as(c: httpx.Client, gh: int) -> httpx.Response:
    """假 GitHub 登入：帶 c 目前的 cookie 打 callback，不跟隨轉址，回傳原始回應（看 set-cookie）。"""
    GH_NEXT["id"] = gh
    r = c.get("/auth/github/callback?code=fake&state=fake", follow_redirects=False)
    if r.status_code == 303:
        uid = acct_uid_of_gh(gh)
        if uid is not None:
            CREATED_UIDS.append(uid)
    return r


def new_account(ip: str | None = None) -> tuple[httpx.Client, uuid.UUID, int]:
    """新的登入帳號（用 fresh client 登入）。回傳 (client, uid, gh)。"""
    c = mk(ip or fresh_ip())
    gh = unique_gh()
    r = login_as(c, gh)
    uid = acct_uid_of_gh(gh)
    if r.status_code != 303 or uid is None:
        raise RuntimeError(f"login_as failed: status={r.status_code}")
    return c, uid, gh


def make_guest_two_chats(ip: str) -> dict:
    """訪客兩個對話；第一個對話有一條分支、分支內一則訊息。共 6 則訊息、1 條分支。"""
    c = mk(ip)
    r = create_guest(c, ip)
    if r.status_code != 200 or r.json().get("created") is not True:
        raise RuntimeError(f"create_guest failed: {r.status_code}")
    uid = uid_of_token(tok(c))
    r1 = chat(c, "g4 chat one")
    if r1.status_code != 200:
        raise RuntimeError(f"chat one: {r1.status_code}")
    ai1 = _ai_id_of(r1)
    root1 = next(iter(roots_of_uid(uid)))
    rb = c.post(f"/chats/{root1}/branches", json={"anchor_message_id": ai1, "anchor_text": "g4 anchor"})
    bid = rb.json().get("branch_id") if rb.status_code == 200 else None
    if bid is None:
        raise RuntimeError(f"create branch: {rb.status_code}")
    rm = c.post("/chat", json={"message": "g4 in branch", "model": MODEL, "parent_id": ai1, "branch_id": bid})
    if rm.status_code != 200:
        raise RuntimeError(f"chat in branch: {rm.status_code}")
    r2 = chat(c, "g4 chat two")
    if r2.status_code != 200:
        raise RuntimeError(f"chat two: {r2.status_code}")
    root2 = next(iter(roots_of_uid(uid) - {root1}))
    return {"c": c, "uid": uid, "root1": root1, "root2": root2, "bid": str(bid)}


def roots_of_uid(uid) -> set[str]:
    """(G2-4) 使用者的主線對話根（與 get_chat_roots 同條件）。"""
    with Session(engine) as s:
        rows = s.exec(select(Message.id).where(
            Message.user_id == uid, Message.parent_id == None, Message.branch_id == None  # noqa: E711
        )).all()
    return {str(x) for x in rows}


def owner_counts(uid) -> dict:
    with Session(engine) as s:
        return {
            "messages": s.exec(select(sa_func.count()).select_from(Message).where(Message.user_id == uid)).one(),
            "branches": s.exec(select(sa_func.count()).select_from(Branch).where(Branch.user_id == uid)).one(),
            "daily": s.exec(select(sa_func.count()).select_from(DailyUsage).where(DailyUsage.user_id == uid)).one(),
            "auth_sessions": s.exec(select(sa_func.count()).select_from(AuthSession).where(AuthSession.user_id == uid)).one(),
            "user": s.get(User, uid) is not None,
        }


def global_counts() -> tuple[int, int, int]:
    with Session(engine) as s:
        return (
            s.exec(select(sa_func.count()).select_from(User)).one(),
            s.exec(select(sa_func.count()).select_from(Message)).one(),
            s.exec(select(sa_func.count()).select_from(Branch)).one(),
        )


def msg_snapshot(uid) -> list[tuple[str, str]]:
    return sorted((str(m.id), m.content) for m in messages_of(uid))


def branch_owner(bid) -> uuid.UUID | None:
    with Session(engine) as s:
        b = s.get(Branch, uuid.UUID(str(bid)))
        return b.user_id if b else None


def claim(c: httpx.Client, action: str) -> httpx.Response:
    return c.post("/auth/guest-claim", json={"action": action})


def detail_code(r: httpx.Response) -> str | None:
    d = r.json().get("detail") if r.status_code in (403, 409) else None
    return d.get("code") if isinstance(d, dict) else None


def g4_1_login_with_pending_chats():
    g = make_guest_two_chats(fresh_ip())
    S4["g1"] = g
    c = g["c"]
    gtok = tok(c)
    gh = unique_gh()
    S4["gh1"] = gh
    r = login_as(c, gh)
    S4["acct1"] = acct_uid_of_gh(gh)
    check("G2-4-1a guest with 2 chats logs in → 303", r.status_code == 303, f"status={r.status_code}")
    sess_h = raw_cookie(r, "session")
    gs_h = raw_cookie(r, "guest_session")
    low = (gs_h or "").lower()
    check("G2-4-1b callback sets a NEW session cookie for the account",
          sess_h is not None and raw_value(sess_h) != gtok and tok(c) == raw_value(sess_h), str(sess_h)[:80])
    check("G2-4-1c guest_session = guest token, HttpOnly, SameSite=lax, Max-Age=86400",
          gs_h is not None and raw_value(gs_h) == gtok and "httponly" in low
          and "samesite=lax" in low and "max-age=86400" in low, str(gs_h)[:200])
    me = c.get("/auth/me")
    body = me.json() if me.status_code == 200 else {}
    check("G2-4-1d /auth/me → is_guest false and guest_claim {chat_count: 2}",
          body.get("is_guest") is False and body.get("guest_claim") == {"chat_count": 2}, str(body))


def g4_2_merge():
    g = S4["g1"]
    c, gid, acct = g["c"], g["uid"], S4["acct1"]
    n_msgs = owner_counts(gid)["messages"]
    r = claim(c, "merge")
    body = r.json() if r.status_code == 200 else {}
    check("G2-4-2a merge → 200 with action merge and chat_count 2",
          r.status_code == 200 and body.get("action") == "merge" and body.get("chat_count") == 2,
          f"status={r.status_code} body={r.text[:200]}")
    ga, aa = owner_counts(gid), owner_counts(acct)
    check("G2-4-2b every guest message and branch now belongs to the account",
          ga["messages"] == 0 and ga["branches"] == 0 and aa["messages"] == n_msgs
          and aa["branches"] == 1 and branch_owner(g["bid"]) == acct,
          f"guest={ga} acct={aa} n_msgs={n_msgs}")
    check("G2-4-2c guest user, auth_session and daily_usage rows are gone",
          not ga["user"] and ga["auth_sessions"] == 0 and ga["daily"] == 0, str(ga))
    rr = c.get("/chats/roots")
    ids = {row["id"] for row in rr.json()} if rr.status_code == 200 else None
    check("G2-4-2d account GET /chats/roots lists both chats",
          ids == {g["root1"], g["root2"]}, f"status={rr.status_code} ids={ids}")
    h = c.get(f"/chats/{g['root1']}/history")
    b = c.get(f"/chats/{g['root1']}/branches")
    bids = {x.get("id") for x in b.json()} if b.status_code == 200 else set()
    check("G2-4-2e history → 200 and branches → 200 with the branch present",
          h.status_code == 200 and b.status_code == 200 and g["bid"] in bids,
          f"history={h.status_code} branches={b.status_code} ids={bids}")
    gs_clear = raw_cookie(r, "guest_session")
    check("G2-4-2f response expires guest_session (Max-Age=0)",
          gs_clear is not None and "max-age=0" in gs_clear.lower(), str(gs_clear)[:200])
    claim_after = c.get("/auth/me").json().get("guest_claim")
    check("G2-4-2g /auth/me → guest_claim None after merge", claim_after is None, str(claim_after))
    S4["merged_root"] = g["root1"]


def g4_3_repeat_merge():
    c, acct = S4["g1"]["c"], S4["acct1"]
    before = (owner_counts(acct), global_counts())
    r = claim(c, "merge")
    check("G2-4-3a repeat merge → 409 no_pending_claim",
          r.status_code == 409 and detail_code(r) == "no_pending_claim", f"status={r.status_code} body={r.text[:200]}")
    check("G2-4-3b data unchanged after the repeat",
          (owner_counts(acct), global_counts()) == before, f"before={before}")


def g4_4_discard():
    ca, acct, gh = new_account()
    r = chat(ca, "account own chat")
    check("G2-4-4a account creates its own chat → 200", r.status_code == 200, str(r.status_code))
    own_root = next(iter(roots_of_uid(acct)))
    snap = msg_snapshot(acct)
    g = make_guest_two_chats(fresh_ip())
    gid, gc = g["uid"], g["c"]
    r = login_as(gc, gh)
    check("G2-4-4b guest with 2 chats logs in to the existing account → 303",
          r.status_code == 303, f"status={r.status_code}")
    r = claim(gc, "discard")
    body = r.json() if r.status_code == 200 else {}
    check("G2-4-4c discard → 200 with chat_count 2",
          r.status_code == 200 and body.get("action") == "discard" and body.get("chat_count") == 2,
          f"status={r.status_code} body={r.text[:200]}")
    gg = owner_counts(gid)
    check("G2-4-4d no message or branch with the guest id remains",
          gg["messages"] == 0 and gg["branches"] == 0, str(gg))
    check("G2-4-4e guest user row gone", not gg["user"] and gg["auth_sessions"] == 0 and gg["daily"] == 0, str(gg))
    check("G2-4-4f account still has exactly its own chat with unchanged content",
          roots_of_uid(acct) == {own_root} and msg_snapshot(acct) == snap and owner_counts(acct)["branches"] == 0,
          f"roots={roots_of_uid(acct)} own={own_root}")


def g4_5_usage_transfer():
    with env(DAILY_MESSAGE_LIMIT="10"):
        ip = fresh_ip()
        c = mk(ip)
        create_guest(c, ip)
        st = [chat(c, f"u5 {i}").status_code for i in range(7)]
        check("G2-4-5a guest sends 7 → all 200", st == [200] * 7, str(st))
        gh = unique_gh()
        r = login_as(c, gh)
        acct = acct_uid_of_gh(gh)
        check("G2-4-5b login → 303 and account daily_usage.count == 7 right after login",
              r.status_code == 303 and daily_count(acct) == 7,
              f"status={r.status_code} count={daily_count(acct)}")
        st = [chat(c, f"acct {i}").status_code for i in range(3)]
        check("G2-4-5c account sends 3 more → all 200", st == [200] * 3, str(st))
        r = chat(c, "fourth")
        check("G2-4-5d 4th → 429 daily_quota_exceeded",
              r.status_code == 429 and r.json().get("detail", {}).get("code") == "daily_quota_exceeded",
              f"status={r.status_code} body={r.text[:200]}")


def g4_6_usage_cap():
    with env(DAILY_MESSAGE_LIMIT="10"):
        ca, acct, gh = new_account()
        st = [chat(ca, f"a6 {i}").status_code for i in range(6)]
        check("G2-4-6a account used 6 today", st == [200] * 6 and daily_count(acct) == 6,
              f"st={st} count={daily_count(acct)}")
        ip = fresh_ip()
        cg = mk(ip)
        create_guest(cg, ip)
        st = [chat(cg, f"g6 {i}").status_code for i in range(7)]
        check("G2-4-6b guest used 7 today", st == [200] * 7, str(st))
        r = login_as(cg, gh)
        check("G2-4-6c login → account count == 10 (capped, not 13)",
              r.status_code == 303 and daily_count(acct) == 10, f"status={r.status_code} count={daily_count(acct)}")


def g4_7_no_guest_cookie():
    ca, acct, _ = new_account()
    before = (owner_counts(acct), global_counts())
    r = claim(ca, "merge")
    check("G2-4-7a logged-in account without guest_session → 409 no_pending_claim",
          r.status_code == 409 and detail_code(r) == "no_pending_claim", f"status={r.status_code}")
    check("G2-4-7b row counts unchanged", (owner_counts(acct), global_counts()) == before, str(before))


def g4_8_garbage_guest_cookie():
    ca, acct, _ = new_account()
    set_cookie(ca, "guest_session", uuid.uuid4().hex + uuid.uuid4().hex)
    before = (owner_counts(acct), global_counts())
    r = claim(ca, "merge")
    check("G2-4-8a random guest_session → 409 no_pending_claim",
          r.status_code == 409 and detail_code(r) == "no_pending_claim", f"status={r.status_code}")
    check("G2-4-8b nothing changed", (owner_counts(acct), global_counts()) == before, str(before))


def g4_9_account_session_as_guest_cookie():
    ca_a, acct_a, _ = new_account()
    r = chat(ca_a, "A chat")
    check("G2-4-9a account A creates a chat → 200", r.status_code == 200, str(r.status_code))
    roots_a = roots_of_uid(acct_a)
    count_a = owner_counts(acct_a)
    tok_a = tok(ca_a)
    cb, acct_b, _ = new_account()
    set_cookie(cb, "guest_session", tok_a)
    before_b = owner_counts(acct_b)
    r = claim(cb, "merge")
    check("G2-4-9b account B with A's session token as guest_session → 409",
          r.status_code == 409 and detail_code(r) == "no_pending_claim", f"status={r.status_code}")
    check("G2-4-9c A's chats still belong to A and A's user row exists",
          roots_of_uid(acct_a) == roots_a and owner_counts(acct_a) == count_a, str(owner_counts(acct_a)))
    check("G2-4-9d B's data unchanged", owner_counts(acct_b) == before_b, str(owner_counts(acct_b)))


def g4_10_guest_caller_with_other_guest_cookie():
    ip1 = fresh_ip()
    c1 = mk(ip1)
    create_guest(c1, ip1)
    g2 = make_guest_two_chats(fresh_ip())
    set_cookie(c1, "guest_session", tok(g2["c"]))
    before = (owner_counts(g2["uid"]), roots_of_uid(g2["uid"]))
    r = claim(c1, "merge")
    check("G2-4-10a guest caller → 403 guest_cannot_claim",
          r.status_code == 403 and detail_code(r) == "guest_cannot_claim", f"status={r.status_code} body={r.text[:200]}")
    check("G2-4-10b guest2's data unchanged", (owner_counts(g2["uid"]), roots_of_uid(g2["uid"])) == before,
          str(before))


def g4_11_zero_chats_login():
    ip = fresh_ip()
    c = mk(ip)
    create_guest(c, ip)
    gid = uid_of_token(tok(c))
    gh = unique_gh()
    r = login_as(c, gh)
    check("G2-4-11a zero-chat guest logs in → 303 with no guest_session cookie",
          r.status_code == 303 and raw_cookie(r, "guest_session") is None, f"status={r.status_code}")
    gg = owner_counts(gid)
    check("G2-4-11b guest user row deleted", not gg["user"] and gg["auth_sessions"] == 0 and gg["daily"] == 0, str(gg))
    me = c.get("/auth/me").json()
    check("G2-4-11c /auth/me → is_guest false, guest_claim None",
          me.get("is_guest") is False and me.get("guest_claim") is None, str(me))


def g4_12_bad_and_extra_fields():
    ca, _, _ = new_account()
    r = claim(ca, "steal")
    check("G2-4-12a action 'steal' → 422", r.status_code == 422, f"status={r.status_code}")
    decoy = make_guest_two_chats(fresh_ip())
    cx = make_guest_two_chats(fresh_ip())
    gh = unique_gh()
    r = login_as(cx["c"], gh)
    acct = acct_uid_of_gh(gh)
    check("G2-4-12b guest X logs in → 303", r.status_code == 303, f"status={r.status_code}")
    before_decoy = (owner_counts(decoy["uid"]), roots_of_uid(decoy["uid"]))
    r = cx["c"].post("/auth/guest-claim", json={"action": "merge", "guest_user_id": str(decoy["uid"])})
    body = r.json() if r.status_code == 200 else {}
    check("G2-4-12c merge with extra guest_user_id → 200, chat_count 2 (the cookie guest)",
          r.status_code == 200 and body.get("chat_count") == 2, f"status={r.status_code} body={r.text[:200]}")
    check("G2-4-12d X's data moved to the account (the cookie-identified guest)",
          owner_counts(cx["uid"])["messages"] == 0 and owner_counts(acct)["messages"] == 6,
          f"x={owner_counts(cx['uid'])} acct={owner_counts(acct)}")
    check("G2-4-12e the named decoy guest's data did NOT move",
          (owner_counts(decoy["uid"]), roots_of_uid(decoy["uid"])) == before_decoy and owner_counts(decoy["uid"])["user"],
          str(owner_counts(decoy["uid"])))


def g4_13_fresh_client_login():
    c = mk(fresh_ip())
    gh = unique_gh()
    r = login_as(c, gh)
    check("G2-4-13a fresh client login → 303, session set, no guest_session cookie",
          r.status_code == 303 and raw_cookie(r, "session") is not None and raw_cookie(r, "guest_session") is None,
          f"status={r.status_code}")
    me = c.get("/auth/me").json()
    check("G2-4-13b /auth/me → is_guest false, guest_claim None",
          me.get("is_guest") is False and me.get("guest_claim") is None, str(me))


def g4_14_merged_chat_hidden_from_other_account():
    cc, _, _ = new_account()
    root = S4["merged_root"]
    rh = cc.get(f"/chats/{root}/history")
    rt = cc.get(f"/chats/{root}/tree")
    check("G2-4-14 another account C: GET history and tree of the merged chat → 404",
          rh.status_code == 404 and rt.status_code == 404, f"history={rh.status_code} tree={rt.status_code}")


def g4_15_atomic_merge():
    g = make_guest_two_chats(fresh_ip())
    gid, c = g["uid"], g["c"]
    gh = unique_gh()
    r = login_as(c, gh)
    check("G2-4-15a guest logs in to account → 303", r.status_code == 303, f"status={r.status_code}")
    acct = acct_uid_of_gh(gh)
    before_guest = owner_counts(gid)
    original = guest.delete_guest_user

    def boom(*args, **kwargs):
        raise RuntimeError("injected failure after move_user_data")

    guest.delete_guest_user = boom
    try:
        r = claim(c, "merge")
    finally:
        guest.delete_guest_user = original
    check("G2-4-15b injected failure during merge → 500", r.status_code == 500, f"status={r.status_code}")
    after_guest, after_acct = owner_counts(gid), owner_counts(acct)
    check("G2-4-15c the move was rolled back: guest still owns its messages and branch",
          after_guest["messages"] == before_guest["messages"] == 6 and after_guest["branches"] == 1
          and after_acct["messages"] == 0 and branch_owner(g["bid"]) == gid, f"guest={after_guest} acct={after_acct}")
    check("G2-4-15d guest user row and auth_session still exist",
          after_guest["user"] and after_guest["auth_sessions"] >= 1, str(after_guest))


G24_CASES = [g4_1_login_with_pending_chats, g4_2_merge, g4_3_repeat_merge, g4_4_discard,
             g4_5_usage_transfer, g4_6_usage_cap, g4_7_no_guest_cookie, g4_8_garbage_guest_cookie,
             g4_9_account_session_as_guest_cookie, g4_10_guest_caller_with_other_guest_cookie,
             g4_11_zero_chats_login, g4_12_bad_and_extra_fields, g4_13_fresh_client_login,
             g4_14_merged_chat_hidden_from_other_account, g4_15_atomic_merge]

CASES = [c01_create_guest, c02_me_for_guest, c03_same_client_again, c04_guest_chats,
         c05_ip_b_cap, c06_ip_c_concurrent, c07_ip_d_fresh, c08_no_raw_ip_in_db,
         c09_origin, c10_isolation, c11_no_cookie,
         c12_default_limit, c13_daily_limit_ten, c14_ip_cap_shared, c15_ip_cap_isolation,
         c16_personal_limit_rolls_back_ip, c17_generation_failed_before_output,
         c18_generation_failed_after_output, c19_model_not_allowed, c20_last_active,
         c21_guest_regenerate, c22_ip_cap_concurrent] + G24_CASES


# ---------- (G2-5) 保留期限清理 ----------

S5: dict = {}   # (G2-5) 案例之間共用的狀態


def now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def set_times(uid, created: datetime, last_active: datetime | None) -> None:
    """(G2-5) 直接回填 user.created_at / last_active_at（None 表示 NULL）。"""
    with Session(engine) as s:
        s.execute(sa_text('UPDATE "user" SET created_at = :c, last_active_at = :la WHERE id = :u'),
                  {"c": created, "la": last_active, "u": uid})
        s.commit()


def make_guest_one_chat(ip: str) -> tuple[httpx.Client, uuid.UUID]:
    """(G2-5) 訪客發一則訊息（有一個對話 root、一個 daily_usage 列）。"""
    c = mk(ip)
    r = create_guest(c, ip)
    if r.status_code != 200 or r.json().get("created") is not True:
        raise RuntimeError(f"create_guest failed: {r.status_code}")
    uid = uid_of_token(tok(c))
    r1 = chat(c, "g5 chat")
    if r1.status_code != 200:
        raise RuntimeError(f"g5 chat: {r1.status_code}")
    return c, uid


def g5_1_expired_guest_purged():
    now = now_naive()
    # 訪客 X：8 天沒活動，有兩個對話（含一條分支）
    g = make_guest_two_chats(fresh_ip())
    S5["X"] = g
    uidX = g["uid"]
    S5["tokX"] = tok(g["c"])
    dX = owner_counts(uidX)
    check("G2-5-1a setup: guest X has 6 messages, 1 branch, daily_usage and auth_session",
          dX["messages"] == 6 and dX["branches"] == 1 and dX["daily"] >= 1 and dX["auth_sessions"] >= 1, str(dX))
    set_times(uidX, now - timedelta(days=8), now - timedelta(days=8))

    # 訪客 Y：6 天沒活動（應保留）
    cy, uidY = make_guest_one_chat(fresh_ip())
    set_times(uidY, now - timedelta(days=6), now - timedelta(days=6))
    S5["Y"] = (cy, uidY)

    # 訪客 Z：last_active NULL、created 8 天前（應刪）；訪客 W：created 8 天前但 last_active 1 天前（應留）
    ip_z = fresh_ip()
    cz = mk(ip_z)
    create_guest(cz, ip_z)
    uidZ = uid_of_token(tok(cz))
    set_times(uidZ, now - timedelta(days=8), None)
    S5["Z"] = uidZ
    ip_w = fresh_ip()
    cw = mk(ip_w)
    create_guest(cw, ip_w)
    uidW = uid_of_token(tok(cw))
    set_times(uidW, now - timedelta(days=8), now - timedelta(days=1))
    S5["W"] = (cw, uidW)

    # 登入帳號 A：30 天前建立、30 天沒活動，有一個對話（不得被動到）
    ca, acct, _ = new_account()
    r = chat(ca, "g5 account chat")
    check("G2-5-1b setup: account A creates a chat → 200", r.status_code == 200, str(r.status_code))
    set_times(acct, now - timedelta(days=30), now - timedelta(days=30))
    S5["A"] = (ca, acct, owner_counts(acct)["messages"])

    # guest_ip_usage：兩個新 IP，一個 3 天前、一個 1 天前（台灣日期）
    ip_old, ip_new = fresh_ip(), fresh_ip()
    S5["ip_old"], S5["ip_new"] = ip_old, ip_new
    with Session(engine) as s:
        s.add(GuestIpUsage(ip_hash=guest.hash_ip(ip_old), day=guest.taiwan_today() - timedelta(days=3),
                           guests_created=1, messages=1))
        s.add(GuestIpUsage(ip_hash=guest.hash_ip(ip_new), day=guest.taiwan_today() - timedelta(days=1),
                           guests_created=1, messages=1))
        s.commit()

    with Session(engine) as s:
        S5["n"] = guest.purge_expired_guests(s)

    check("G2-5-1c purge returns >= 1", S5["n"] >= 1, str(S5["n"]))
    d = owner_counts(uidX)
    check("G2-5-1d expired guest X: user, auth_session, daily_usage, messages and branches all gone",
          d == {"messages": 0, "branches": 0, "daily": 0, "auth_sessions": 0, "user": False}, str(d))


def g5_2_recent_guest_kept():
    cy, uidY = S5["Y"]
    d = owner_counts(uidY)
    check("G2-5-2 guest Y (6 days inactive) kept with its chat after purge",
          d["user"] and d["messages"] >= 2 and len(roots_of_uid(uidY)) == 1, str(d))


def g5_3_null_last_active():
    cw, uidW = S5["W"]
    check("G2-5-3a guest Z (last_active NULL, created 8 days ago) deleted",
          not owner_counts(S5["Z"])["user"], str(owner_counts(S5["Z"])))
    check("G2-5-3b guest W (created 8 days ago, last_active 1 day ago) kept",
          owner_counts(uidW)["user"], str(owner_counts(uidW)))


def g5_4_account_untouched():
    ca, acct, msgs = S5["A"]
    d = owner_counts(acct)
    check("G2-5-4 account (30 days inactive) untouched: user and chat still exist",
          d["user"] and d["messages"] == msgs and msgs >= 2, f"{d} before={msgs}")


def g5_5_ip_usage_pruned():
    with Session(engine) as s:
        old = s.get(GuestIpUsage, (guest.hash_ip(S5["ip_old"]), guest.taiwan_today() - timedelta(days=3)))
        new = s.get(GuestIpUsage, (guest.hash_ip(S5["ip_new"]), guest.taiwan_today() - timedelta(days=1)))
    check("G2-5-5a guest_ip_usage row from 3 days ago deleted", old is None, str(old))
    check("G2-5-5b guest_ip_usage row from 1 day ago kept", new is not None, str(new))


def g5_6_retention_zero_keeps_everything():
    now = now_naive()
    c, uid = make_guest_one_chat(fresh_ip())
    set_times(uid, now - timedelta(days=30), now - timedelta(days=30))
    S5["V"] = uid
    with env(GUEST_RETENTION_DAYS="0"):
        with Session(engine) as s:
            n = guest.purge_expired_guests(s)
    d = owner_counts(uid)
    check("G2-5-6a GUEST_RETENTION_DAYS=0: 30-day-inactive guest NOT deleted",
          d["user"] and d["messages"] >= 2, f"n={n} {d}")
    with env(GUEST_RETENTION_DAYS=None):
        with Session(engine) as s:
            guest.purge_expired_guests(s)
    check("G2-5-6b after restoring the env, the same guest is purged",
          not owner_counts(uid)["user"], str(owner_counts(uid)))


def g5_7_old_cookie_rejected():
    c = new_client(token=S5["tokX"])
    try:
        r = c.get("/auth/me")
    finally:
        c.close()
    check("G2-5-7 X's old session cookie after purge → GET /auth/me 401",
          r.status_code == 401, str(r.status_code))


def g5_8_failure_isolation():
    now = now_naive()
    cp, uidP = make_guest_one_chat(fresh_ip())
    set_times(uidP, now - timedelta(days=8), now - timedelta(days=8))
    msgs_p = owner_counts(uidP)["messages"]
    ip_q = fresh_ip()
    cq = mk(ip_q)
    create_guest(cq, ip_q)
    uidQ = uid_of_token(tok(cq))
    set_times(uidQ, now - timedelta(days=8), now - timedelta(days=8))

    original = guest.delete_guest_user

    def boom_for_p(session, gid, *, keep_data):
        if gid == uidP:
            raise RuntimeError("injected failure for guest P")
        return original(session, gid, keep_data=keep_data)

    guest.delete_guest_user = boom_for_p
    try:
        with Session(engine) as s:
            n = guest.purge_expired_guests(s)
    finally:
        guest.delete_guest_user = original

    check("G2-5-8a purge with one failing guest does not raise and counts the successes",
          n >= 1, f"n={n}")
    check("G2-5-8b the other expired guest Q is deleted", not owner_counts(uidQ)["user"], str(owner_counts(uidQ)))
    dp = owner_counts(uidP)
    check("G2-5-8c failing guest P still exists with its chat intact",
          dp["user"] and dp["messages"] == msgs_p and msgs_p >= 2, f"{dp} before={msgs_p}")


def g5_9_background_wiring():
    ok = wait_for(lambda: PURGE_CALLS["n"] >= 1)
    check("G2-5-9a background purge loop ran at startup (run_purge_once called >= 1)",
          ok, f"calls={PURGE_CALLS['n']}")
    check("G2-5-9b main.GUEST_PURGE_INTERVAL_SECONDS == 3600",
          main.GUEST_PURGE_INTERVAL_SECONDS == 3600, str(main.GUEST_PURGE_INTERVAL_SECONDS))


G5_CASES = [g5_1_expired_guest_purged, g5_2_recent_guest_kept, g5_3_null_last_active,
            g5_4_account_untouched, g5_5_ip_usage_pruned, g5_6_retention_zero_keeps_everything,
            g5_7_old_cookie_rejected, g5_8_failure_isolation, g5_9_background_wiring]


# ---------- 伺服器與清理 ----------

def start_server() -> uvicorn.Server:
    config = uvicorn.Config(
        main.app,
        host="127.0.0.1",
        port=PORT,
        log_level="warning",
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError(f"uvicorn did not start on 127.0.0.1:{PORT}")
    return server


def cleanup_user(uid: uuid.UUID):
    """只清這個測試 user 的列：分支與訊息（先斷開 FK）→ daily_usage → auth_session → user。"""
    try:
        with Session(engine) as s:
            branch_ids = {m.branch_id for m in s.exec(select(Message).where(Message.user_id == uid)).all()
                          if m.branch_id}
            branch_ids |= set(s.exec(select(Branch.id).where(Branch.user_id == uid)).all())
            branch_ids = list(branch_ids)
        with Session(engine) as s:
            for b in s.exec(select(Branch).where(Branch.id.in_(branch_ids))).all():
                b.root_message_id = None
                b.anchor_message_id = None
                b.attach_root_id = None
                b.parent_branch_id = None
                s.add(b)
            s.commit()
        with Session(engine) as s:
            for m in s.exec(select(Message).where(Message.user_id == uid)).all():
                m.parent_id = None
                m.branch_id = None
                m.anchor_message_id = None
                s.add(m)
            s.commit()
        with Session(engine) as s:
            for m in s.exec(select(Message).where(Message.user_id == uid)).all():
                s.delete(m)
            s.commit()
        with Session(engine) as s:
            for b in s.exec(select(Branch).where(Branch.id.in_(branch_ids))).all():
                s.delete(b)
            s.commit()
        with Session(engine) as s:
            s.execute(sa_delete(DailyUsage).where(DailyUsage.user_id == uid))
            for a in s.exec(select(AuthSession).where(AuthSession.user_id == uid)).all():
                s.delete(a)
            s.commit()
            u = s.get(User, uid)
            if u is not None:
                s.delete(u)
            s.commit()
    except Exception as e:  # noqa: BLE001
        print(f"cleanup FAILED for {uid}: {e}")


def cleanup_ip_usage():
    """只刪本次執行用過的 IP 雜湊列。"""
    hashes = [guest.hash_ip(ip) for ip in list(IP.values()) + EXTRA_IPS]
    try:
        with Session(engine) as s:
            s.execute(sa_delete(GuestIpUsage).where(GuestIpUsage.ip_hash.in_(hashes)))
            s.commit()
    except Exception as e:  # noqa: BLE001
        print(f"cleanup FAILED for guest_ip_usage: {e}")


def main_entry() -> int:
    server = None
    try:
        server = start_server()
        for fn in CASES + G5_CASES:  # (G2-5) G5_CASES 定義在下方，這裡才組合
            run(fn)
    except Exception as e:  # noqa: BLE001
        check("harness setup", False, f"exception: {e!r}")
    finally:
        for c in [S.get("cA"), S.get("cG2")] + OPEN_CLIENTS:
            if c is not None:
                c.close()
        if server is not None:
            server.should_exit = True
        for uid in dict.fromkeys(CREATED_UIDS):
            cleanup_user(uid)
        cleanup_ip_usage()

    total = len(RESULTS)
    failed = [(n, d) for n, ok, d in RESULTS if not ok]
    for n, d in failed:
        print(f"  FAIL {n}: {d}")
    if failed or total == 0:
        print(f"FAILED {len(failed)}/{total}")
        return 1
    print(f"ALL PASS ({total})")
    return 0


if __name__ == "__main__":
    sys.exit(main_entry())
