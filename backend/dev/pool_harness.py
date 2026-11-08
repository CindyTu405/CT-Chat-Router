"""(B12) 連線池壓力測試：多人同時生成時，無關用戶的請求與串流不能被卡住。

用法（只用臨時資料庫，不要指向正式 chat_db）：
    cd backend && POSTGRES_DB=v1_models SQL_ECHO=false uv run python dev/pool_harness.py 2>&1 | grep -v sqlalchemy | tail -5

做的事：
- 把 main.gemini_chat_stream 換成假串流：先吐一段、sleep 約 6 秒、再吐一段（絕不呼叫真模型）。
- 三個階段，各 30 / 30 / 20 個併發：
  1. 30 人各開一個 /chat 生成
  2. 30 個 GET /messages/{id}/stream 續讀端，讀的是進行中的生成
  3. 20 個 regenerate
  每個階段：生成開始 2 秒後，無關用戶的 GET /auth/me 必須 2 秒內回 200；
  所有串流都回 200 且內容完整；DB 裡的 AI 訊息內容等於完整文字。
- 伺服器 log 不能出現 QueuePool。
- 只清理本腳本建立的 user（訊息、daily_usage、auth_session 一併清）。
"""
import asyncio
import logging
import os
import sys
import threading
import time
import uuid
from datetime import timedelta

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

os.environ["ALLOWED_MODELS"] = "gemini*"
os.environ["DAILY_MESSAGE_LIMIT"] = "100000"
os.environ["SITE_DAILY_MESSAGE_LIMIT"] = "10000000"

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from sqlalchemy import delete as sa_delete  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

import main  # noqa: E402
import auth_routes  # noqa: E402
from database import engine  # noqa: E402
from models import AuthSession, DailyUsage, Message, User  # noqa: E402

engine.echo = False

PORT = 8769
BASE = f"http://127.0.0.1:{PORT}"
MODEL = "gemini-2.5-flash-lite"
SLOW_SECONDS = 6.0          # 假串流總長約 6 秒
PROBE_AFTER = 2.0           # 生成開始 2 秒後探測
PROBE_LIMIT = 2.0           # 探測必須在這之內回 200

main.BUFFER_RETENTION_SECONDS = 2
main.get_free_models = lambda session, force_refresh=False: []
main.limiter.enabled = False

# ---------- 假串流 ----------

def head_of(message: str) -> str:
    return f"[{message}] first half. "


def full_of(message: str) -> str:
    return head_of(message) + "second half."


async def fake_stream(message, history, model):
    """setup- 開頭的訊息立即完成（建立前置資料用）；其餘慢速串流約 6 秒。"""
    if message.startswith("setup-"):
        yield full_of(message)
        return
    yield head_of(message)
    await asyncio.sleep(SLOW_SECONDS)
    yield "second half."


main.gemini_chat_stream = fake_stream
main.openrouter_chat_stream = fake_stream

# ---------- log 擷取 ----------

class _Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines: list[str] = []
        self.lock = threading.Lock()

    def emit(self, record):
        try:
            text = self.format(record)
        except Exception:  # noqa: BLE001
            text = record.getMessage()
        with self.lock:
            self.lines.append(text)


CAPTURE = _Capture()
CAPTURE.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))

# ---------- 結果 ----------

RESULTS: list[tuple[str, bool, str]] = []
CREATED: list[uuid.UUID] = []


def check(name: str, cond: bool, detail: str = ""):
    RESULTS.append((name, bool(cond), detail))
    if cond:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name}: {detail}")


# ---------- 小工具 ----------

def make_user() -> tuple[uuid.UUID, str]:
    with Session(engine) as s:
        u = User(oauth_provider="github", oauth_sub=f"pool-harness-{uuid.uuid4()}",
                 email="pool-harness@example.invalid")
        s.add(u)
        s.commit()
        s.refresh(u)
        uid = u.id
        token = auth_routes.create_session_token(s, u)
    CREATED.append(uid)
    return uid, token


def client_for(token: str, timeout: float = 90) -> httpx.Client:
    return httpx.Client(base_url=BASE, timeout=timeout, cookies={"session": token})


def chat_body(message: str) -> dict:
    return {"message": message, "model": MODEL}


def db_content(msg_id: str) -> str | None:
    with Session(engine) as s:
        m = s.get(Message, uuid.UUID(msg_id))
        return m.content if m else None


def probe_unrelated(token: str) -> tuple[int | None, float, str]:
    """無關用戶打 GET /auth/me，回傳 (status, 耗時秒, 錯誤文字)。"""
    t0 = time.time()
    try:
        with client_for(token, timeout=10) as c:
            r = c.get("/auth/me")
            return r.status_code, time.time() - t0, ""
    except Exception as e:  # noqa: BLE001
        return None, time.time() - t0, repr(e)


def start_threads(targets):
    threads = []
    for fn in targets:
        t = threading.Thread(target=fn, daemon=True)
        t.start()
        threads.append(t)
    return threads


def join_all(threads, timeout: float = 90):
    deadline = time.time() + timeout
    for t in threads:
        t.join(max(0.0, deadline - time.time()))


# ---------- 階段 ----------

def run_generation_client(token: str, message: str, slot: dict, idx: int, started: threading.Event | None = None):
    """POST /chat（或 regenerate）並讀完整個串流，結果寫進 slot[idx]。"""
    try:
        with client_for(token) as c:
            with c.stream("POST", "/chat", json=chat_body(message)) as r:
                ai = r.headers.get("X-Message-Id")
                slot[idx] = {"ai": ai, "status": r.status_code}
                if started is not None:
                    started.set()
                body = r.read().decode("utf-8")
                slot[idx]["body"] = body
    except Exception as e:  # noqa: BLE001
        slot.setdefault(idx, {})["error"] = repr(e)
        if started is not None:
            started.set()


def run_regen_client(token: str, ai_id: str, content: str, slot: dict, idx: int):
    try:
        with client_for(token) as c:
            with c.stream("POST", f"/messages/{ai_id}/regenerate",
                          json={"model": MODEL, "content": content}) as r:
                slot[idx] = {"ai": ai_id, "status": r.status_code}
                body = r.read().decode("utf-8")
                slot[idx]["body"] = body
    except Exception as e:  # noqa: BLE001
        slot.setdefault(idx, {})["error"] = repr(e)


def run_reader_client(token: str, ai_id: str, slot: dict, idx: int):
    try:
        with client_for(token) as c:
            with c.stream("GET", f"/messages/{ai_id}/stream", params={"offset": 0}) as r:
                slot[idx] = {"ai": ai_id, "status": r.status_code}
                body = r.read().decode("utf-8")
                slot[idx]["body"] = body
    except Exception as e:  # noqa: BLE001
        slot.setdefault(idx, {})["error"] = repr(e)


def summarize_and_check(phase: str, n: int, slot: dict, expected: dict[int, str], users: list):
    """檢查：全部 200、body 完整、DB 內容完整。expected[i] = 第 i 個的完整文字。"""
    statuses = [slot.get(i, {}).get("status") for i in range(n)]
    check(f"{phase} all {n} return 200", statuses == [200] * n,
          f"statuses={statuses} errors={[slot.get(i, {}).get('error') for i in range(n) if slot.get(i, {}).get('error')][:3]}")
    bodies_ok = all(slot.get(i, {}).get("body") == expected[i] for i in range(n))
    bad = [i for i in range(n) if slot.get(i, {}).get("body") != expected[i]]
    check(f"{phase} every body is the full text", bodies_ok,
          f"bad indexes={bad[:5]} example={repr(slot.get(bad[0], {}).get('body'))[:120] if bad else ''}")
    # 整個階段共用一個 DB 等待期限（串流結束與 DB 寫回之間有一小段時間）
    deadline = time.time() + 10
    pending = {i: slot.get(i, {}).get("ai") for i in range(n)}
    db_bad: list[int] = []
    while True:
        db_bad = []
        for i, ai in pending.items():
            if not ai or db_content(ai) != expected[i]:
                db_bad.append(i)
        if not db_bad or time.time() > deadline:
            break
        time.sleep(0.2)
    check(f"{phase} every DB content is the full text", not db_bad,
          f"bad indexes={db_bad[:5]}")


def phase_chat(tag: str) -> None:
    print(f"--- phase {tag}: 30 concurrent /chat ---")
    users = [make_user() for _ in range(30)]
    probe_uid, probe_token = make_user()
    msgs = [f"{tag}-chat-{i}" for i in range(30)]
    slot: dict = {}
    threads = start_threads(
        [lambda i=i: run_generation_client(users[i][1], msgs[i], slot, i) for i in range(30)]
    )
    time.sleep(PROBE_AFTER)
    st, dt, err = probe_unrelated(probe_token)
    check(f"{tag} unrelated GET /auth/me -> 200 in < {PROBE_LIMIT}s",
          st == 200 and dt < PROBE_LIMIT, f"status={st} took={dt:.2f}s {err}")
    join_all(threads)
    expected = {i: full_of(msgs[i]) for i in range(30)}
    summarize_and_check(tag, 30, slot, expected, users)


def phase_readers(tag: str) -> None:
    print(f"--- phase {tag}: 30 concurrent stream readers on in-progress generations ---")
    users = [make_user() for _ in range(30)]
    probe_uid, probe_token = make_user()
    msgs = [f"{tag}-reader-{i}" for i in range(30)]
    gen_slot: dict = {}
    started = [threading.Event() for _ in range(30)]
    gen_threads = start_threads(
        [lambda i=i: run_generation_client(users[i][1], msgs[i], gen_slot, i, started[i]) for i in range(30)]
    )
    deadline = time.time() + 30
    all_started = all(ev.wait(max(0.0, deadline - time.time())) for ev in started)
    check(f"{tag} all 30 generations started (headers received)", all_started, "")
    ai_ids = [gen_slot.get(i, {}).get("ai") for i in range(30)]
    reader_slot: dict = {}
    reader_threads = start_threads(
        [lambda i=i: run_reader_client(users[i][1], ai_ids[i], reader_slot, i) for i in range(30)
         if ai_ids[i]]
    )
    time.sleep(PROBE_AFTER)
    st, dt, err = probe_unrelated(probe_token)
    check(f"{tag} unrelated GET /auth/me -> 200 in < {PROBE_LIMIT}s",
          st == 200 and dt < PROBE_LIMIT, f"status={st} took={dt:.2f}s {err}")
    join_all(reader_threads)
    join_all(gen_threads)
    expected = {i: full_of(msgs[i]) for i in range(30)}
    summarize_and_check(f"{tag} readers", 30, reader_slot, expected, users)
    # 生成端也要完整寫回
    summarize_and_check(f"{tag} generators", 30, gen_slot, expected, users)


def phase_regenerate(tag: str) -> None:
    print(f"--- phase {tag}: 20 concurrent regenerates ---")
    n = 20
    users = [make_user() for _ in range(n)]
    probe_uid, probe_token = make_user()
    ai_ids = []
    for i, (uid, token) in enumerate(users):
        with client_for(token) as c:
            with c.stream("POST", "/chat", json=chat_body(f"setup-{tag}-{i}")) as r:
                ai_ids.append(r.headers.get("X-Message-Id"))
                r.read()
    check(f"{tag} setup: 20 completed first messages", all(ai_ids) and len(ai_ids) == n, "")
    regen_msgs = [f"{tag}-regen-{i}" for i in range(n)]
    slot: dict = {}
    threads = start_threads(
        [lambda i=i: run_regen_client(users[i][1], ai_ids[i], regen_msgs[i], slot, i) for i in range(n)]
    )
    time.sleep(PROBE_AFTER)
    st, dt, err = probe_unrelated(probe_token)
    check(f"{tag} unrelated GET /auth/me -> 200 in < {PROBE_LIMIT}s",
          st == 200 and dt < PROBE_LIMIT, f"status={st} took={dt:.2f}s {err}")
    join_all(threads)
    expected = {i: full_of(regen_msgs[i]) for i in range(n)}
    summarize_and_check(tag, n, slot, expected, users)


# ---------- 伺服器與清理 ----------

def start_server() -> uvicorn.Server:
    config = uvicorn.Config(main.app, host="127.0.0.1", port=PORT, log_level="warning", log_config=None)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError(f"uvicorn did not start on 127.0.0.1:{PORT}")
    return server


def cleanup(uid: uuid.UUID):
    """只清這個測試 user 的列：訊息（先斷開自關聯 FK）→ daily_usage → auth_session → user。"""
    try:
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
            s.execute(sa_delete(DailyUsage).where(DailyUsage.user_id == uid))
            for a in s.exec(select(AuthSession).where(AuthSession.user_id == uid)).all():
                s.delete(a)
            s.commit()
            u = s.get(User, uid)
            if u is not None:
                s.delete(u)
            s.commit()
        print(f"cleanup: removed user {uid}")
    except Exception as e:  # noqa: BLE001
        print(f"cleanup FAILED for {uid}: {e}")


def main_entry() -> int:
    # 只擷取 WARNING 以上（伺服器的例外與 QueuePool 都是 ERROR）。不能開 INFO：
    # httpx 每個請求都記 INFO，會讓所有client執行緒擠在 handler 的鎖上。
    logging.getLogger().addHandler(CAPTURE)
    logging.getLogger().setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    server = None
    try:
        server = start_server()
        phase_chat("p1")
        phase_readers("p2")
        phase_regenerate("p3")
    except Exception as e:  # noqa: BLE001
        check("harness setup", False, f"exception: {e!r}")
    finally:
        if server is not None:
            server.should_exit = True
        for uid in CREATED:
            cleanup(uid)

    with CAPTURE.lock:
        log_text = "\n".join(CAPTURE.lines)
    check("server log has no QueuePool", "QueuePool" not in log_text,
          f"found in log ({log_text.count('QueuePool')} lines)")

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = [(n, d) for n, ok, d in RESULTS if not ok]
    print(f"--- {passed} PASS, {len(failed)} FAIL ---")
    for n, d in failed:
        print(f"  FAIL {n}: {d}")
    if failed or passed == 0:
        print("SOME FAIL")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main_entry())
