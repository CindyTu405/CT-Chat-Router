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
"""
import os
import sys
import threading
import time
import uuid
import random
import re
from concurrent.futures import ThreadPoolExecutor

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
from sqlalchemy import delete as sa_delete, func as sa_func  # noqa: E402
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


CASES = [c01_create_guest, c02_me_for_guest, c03_same_client_again, c04_guest_chats,
         c05_ip_b_cap, c06_ip_c_concurrent, c07_ip_d_fresh, c08_no_raw_ip_in_db,
         c09_origin, c10_isolation, c11_no_cookie,
         c12_default_limit, c13_daily_limit_ten, c14_ip_cap_shared, c15_ip_cap_isolation,
         c16_personal_limit_rolls_back_ip, c17_generation_failed_before_output,
         c18_generation_failed_after_output, c19_model_not_allowed, c20_last_active,
         c21_guest_regenerate, c22_ip_cap_concurrent]


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
    hashes = [guest.hash_ip(ip) for ip in IP.values()]
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
        for fn in CASES:
            run(fn)
    except Exception as e:  # noqa: BLE001
        check("harness setup", False, f"exception: {e!r}")
    finally:
        for c in [S.get("cA"), S.get("cG2")]:
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
