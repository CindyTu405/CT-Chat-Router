"""(G6-1) 重新生成端點（POST /messages/{id}/regenerate）的測試腳本。

用法：cd backend && uv run python dev/regenerate_harness.py

做的事：
- 連 docker chat_db（沿用 database.py 的設定），建立測試用 User + AuthSession（Cookie: session=<token>），
  所有測試資料都寫 user_id，結束時只清掉本腳本建立的 user／auth_session／分支／訊息。
- 把 main.gemini_chat_stream / main.openrouter_chat_stream 換成假串流（絕不呼叫真模型）。
- 把 main.get_free_models 換成空清單，避免白名單檢查去打 OpenRouter 的模型清單。
- 在 127.0.0.1:8765 起真的 uvicorn（背景 thread），用 HTTP 打 API。
- BUFFER_RETENTION_SECONDS 調短為 2 秒，讓「緩衝清除競態」可以在測試時間內驗證。
"""
import asyncio
import os
import sys
import threading
import time
import uuid
from collections import deque

# (V1-2) 每日額度改為很大的值：這些案例要測的不是額度，避免大量請求撞到每日上限。
os.environ["DAILY_MESSAGE_LIMIT"] = "100000"
os.environ["SITE_DAILY_MESSAGE_LIMIT"] = "1000000"
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

import main  # noqa: E402
from database import engine  # noqa: E402
import auth_routes  # noqa: E402
from models import AuthSession, Branch, Message, User  # noqa: E402

# database.py 的 echo=True 會印出每一句 SQL，這個腳本只要看測試結果，關掉它（只影響本腳本）。
engine.echo = False

PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"
RETENTION = 2

# (G6-1) 調短保留時間，讓競態測試在幾秒內完成
main.BUFFER_RETENTION_SECONDS = RETENTION
# (G6-1) 不讓白名單檢查去抓 OpenRouter 免費模型清單（外部網路）；環境變數白名單仍照常生效
main.get_free_models = lambda session, force_refresh=False: []

FAST_CHUNKS = ["MOCK-REGEN-", "1 ", "done"]        # 合起來 "MOCK-REGEN-1 done"
SLOW_CHUNKS = [f"SLOW-{i} " for i in range(10)]     # 10 × 0.5 秒 ≈ 5 秒，用來測「生成中」
FAST_TEXT = "".join(FAST_CHUNKS)
SLOW_TEXT = "".join(SLOW_CHUNKS)

# 每次假串流開始時從這個佇列取一個模式（"fast" / "slow"），佇列空則 fast。
# 比起全域開關，這樣每個請求拿到的模式是確定的，不會因為 thread 切換而錯亂。
MODE_QUEUE: deque = deque()

# (F9-1) 記錄每次假串流收到的 user 訊息（message 參數），用來驗證編輯後生成用的是新內容
LLM_MESSAGES: list = []


async def fake_stream(message, history, model):
    """假的 LLM 串流：只 yield 固定文字，不連任何外部服務。"""
    LLM_MESSAGES.append(message)
    mode = MODE_QUEUE.popleft() if MODE_QUEUE else "fast"
    if mode == "slow":
        for chunk in SLOW_CHUNKS:
            await asyncio.sleep(0.5)
            yield chunk
    else:
        for chunk in FAST_CHUNKS:
            await asyncio.sleep(0.05)
            yield chunk


main.gemini_chat_stream = fake_stream
main.openrouter_chat_stream = fake_stream

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = ""):
    RESULTS.append((name, bool(cond), detail))
    if cond:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name}: {detail}")


def db_row(msg_id: uuid.UUID) -> dict:
    with Session(engine) as s:
        m = s.get(Message, msg_id)
        return {
            "content": m.content,
            "model_used": m.model_used,
            "parent_id": m.parent_id,
            "anchor_message_id": m.anchor_message_id,
            "branch_id": m.branch_id,
        }


def db_branch(branch_id: uuid.UUID) -> dict:
    with Session(engine) as s:
        b = s.get(Branch, branch_id)
        return {
            "is_orphaned": b.is_orphaned,
            "anchor_message_id": b.anchor_message_id,
            "anchor_start": b.anchor_start,
            "anchor_end": b.anchor_end,
            "anchor_text": b.anchor_text,
            "title": b.title,
        }


def regen_full(client: httpx.Client, msg_id, model: str, content: str | None = None):
    """送出重新生成並把整個 body 讀完，回傳 (status, headers, text)。
    (F9-1) content 有給才放進 body（不給 = 純重傳，與 G6 測試一模一樣）。"""
    body_json = {"model": model}
    if content is not None:
        body_json["content"] = content
    with client.stream("POST", f"/messages/{msg_id}/regenerate", json=body_json) as r:
        body = r.read().decode("utf-8")
        return r.status_code, r.headers, body


def reset_limiter():
    # (G6-1) regenerate 每分鐘 10 次／IP；每個測試前重設計數，避免測試本身被限流
    main.limiter.reset()


def seed(uid: uuid.UUID) -> dict:
    """建立：主線 root user → 主線 AI；錨在主線 AI 上的分支（root user + AI reply）。"""
    with Session(engine) as s:
        root = Message(role="user", content="G6 harness root question", parent_id=None,
                       user_id=uid, title="G6 harness")
        s.add(root)
        s.commit()
        s.refresh(root)

        ai = Message(role="assistant", content="ORIGINAL main reply", parent_id=root.id,
                     user_id=uid, model_used="gemini-2.5-flash")
        s.add(ai)
        s.commit()
        s.refresh(ai)

        branch = Branch(anchor_message_id=ai.id, anchor_text="ORIGINAL", anchor_start=0,
                        anchor_end=8, title="G6 harness branch", user_id=uid)
        s.add(branch)
        s.flush()

        b_root = Message(role="user", content="branch question", parent_id=ai.id,
                         branch_id=branch.id, anchor_message_id=ai.id, user_id=uid)
        s.add(b_root)
        s.flush()
        branch.root_message_id = b_root.id
        s.add(branch)

        b_ai = Message(role="assistant", content="branch answer", parent_id=b_root.id,
                       branch_id=branch.id, user_id=uid, model_used="gemini-2.5-flash")
        s.add(b_ai)
        s.commit()
        s.refresh(branch)
        s.refresh(b_ai)
        return {
            "root_id": root.id,
            "ai_id": ai.id,
            "branch_id": branch.id,
            "b_root_id": b_root.id,
            "b_ai_id": b_ai.id,
        }


def make_user() -> tuple[uuid.UUID, str]:
    """直接建立測試 User + AuthSession，回傳 (user_id, 原始 token)。"""
    with Session(engine) as s:
        u = User(oauth_provider="github", oauth_sub=f"regen-harness-{uuid.uuid4()}",
                 email="regen-harness@example.invalid")
        s.add(u)
        s.commit()
        s.refresh(u)
        token = auth_routes.create_session_token(s, u)
        return u.id, token


def cleanup(uid: uuid.UUID):
    """清掉測試資料（只動這個測試 user 的列）。
    順序：先斷開 branch 指向訊息的 FK → 斷開訊息之間的 FK → 刪訊息 → 刪分支 → 刪 auth_session → 刪 user。
    分支由 user_id 與這個 user 的訊息反查（即使 seed 只做到一半也能清乾淨）。"""
    try:
        with Session(engine) as s:
            branch_ids = {m.branch_id for m in s.exec(select(Message).where(Message.user_id == uid)).all() if m.branch_id}
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
            for a in s.exec(select(AuthSession).where(AuthSession.user_id == uid)).all():
                s.delete(a)
            s.commit()
            u = s.get(User, uid)
            if u is not None:
                s.delete(u)
            s.commit()
        print(f"cleanup: removed user {uid}")
    except Exception as e:  # 清理失敗要看得到，但不蓋掉測試結果
        print(f"cleanup FAILED for {uid}: {e}")


def run_tests(client: httpx.Client, ids: dict, uid: uuid.UUID):
    ai_id = ids["ai_id"]
    root_id = ids["root_id"]
    branch_id = ids["branch_id"]
    b_root_id = ids["b_root_id"]
    b_ai_id = ids["b_ai_id"]

    model = next(
        (m for m in ["gemini-2.5-flash-lite", "gemini-2.5-flash"] if main.is_model_allowed(m)),
        None,
    )
    check("setup: an allowed gemini model exists", model is not None, "no allowed model")
    if model is None:
        return

    # ---- 1. 主線 AI 重新生成 ----
    reset_limiter()
    try:
        status, headers1, body1 = regen_full(client, ai_id, model)
        check("1 regen main AI: 200", status == 200, f"status={status} body={body1[:200]}")
        check("1 regen main AI: streamed body == mock text", body1 == FAST_TEXT,
              f"body={body1!r}")
        row = db_row(ai_id)
        check("1 regen main AI: DB content == mock text", row["content"] == FAST_TEXT,
              f"content={row['content']!r}")
        check("1 regen main AI: model_used updated", row["model_used"] == model,
              f"model_used={row['model_used']!r}")
    except Exception as e:
        check("1 regen main AI", False, f"exception: {e!r}")
        headers1 = {}

    # ---- 2. 錨定分支被幽靈化 ----
    try:
        br = db_branch(branch_id)
        check("2 branch ghosted: is_orphaned true", br["is_orphaned"] is True,
              f"is_orphaned={br['is_orphaned']}")
        check("2 branch ghosted: anchor_message_id/start/end NULL",
              br["anchor_message_id"] is None and br["anchor_start"] is None and br["anchor_end"] is None,
              f"anchor={br['anchor_message_id']} start={br['anchor_start']} end={br['anchor_end']}")
        check("2 branch ghosted: anchor_text and title kept",
              br["anchor_text"] == "ORIGINAL" and br["title"] == "G6 harness branch",
              f"anchor_text={br['anchor_text']!r} title={br['title']!r}")
        bm = db_row(b_root_id)
        check("2 branch root: parent_id and anchor_message_id NULL",
              bm["parent_id"] is None and bm["anchor_message_id"] is None,
              f"parent={bm['parent_id']} anchor={bm['anchor_message_id']}")
        check("2 X-Orphaned-Branch-Ids header contains branch id",
              str(branch_id) in headers1.get("x-orphaned-branch-ids", ""),
              f"header={headers1.get('x-orphaned-branch-ids')!r}")
    except Exception as e:
        check("2 branch ghosting", False, f"exception: {e!r}")

    # ---- 3. 側邊欄 roots 不含幽靈分支的 root ----
    for sort_by in ["created", "updated"]:
        reset_limiter()
        try:
            r = client.get("/chats/roots", params={"sort_by": sort_by})
            ids_in = [item["id"] for item in r.json()] if r.status_code == 200 else []
            check(f"3 /chats/roots sort_by={sort_by}: contains main root",
                  str(root_id) in ids_in, f"status={r.status_code} ids={ids_in}")
            check(f"3 /chats/roots sort_by={sort_by}: excludes ghost branch root",
                  str(b_root_id) not in ids_in, f"ids={ids_in}")
        except Exception as e:
            check(f"3 /chats/roots sort_by={sort_by}", False, f"exception: {e!r}")

    # ---- 4. 主線還有後續訊息 → 409 ----
    child_id = None
    try:
        with Session(engine) as s:
            child = Message(role="user", content="main-line follow-up", parent_id=ai_id,
                            user_id=uid, branch_id=None)
            s.add(child)
            s.commit()
            s.refresh(child)
            child_id = child.id
        reset_limiter()
        status, _, body = regen_full(client, ai_id, model)
        check("4 not last message (main-line child) → 409", status == 409,
              f"status={status} body={body[:200]}")
    except Exception as e:
        check("4 not last message", False, f"exception: {e!r}")
    finally:
        if child_id is not None:
            with Session(engine) as s:
                c = s.get(Message, child_id)
                if c:
                    s.delete(c)
                    s.commit()

    # ---- 5. 生成中再按 → 409（慢速模式）----
    try:
        MODE_QUEUE.append("slow")
        reset_limiter()
        cm = client.stream("POST", f"/messages/{ai_id}/regenerate", json={"model": model})
        r1 = cm.__enter__()
        try:
            check("5 slow regen starts: 200", r1.status_code == 200, f"status={r1.status_code}")
            reset_limiter()
            status2, _, body2 = regen_full(client, ai_id, model)
            check("5 regen while still generating → 409", status2 == 409,
                  f"status={status2} body={body2[:200]}")
            r1.read()  # 把第一次的串流讀完，讓生成結束
        finally:
            cm.__exit__(None, None, None)
    except Exception as e:
        check("5 still generating", False, f"exception: {e!r}")

    # ---- 6. 非 AI 訊息／隨機 uuid → 404 ----
    reset_limiter()
    try:
        status, _, _ = regen_full(client, root_id, model)
        check("6 non-assistant message → 404", status == 404, f"status={status}")
        reset_limiter()
        status, _, _ = regen_full(client, uuid.uuid4(), model)
        check("6 random uuid → 404", status == 404, f"status={status}")
    except Exception as e:
        check("6 404 cases", False, f"exception: {e!r}")

    # ---- 7. 不在白名單 → 403，且 DB 不變 ----
    try:
        before = db_row(ai_id)
        reset_limiter()
        status, _, body = regen_full(client, ai_id, "not-a-real/model")
        after = db_row(ai_id)
        check("7 disallowed model → 403", status == 403, f"status={status} body={body[:200]}")
        check("7 disallowed model: DB unchanged", before == after,
              f"before={before} after={after}")
    except Exception as e:
        check("7 disallowed model", False, f"exception: {e!r}")

    # ---- 8. 緩衝競態：第一次的清除不能清掉第二次的緩衝 ----
    try:
        reset_limiter()
        status1, _, body1 = regen_full(client, ai_id, model)  # fast，完成後開始 RETENTION 秒的倒數
        t_read_end = time.time()
        check("8 regen #1 finished", status1 == 200 and body1 == FAST_TEXT,
              f"status={status1} body={body1!r}")

        MODE_QUEUE.append("slow")
        reset_limiter()
        cm2 = client.stream("POST", f"/messages/{ai_id}/regenerate", json={"model": model})
        r2 = cm2.__enter__()
        try:
            check("8 regen #2 started within retention", r2.status_code == 200,
                  f"status={r2.status_code}")
            # 等超過 regen #1 的保留時間（它的清除動作此時已經跑過）
            wait = (t_read_end + RETENTION + 1.0) - time.time()
            if wait > 0:
                time.sleep(wait)
            buf = main.GENERATIONS.get(str(ai_id))
            check("8 buffer of regen #2 survives regen #1's retention",
                  buf is not None and not buf["done"] and len(buf["text"]) > 0,
                  f"buf={'missing' if buf is None else {'done': buf['done'], 'len': len(buf['text'])}}")
            # 續讀端點從 offset 0 讀，應該拿到 regen #2 的完整內容
            with client.stream("GET", f"/messages/{ai_id}/stream", params={"offset": 0}) as rs:
                resume_body = rs.read().decode("utf-8")
            check("8 stream of regen #2 reaches the end", resume_body == SLOW_TEXT,
                  f"len={len(resume_body)} body={resume_body[:120]!r}")
        finally:
            cm2.__exit__(None, None, None)
    except Exception as e:
        check("8 buffer race", False, f"exception: {e!r}")

    # ---- 9. 分支自己的 AI 回覆（分支線最後一則）可以重新生成 ----
    try:
        reset_limiter()
        status, _, body = regen_full(client, b_ai_id, model)
        check("9 branch's own AI reply regen → 200", status == 200,
              f"status={status} body={body[:200]}")
        check("9 branch's own AI reply: body == mock text", body == FAST_TEXT,
              f"body={body!r}")
    except Exception as e:
        check("9 branch AI regen", False, f"exception: {e!r}")

    # ---- 10. (F9-1) 帶 content 的編輯 ----
    run_f9_tests(client, uid, model)


def seed_f9_pair(uid: uuid.UUID, tag: str, with_branch: bool = False) -> dict:
    """(F9-1) 建立獨立的一組「user → AI」（最後一則）；with_branch 時再錨一個分支在 AI 上。"""
    with Session(engine) as s:
        root = Message(role="user", content=f"{tag} question", parent_id=None,
                       user_id=uid, title="F9 harness")
        s.add(root)
        s.commit()
        s.refresh(root)

        ai = Message(role="assistant", content=f"{tag} old answer", parent_id=root.id,
                     user_id=uid, model_used="gemini-2.5-flash")
        s.add(ai)
        s.commit()
        s.refresh(ai)

        out = {"root_id": root.id, "ai_id": ai.id, "branch_id": None, "b_root_id": None}
        if with_branch:
            branch = Branch(anchor_message_id=ai.id, anchor_text="OLD", anchor_start=0,
                            anchor_end=3, title="F9 harness branch", user_id=uid)
            s.add(branch)
            s.flush()
            b_root = Message(role="user", content=f"{tag} branch question", parent_id=ai.id,
                             branch_id=branch.id, anchor_message_id=ai.id, user_id=uid)
            s.add(b_root)
            s.flush()
            branch.root_message_id = b_root.id
            s.add(branch)
            s.commit()
            s.refresh(branch)
            s.refresh(b_root)
            out["branch_id"] = branch.id
            out["b_root_id"] = b_root.id
        return out


def run_f9_tests(client: httpx.Client, uid: uuid.UUID, model: str):
    # ---- 10a/10b. 帶 content → 200；user／AI 內容與模型都更新；生成用的是新內容 ----
    p1 = seed_f9_pair(uid, "F9A")
    try:
        reset_limiter()
        LLM_MESSAGES.clear()
        status, _, body = regen_full(client, p1["ai_id"], model, content="新問題")
        check("10a edit regen: 200", status == 200, f"status={status} body={body[:200]}")
        row_u = db_row(p1["root_id"])
        row_a = db_row(p1["ai_id"])
        check("10a edit: DB user content == new content", row_u["content"] == "新問題",
              f"content={row_u['content']!r}")
        check("10a edit: DB AI content == mock text", row_a["content"] == FAST_TEXT,
              f"content={row_a['content']!r}")
        check("10a edit: model_used updated", row_a["model_used"] == model,
              f"model_used={row_a['model_used']!r}")
        check("10a edit: streamed body == mock text", body == FAST_TEXT, f"body={body!r}")
        check("10b edit: LLM received the new content", LLM_MESSAGES == ["新問題"],
              f"LLM_MESSAGES={LLM_MESSAGES!r}")
    except Exception as e:
        check("10a/10b edit regen", False, f"exception: {e!r}")

    # ---- 10c. 編輯時錨在 AI 上的分支照樣幽靈化（與 G6 測試相同的檢查） ----
    p2 = seed_f9_pair(uid, "F9C", with_branch=True)
    try:
        reset_limiter()
        status, headers, body = regen_full(client, p2["ai_id"], model, content="分支前的新問題")
        check("10c edit with anchored branch: 200", status == 200,
              f"status={status} body={body[:200]}")
        check("10c edit with anchored branch: user content == new",
              db_row(p2["root_id"])["content"] == "分支前的新問題",
              f"content={db_row(p2['root_id'])['content']!r}")
        br = db_branch(p2["branch_id"])
        check("10c branch ghosted: is_orphaned true", br["is_orphaned"] is True,
              f"is_orphaned={br['is_orphaned']}")
        check("10c branch ghosted: anchor_message_id/start/end NULL",
              br["anchor_message_id"] is None and br["anchor_start"] is None and br["anchor_end"] is None,
              f"anchor={br['anchor_message_id']} start={br['anchor_start']} end={br['anchor_end']}")
        check("10c branch ghosted: anchor_text and title kept",
              br["anchor_text"] == "OLD" and br["title"] == "F9 harness branch",
              f"anchor_text={br['anchor_text']!r} title={br['title']!r}")
        bm = db_row(p2["b_root_id"])
        check("10c branch root: parent_id and anchor_message_id NULL",
              bm["parent_id"] is None and bm["anchor_message_id"] is None,
              f"parent={bm['parent_id']} anchor={bm['anchor_message_id']}")
        check("10c X-Orphaned-Branch-Ids header contains branch id",
              str(p2["branch_id"]) in headers.get("x-orphaned-branch-ids", ""),
              f"header={headers.get('x-orphaned-branch-ids')!r}")
    except Exception as e:
        check("10c edit with anchored branch", False, f"exception: {e!r}")

    # ---- 10d. content 全是空白 → 422，DB 與 LLM 都不動 ----
    p3 = seed_f9_pair(uid, "F9D")
    try:
        before_u = db_row(p3["root_id"])
        before_a = db_row(p3["ai_id"])
        LLM_MESSAGES.clear()
        reset_limiter()
        status, _, body = regen_full(client, p3["ai_id"], model, content="   ")
        check("10d whitespace content → 422", status == 422, f"status={status} body={body[:200]}")
        check("10d whitespace content: user row unchanged", db_row(p3["root_id"]) == before_u,
              f"before={before_u} after={db_row(p3['root_id'])}")
        check("10d whitespace content: AI row unchanged", db_row(p3["ai_id"]) == before_a,
              f"before={before_a} after={db_row(p3['ai_id'])}")
        check("10d whitespace content: LLM not called", LLM_MESSAGES == [],
              f"LLM_MESSAGES={LLM_MESSAGES!r}")
    except Exception as e:
        check("10d whitespace content", False, f"exception: {e!r}")

    # ---- 10e. 不是最後一則（有後續訊息）→ 409，user 內容不得被改 ----
    p4 = seed_f9_pair(uid, "F9E")
    try:
        with Session(engine) as s:
            s.add(Message(role="user", content="F9E follow-up", parent_id=p4["ai_id"],
                          user_id=uid, branch_id=None))
            s.commit()
        before_u = db_row(p4["root_id"])
        before_a = db_row(p4["ai_id"])
        reset_limiter()
        status, _, body = regen_full(client, p4["ai_id"], model, content="不該寫入")
        check("10e edit on non-last message → 409", status == 409,
              f"status={status} body={body[:200]}")
        check("10e edit on non-last message: user content unchanged",
              db_row(p4["root_id"]) == before_u,
              f"before={before_u} after={db_row(p4['root_id'])}")
        check("10e edit on non-last message: AI row unchanged", db_row(p4["ai_id"]) == before_a,
              f"before={before_a} after={db_row(p4['ai_id'])}")
    except Exception as e:
        check("10e edit on non-last message", False, f"exception: {e!r}")


def start_server() -> uvicorn.Server:
    config = uvicorn.Config(main.app, host="127.0.0.1", port=PORT, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError("uvicorn did not start on 127.0.0.1:8765")
    return server


def main_entry() -> int:
    server = None
    ids = None
    uid = None
    try:
        uid, token = make_user()
        ids = seed(uid)
        server = start_server()
        with httpx.Client(base_url=BASE, timeout=30, cookies={"session": token}) as client:
            run_tests(client, ids, uid)
    except Exception as e:
        check("harness setup", False, f"exception: {e!r}")
    finally:
        if server is not None:
            server.should_exit = True
        if uid is not None:
            cleanup(uid)

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = [(n, d) for n, ok, d in RESULTS if not ok]
    print(f"--- {passed} PASS, {len(failed)} FAIL ---")
    if failed or passed == 0:
        print("SOME FAIL")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main_entry())
