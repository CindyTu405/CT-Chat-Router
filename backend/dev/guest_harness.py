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
os.environ["CORS_ORIGINS"] = "http://localhost:5173"

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
    """假的 LLM 串流：只計數、固定輸出，不連任何外部服務。"""
    LLM_CALLS["n"] += 1
    yield "GUEST-"
    yield "REPLY"


main.gemini_chat_stream = fake_stream
main.openrouter_chat_stream = fake_stream

# 每次執行一個隨機前綴；A..F 各代表一個來源 IP
PREFIX = f"10.{random.randint(0, 255)}.{random.randint(0, 255)}"
IP = {label: f"{PREFIX}.{n}" for n, label in enumerate("ABCDEF", start=1)}

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


def new_client(token: str | None = None) -> httpx.Client:
    cookies = {"session": token} if token else None
    return httpx.Client(base_url=BASE, timeout=60, cookies=cookies)


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
    c = new_client()
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
    cG2 = new_client()
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


CASES = [c01_create_guest, c02_me_for_guest, c03_same_client_again, c04_guest_chats,
         c05_ip_b_cap, c06_ip_c_concurrent, c07_ip_d_fresh, c08_no_raw_ip_in_db,
         c09_origin, c10_isolation, c11_no_cookie]


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
