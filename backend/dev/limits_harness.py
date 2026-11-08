"""(B13-1) 輸入長度上限與寫入端點限流的測試腳本。

用法（只用臨時資料庫，不要指向正式 chat_db）：
    cd backend && POSTGRES_DB=v1_models SQL_ECHO=false uv run python dev/limits_harness.py 2>&1 | grep -v sqlalchemy | tail -15

做的事：真的 uvicorn（127.0.0.1:8770）+ 假 LLM 串流，絕不呼叫真模型；限流只在 g、h 案例開啟。
"""
import os
import sys
import threading
import time
import uuid

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

os.environ["ALLOWED_MODELS"] = "gemini*"
os.environ["MAX_OUTPUT_TOKENS"] = "3000"
os.environ["DAILY_MESSAGE_LIMIT"] = "100000"
os.environ["SITE_DAILY_MESSAGE_LIMIT"] = "1000000"

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from sqlalchemy import delete as sa_delete  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

import main  # noqa: E402
import auth_routes  # noqa: E402
from database import engine  # noqa: E402
from models import AuthSession, Branch, DailyUsage, Message, User  # noqa: E402

engine.echo = False

PORT = 8770
BASE = f"http://127.0.0.1:{PORT}"
MODEL = "gemini-2.5-flash-lite"

main.BUFFER_RETENTION_SECONDS = 2
main.get_free_models = lambda session, force_refresh=False: []
main.limiter.enabled = False


async def fake_stream(message, history, model):
    yield "MOCK-REPLY"


main.gemini_chat_stream = fake_stream
main.openrouter_chat_stream = fake_stream

RESULTS: list[tuple[str, bool, str]] = []
CREATED: list[uuid.UUID] = []


def check(name: str, cond: bool, detail: str = ""):
    RESULTS.append((name, bool(cond), detail))
    print(f"PASS {name}" if cond else f"FAIL {name}: {detail}")


def run(fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        check(fn.__name__, False, f"exception: {e!r}")


def make_user() -> tuple[uuid.UUID, str]:
    with Session(engine) as s:
        u = User(oauth_provider="github", oauth_sub=f"limits-harness-{uuid.uuid4()}",
                 email="limits-harness@example.invalid")
        s.add(u)
        s.commit()
        s.refresh(u)
        uid = u.id
        token = auth_routes.create_session_token(s, u)
    CREATED.append(uid)
    return uid, token


def client_for(token: str) -> httpx.Client:
    return httpx.Client(base_url=BASE, timeout=60, cookies={"session": token})


def usage(uid) -> int:
    with Session(engine) as s:
        row = s.get(DailyUsage, (uid, main.taiwan_today()))
        return row.count if row else 0


def msg_count(uid) -> int:
    with Session(engine) as s:
        return len(s.exec(select(Message.id).where(Message.user_id == uid)).all())


def branch_count(uid) -> int:
    with Session(engine) as s:
        return len(s.exec(select(Branch.id).where(Branch.user_id == uid)).all())


def post_chat(c: httpx.Client, message: str, **extra):
    body = {"message": message, "model": MODEL, **extra}
    with c.stream("POST", "/chat", json=body) as r:
        raw = r.read().decode("utf-8")
        return r.status_code, r.headers, raw


def seed_chat(c: httpx.Client):
    st, h, raw = post_chat(c, "seed")
    assert st == 200, (st, raw[:100])
    return h.get("X-User-Message-Id"), h.get("X-Message-Id")


# ---------- 案例 ----------

def ta_chat_exact_limit():
    _, token = make_user()
    with client_for(token) as c:
        st, _, raw = post_chat(c, "a" * 20000)
        check("a /chat 20000 chars -> 200 and stream completes", st == 200 and raw == "MOCK-REPLY",
              f"{st} {raw[:80]}")


def tb_chat_over_limit():
    uid, token = make_user()
    with client_for(token) as c:
        m0, u0 = msg_count(uid), usage(uid)
        st, _, raw = post_chat(c, "a" * 20001)
        check("b /chat 20001 chars -> 422", st == 422, f"{st} {raw[:80]}")
        check("b no new messages, daily_usage unchanged", msg_count(uid) == m0 and usage(uid) == u0,
              f"msgs {m0}->{msg_count(uid)} usage {u0}->{usage(uid)}")
        st2, _, raw2 = post_chat(c, "ok", model="m" * 201)
        check("b /chat model 201 chars -> 422", st2 == 422, f"{st2} {raw2[:80]}")


def tc_regen_over_limit():
    uid, token = make_user()
    with client_for(token) as c:
        _, ai = seed_chat(c)
        m0, u0 = msg_count(uid), usage(uid)
        with c.stream("POST", f"/messages/{ai}/regenerate", json={"model": MODEL, "content": "a" * 20001}) as r:
            r.read()
            st = r.status_code
        check("c regenerate content 20001 -> 422", st == 422, str(st))
        check("c nothing changed", msg_count(uid) == m0 and usage(uid) == u0,
              f"msgs {m0}->{msg_count(uid)} usage {u0}->{usage(uid)}")


def td_title():
    _, token = make_user()
    with client_for(token) as c:
        root, _ = seed_chat(c)
        r1 = c.patch(f"/chats/{root}/title", json={"title": "t" * 200})
        check("d title 200 -> 200", r1.status_code == 200, f"{r1.status_code} {r1.text[:80]}")
        r2 = c.patch(f"/chats/{root}/title", json={"title": "t" * 201})
        check("d title 201 -> 422", r2.status_code == 422, f"{r2.status_code} {r2.text[:80]}")


def te_branch_anchor():
    uid, token = make_user()
    with client_for(token) as c:
        root, ai = seed_chat(c)
        r1 = c.post(f"/chats/{root}/branches", json={"anchor_message_id": ai, "anchor_text": "x" * 5000})
        check("e anchor_text 5000 -> 200", r1.status_code == 200, f"{r1.status_code} {r1.text[:80]}")
        n = branch_count(uid)
        r2 = c.post(f"/chats/{root}/branches", json={"anchor_message_id": ai, "anchor_text": "x" * 5001})
        check("e anchor_text 5001 -> 422", r2.status_code == 422, f"{r2.status_code} {r2.text[:80]}")
        check("e no branch created by 422", branch_count(uid) == n, f"{n}->{branch_count(uid)}")


def tf_relink_anchor():
    _, token = make_user()
    with client_for(token) as c:
        root, ai = seed_chat(c)
        r1 = c.post(f"/chats/{root}/branches", json={"anchor_message_id": ai, "anchor_text": "x"})
        bid = r1.json()["branch_id"]
        r2 = c.post(f"/branches/{bid}/relink", json={"root_id": root, "anchor_message_id": ai,
                                                     "anchor_start": 0, "anchor_end": 1,
                                                     "anchor_text": "x" * 5001})
        check("f relink anchor_text 5001 -> 422", r2.status_code == 422, f"{r2.status_code} {r2.text[:80]}")


def tg_branch_rate_limit():
    _, ta = make_user()
    _, tb = make_user()
    with client_for(ta) as ca, client_for(tb) as cb:
        ra, aa = seed_chat(ca)
        rb, ab = seed_chat(cb)
        main.limiter.reset()
        main.limiter.enabled = True
        try:
            sts = [ca.post(f"/chats/{ra}/branches", json={"anchor_message_id": aa, "anchor_text": "x"}).status_code
                   for _ in range(31)]
            check("g first 30 create-branch -> 200", sts[:30] == [200] * 30, str(sts))
            check("g 31st -> 429", sts[30] == 429, str(sts))
            rB = cb.post(f"/chats/{rb}/branches", json={"anchor_message_id": ab, "anchor_text": "x"})
            check("g user B right after -> 200", rB.status_code == 200, f"{rB.status_code} {rB.text[:80]}")
        finally:
            main.limiter.enabled = False
            main.limiter.reset()


def th_title_rate_limit():
    _, token = make_user()
    with client_for(token) as c:
        root, _ = seed_chat(c)
        main.limiter.reset()
        main.limiter.enabled = True
        try:
            sts = [c.patch(f"/chats/{root}/title", json={"title": f"t{i}"}).status_code for i in range(31)]
            check("h first 30 PATCH title -> 200", sts[:30] == [200] * 30, str(sts))
            check("h 31st -> 429", sts[30] == 429, str(sts))
        finally:
            main.limiter.enabled = False
            main.limiter.reset()


# ---------- 伺服器與清理 ----------

def start_server() -> uvicorn.Server:
    config = uvicorn.Config(main.app, host="127.0.0.1", port=PORT, log_level="warning")
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
        print(f"cleanup: removed user {uid}")
    except Exception as e:  # noqa: BLE001
        print(f"cleanup FAILED for {uid}: {e}")


def main_entry() -> int:
    server = None
    try:
        server = start_server()
        for fn in [ta_chat_exact_limit, tb_chat_over_limit, tc_regen_over_limit, td_title,
                   te_branch_anchor, tf_relink_anchor, tg_branch_rate_limit, th_title_rate_limit]:
            run(fn)
    except Exception as e:  # noqa: BLE001
        check("harness setup", False, f"exception: {e!r}")
    finally:
        if server is not None:
            server.should_exit = True
        for uid in CREATED:
            cleanup(uid)

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
