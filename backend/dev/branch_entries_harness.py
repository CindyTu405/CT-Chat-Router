"""(E1/E2) 分支入口、重疊降級、分支列表與幽靈重連的測試腳本。

用法：cd backend && uv run python dev/branch_entries_harness.py

做的事：
- 連 docker chat_db（沿用 database.py 的設定），用唯一的 session_id 建測試資料，結束時清掉。
- 把 main.get_free_models 換成空清單，避免白名單檢查去打 OpenRouter 的模型清單。
- 在 127.0.0.1:8766 起真的 uvicorn（背景 thread），用 HTTP 打 API。
- E1 涵蓋：建立分支的重疊降級、範圍相同重用、offset 驗證（422 且不寫入）、回傳欄位。
"""
import os
import sys
import threading
import time
import uuid

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

import main  # noqa: E402
from database import engine  # noqa: E402
from models import Branch, Message  # noqa: E402

# database.py 的 echo=True 會印出每一句 SQL，這個腳本只要看測試結果，關掉它（只影響本腳本）。
engine.echo = False

PORT = 8766
BASE = f"http://127.0.0.1:{PORT}"

# 不讓白名單檢查去抓 OpenRouter 免費模型清單（外部網路）
main.get_free_models = lambda session, force_refresh=False: []

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = ""):
    RESULTS.append((name, bool(cond), detail))
    if cond:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name}: {detail}")


def db_branch(branch_id) -> dict:
    with Session(engine) as s:
        b = s.get(Branch, uuid.UUID(str(branch_id)))
        return {
            "is_orphaned": b.is_orphaned,
            "anchor_message_id": b.anchor_message_id,
            "anchor_start": b.anchor_start,
            "anchor_end": b.anchor_end,
            "anchor_text": b.anchor_text,
            "title": b.title,
            "root_message_id": b.root_message_id,
            "attach_root_id": b.attach_root_id,
        }


def count_branches(anchor_id) -> int:
    with Session(engine) as s:
        return len(s.exec(select(Branch).where(Branch.anchor_message_id == anchor_id)).all())


def create(client: httpx.Client, root_id, anchor_id, text: str, start=None, end=None):
    body = {"anchor_message_id": str(anchor_id), "anchor_text": text}
    if start is not None:
        body["anchor_start"] = start
    if end is not None:
        body["anchor_end"] = end
    return client.post(f"/chats/{root_id}/branches", json=body)


def seed(sid: str) -> dict:
    """root user → 三則 AI 兄弟（各 40 字）。ai 用來測重疊，ai2 用來測「不同則同 offset」，ai3 用來測雙重疊。"""
    with Session(engine) as s:
        root = Message(role="user", content="E1 harness root question", parent_id=None,
                       session_id=sid, title="E1 harness")
        s.add(root)
        s.commit()
        s.refresh(root)
        ais = []
        for tag in ["0123456789" * 4, "ABCDEFGHIJ" * 4, "abcdefghij" * 4]:
            a = Message(role="assistant", content=tag, parent_id=root.id,
                        session_id=sid, model_used="gemini-2.5-flash")
            s.add(a)
            s.commit()
            s.refresh(a)
            ais.append(a)
        return {"root_id": root.id, "ai_id": ais[0].id, "ai2_id": ais[1].id, "ai3_id": ais[2].id}


def run_e1_tests(client: httpx.Client, ids: dict):
    root_id, ai, ai2, ai3 = ids["root_id"], ids["ai_id"], ids["ai2_id"], ids["ai3_id"]

    # ---- E1-a. 無重疊 → reused=false、demoted_ids=[]；回傳含 title/reused/demoted_ids ----
    try:
        r = create(client, root_id, ai, "B1 text", 0, 5)
        j = r.json()
        check("E1-a no overlap: 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
        check("E1-a no overlap: reused=false, demoted_ids=[]",
              j.get("reused") is False and j.get("demoted_ids") == [],
              f"reused={j.get('reused')} demoted={j.get('demoted_ids')}")
        check("E1-a response has title", j.get("title") == "B1 text", f"title={j.get('title')!r}")
        check("E1-a precise true", j.get("precise") is True, f"precise={j.get('precise')}")
        b1 = j["branch_id"]
    except Exception as e:
        check("E1-a no overlap", False, f"exception: {e!r}")
        return

    # ---- E1-b. 部分重疊 → 舊的降級（start/end NULL，其他欄位不變），新的有 offset ----
    try:
        r = create(client, root_id, ai, "B2 text", 3, 8)
        j = r.json()
        check("E1-b partial overlap: 200 and reused=false", r.status_code == 200 and j["reused"] is False,
              f"status={r.status_code} body={r.text[:200]}")
        check("E1-b partial overlap: demoted_ids contains old id", b1 in j.get("demoted_ids", []),
              f"demoted={j.get('demoted_ids')}")
        b2 = j["branch_id"]
        old = db_branch(b1)
        check("E1-b old: start/end NULL, anchor/text/title kept",
              old["anchor_start"] is None and old["anchor_end"] is None
              and old["anchor_message_id"] == ai and old["anchor_text"] == "B1 text"
              and old["title"] == "B1 text",
              f"old={old}")
        new = db_branch(b2)
        check("E1-b new: offsets 3..8", new["anchor_start"] == 3 and new["anchor_end"] == 8,
              f"new={new}")
    except Exception as e:
        check("E1-b partial overlap", False, f"exception: {e!r}")
        b2 = None

    # ---- E1-c. 相鄰（舊.end == 新.start）→ 不降級 ----
    try:
        r = create(client, root_id, ai, "B3 adjacent", 8, 12)
        j = r.json()
        check("E1-c adjacent: demoted_ids=[]", r.status_code == 200 and j.get("demoted_ids") == [],
              f"status={r.status_code} demoted={j.get('demoted_ids')}")
        if b2:
            check("E1-c adjacent: B2 still inline", db_branch(b2)["anchor_start"] == 3,
                  f"b2={db_branch(b2)}")
    except Exception as e:
        check("E1-c adjacent", False, f"exception: {e!r}")

    # ---- E1-d. 範圍完全相同 → reused=true、回傳既有 id、branch 筆數不變 ----
    try:
        before = count_branches(ai)
        r = create(client, root_id, ai, "B2 text", 3, 8)
        j = r.json()
        check("E1-d identical range: reused=true", r.status_code == 200 and j.get("reused") is True,
              f"status={r.status_code} body={r.text[:200]}")
        check("E1-d identical range: branch_id == existing", b2 is not None and j.get("branch_id") == b2,
              f"got={j.get('branch_id')} expected={b2}")
        check("E1-d identical range: demoted_ids=[] and title is existing title",
              j.get("demoted_ids") == [] and j.get("title") == "B2 text",
              f"demoted={j.get('demoted_ids')} title={j.get('title')!r}")
        check("E1-d identical range: branch count unchanged", count_branches(ai) == before,
              f"before={before} after={count_branches(ai)}")
    except Exception as e:
        check("E1-d identical range", False, f"exception: {e!r}")

    # ---- E1-e. 不同則訊息、同樣 offset → 不降級（ai2 上沒有其他分支）----
    try:
        r = create(client, root_id, ai2, "other msg", 3, 8)
        j = r.json()
        check("E1-e other message same offset: demoted_ids=[]", r.status_code == 200 and j.get("demoted_ids") == [],
              f"status={r.status_code} demoted={j.get('demoted_ids')}")
        if b2:
            check("E1-e other message: B2 still inline", db_branch(b2)["anchor_start"] == 3,
                  f"b2={db_branch(b2)}")
    except Exception as e:
        check("E1-e other message", False, f"exception: {e!r}")

    # ---- E1-f. 同時重疊兩個 → 兩個都降級 ----
    try:
        ra = create(client, root_id, ai3, "D1", 0, 5).json()
        rb = create(client, root_id, ai3, "D2", 10, 15).json()
        r = create(client, root_id, ai3, "D3 covers both", 3, 12)
        j = r.json()
        check("E1-f double overlap: both demoted",
              set(j.get("demoted_ids", [])) == {ra["branch_id"], rb["branch_id"]},
              f"status={r.status_code} demoted={j.get('demoted_ids')} expected={[ra['branch_id'], rb['branch_id']]}")
        check("E1-f double overlap: both now NULL offsets",
              db_branch(ra["branch_id"])["anchor_start"] is None and db_branch(rb["branch_id"])["anchor_start"] is None,
              "")
    except Exception as e:
        check("E1-f double overlap", False, f"exception: {e!r}")

    # ---- E1-g. 不帶 offset → 不降級任何分支，成為底部入口 ----
    try:
        before_b2 = db_branch(b2) if b2 else None
        r = create(client, root_id, ai, "no offset entry")
        j = r.json()
        check("E1-g no offset: demoted_ids=[] and precise false",
              r.status_code == 200 and j.get("demoted_ids") == [] and j.get("precise") is False,
              f"status={r.status_code} body={r.text[:200]}")
        if b2:
            check("E1-g no offset: B2 unchanged", db_branch(b2) == before_b2,
                  f"before={before_b2} after={db_branch(b2)}")
    except Exception as e:
        check("E1-g no offset", False, f"exception: {e!r}")

    # ---- E1-h. offset 驗證：只給 start／start>=end／end 超過長度／負數 → 422 且不寫入 ----
    bad_cases = [
        ("only start", {"anchor_start": 4}),
        ("only end", {"anchor_end": 4}),
        ("start == end", {"anchor_start": 5, "anchor_end": 5}),
        ("start > end", {"anchor_start": 6, "anchor_end": 2}),
        ("end beyond content", {"anchor_start": 4, "anchor_end": 41}),
        ("negative start", {"anchor_start": -1, "anchor_end": 3}),
    ]
    for label, extra in bad_cases:
        try:
            before_count = count_branches(ai)
            before_b2 = db_branch(b2) if b2 else None
            body = {"anchor_message_id": str(ai), "anchor_text": "bad"}
            body.update(extra)
            r = client.post(f"/chats/{root_id}/branches", json=body)
            check(f"E1-h {label}: 422", r.status_code == 422, f"status={r.status_code} body={r.text[:200]}")
            check(f"E1-h {label}: no write", count_branches(ai) == before_count
                  and (b2 is None or db_branch(b2) == before_b2),
                  f"count {before_count}->{count_branches(ai)}")
        except Exception as e:
            check(f"E1-h {label}", False, f"exception: {e!r}")

    # ---- E1-i. GET /chats/{root}/branches：被降級者 precise=false ----
    try:
        r = client.get(f"/chats/{root_id}/branches")
        items = {it["id"]: it for it in r.json()} if r.status_code == 200 else {}
        check("E1-i list: demoted B1 has precise=false",
              b1 in items and items[b1]["precise"] is False and items[b1]["anchor_start"] is None,
              f"status={r.status_code} item={items.get(b1)}")
        check("E1-i list: B2 has precise=true",
              b2 is not None and b2 in items and items[b2]["precise"] is True,
              f"item={items.get(b2)}")
    except Exception as e:
        check("E1-i list", False, f"exception: {e!r}")


def cleanup(sid: str):
    """清掉測試資料。順序：先斷開 branch 指向訊息的 FK → 斷開訊息之間的 FK → 刪訊息 → 刪分支。
    分支由這個 session 的訊息（branch_id／anchor）與 attach_root_id 反查。"""
    try:
        with Session(engine) as s:
            msgs = s.exec(select(Message).where(Message.session_id == sid)).all()
            msg_ids = [m.id for m in msgs]
            branch_ids = {m.branch_id for m in msgs if m.branch_id}
            if msg_ids:
                branch_ids |= set(s.exec(select(Branch.id).where(
                    Branch.anchor_message_id.in_(msg_ids)
                    | Branch.root_message_id.in_(msg_ids)
                    | Branch.attach_root_id.in_(msg_ids)
                )).all())
        with Session(engine) as s:
            for b in s.exec(select(Branch).where(Branch.id.in_(branch_ids))).all() if branch_ids else []:
                b.root_message_id = None
                b.anchor_message_id = None
                b.attach_root_id = None
                b.parent_branch_id = None
                s.add(b)
            s.commit()
        with Session(engine) as s:
            for m in s.exec(select(Message).where(Message.session_id == sid)).all():
                m.parent_id = None
                m.branch_id = None
                m.anchor_message_id = None
                s.add(m)
            s.commit()
        with Session(engine) as s:
            for m in s.exec(select(Message).where(Message.session_id == sid)).all():
                s.delete(m)
            s.commit()
        with Session(engine) as s:
            for b in s.exec(select(Branch).where(Branch.id.in_(branch_ids))).all() if branch_ids else []:
                s.delete(b)
            s.commit()
        print(f"cleanup: removed session {sid}")
    except Exception as e:  # 清理失敗要看得到，但不蓋掉測試結果
        print(f"cleanup FAILED for {sid}: {e}")


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


def main_entry() -> int:
    sid = f"e-harness-{uuid.uuid4()}"
    server = None
    try:
        ids = seed(sid)
        server = start_server()
        with httpx.Client(base_url=BASE, timeout=30) as client:
            run_e1_tests(client, ids)
    except Exception as e:
        check("harness setup", False, f"exception: {e!r}")
    finally:
        if server is not None:
            server.should_exit = True
        cleanup(sid)

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
