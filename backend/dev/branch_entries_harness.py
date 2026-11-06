"""(E1/E2) 分支入口、重疊降級、分支列表與幽靈重連的測試腳本。

用法：cd backend && uv run python dev/branch_entries_harness.py

做的事：
- 連 docker chat_db（沿用 database.py 的設定），建立兩個測試 User + AuthSession（A、B；Cookie: session=<token>），
  測試資料都寫 user_id，結束時只清掉本腳本建立的 user／auth_session／分支／訊息。
- 把 main.gemini_chat_stream / main.openrouter_chat_stream 換成假串流（絕不呼叫真模型）。
- 把 main.get_free_models 換成空清單，避免白名單檢查去打 OpenRouter 的模型清單。
- 在 127.0.0.1:8766 起真的 uvicorn（背景 thread），用 HTTP 打 API。
- E1：建立分支的重疊降級、範圍相同重用、offset 驗證（422 且不寫入）、回傳欄位。
- E2：regenerate 幽靈化寫 attach_root_id、幽靈清單（user 歸屬）、重連的各種拒絕、重連成功後的欄位與
  分支對話上下文（假 LLM 收到的 history）、刪除對話時清掉 attach_root_id。
"""
import asyncio
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
import auth_routes  # noqa: E402
from models import AuthSession, Branch, Message, User  # noqa: E402

# database.py 的 echo=True 會印出每一句 SQL，這個腳本只要看測試結果，關掉它（只影響本腳本）。
engine.echo = False

PORT = 8766
BASE = f"http://127.0.0.1:{PORT}"

# 不讓白名單檢查去抓 OpenRouter 免費模型清單（外部網路）
main.get_free_models = lambda session, force_refresh=False: []

# (E2) 假串流：記錄每次收到的 history（role, content），只 yield 固定文字，不連任何外部服務。
LLM_CALLS: list[dict] = []


async def fake_stream(message, history, model):
    LLM_CALLS.append({"message": message, "history": [(m.role, m.content) for m in history]})
    for chunk in ["MOCK-E2-", "REPLY"]:
        await asyncio.sleep(0.01)
        yield chunk


main.gemini_chat_stream = fake_stream
main.openrouter_chat_stream = fake_stream


RESULTS: list[tuple[str, bool, str]] = []

A_TEXT = "0123456789" * 4                 # 主線 AI 回覆 A（40 字）
A2_TEXT = "A2-SENTINEL-CONTENT-" + "y" * 20  # 主線 AI 回覆 A2（40 字），重連時用它的 history 驗證
AX_TEXT = "AX-" * 10                     # 另一棵對話樹上的 AI 回覆（30 字）


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


def db_msg(msg_id) -> dict:
    with Session(engine) as s:
        m = s.get(Message, uuid.UUID(str(msg_id)))
        if m is None:
            return {"exists": False}
        return {
            "exists": True,
            "content": m.content,
            "parent_id": m.parent_id,
            "anchor_message_id": m.anchor_message_id,
            "has_branch": m.has_branch,
            "user_id": m.user_id,
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


def relink(client: httpx.Client, branch_id, root_id, anchor_id, start=None, end=None, text="RELINK"):
    body = {"root_id": str(root_id), "anchor_message_id": str(anchor_id), "anchor_text": text}
    if start is not None:
        body["anchor_start"] = start
    if end is not None:
        body["anchor_end"] = end
    return client.post(f"/branches/{branch_id}/relink", json=body)


def orphaned(client: httpx.Client):
    r = client.get("/branches/orphaned")
    return r.status_code, (r.json() if r.status_code == 200 else [])


def regen(client: httpx.Client, msg_id, model: str):
    """重新生成（不帶 content），讀完整個 body，回傳 (status, headers, text)。"""
    main.limiter.reset()
    with client.stream("POST", f"/messages/{msg_id}/regenerate", json={"model": model}) as r:
        body = r.read().decode("utf-8")
        return r.status_code, r.headers, body


def chat(client: httpx.Client, message: str, parent_id, model: str, branch_id=None):
    """送一則訊息（假 LLM），讀完整個 body，回傳 (status, headers, text)。"""
    main.limiter.reset()
    body = {"message": message, "parent_id": str(parent_id) if parent_id else None,
            "model": model}
    if branch_id is not None:
        body["branch_id"] = str(branch_id)
    with client.stream("POST", "/chat", json=body) as r:
        text_ = r.read().decode("utf-8")
        return r.status_code, r.headers, text_


def make_legacy_ghost(uid, title: str, anchor_text: str) -> dict:
    """直接寫入一個 attach_root_id 為 NULL 的幽靈，歸屬 = Branch.user_id。"""
    with Session(engine) as s:
        br = Branch(anchor_message_id=None, anchor_start=None, anchor_end=None,
                    anchor_text=anchor_text, title=title, is_orphaned=True, attach_root_id=None,
                    user_id=uid)
        s.add(br)
        s.flush()
        m = Message(role="user", content=f"{title} question", parent_id=None,
                    user_id=uid, branch_id=br.id)
        s.add(m)
        s.flush()
        br.root_message_id = m.id
        s.add(br)
        root_id = m.id
        s.commit()
        return {"branch_id": br.id, "root_id": root_id}


def seed(uid, uid_other) -> dict:
    """主對話樹 R → {A, A2}（A2 的內容用來驗證重連後的 history）；另一棵樹 R2 → AX；
    uid_other 的一棵樹 R_other（只為了讓另一位使用者有資料）。"""
    with Session(engine) as s:
        R = Message(role="user", content="E2 root question", parent_id=None,
                    user_id=uid, title="E2 harness")
        s.add(R)
        s.commit()
        s.refresh(R)
        A = Message(role="assistant", content=A_TEXT, parent_id=R.id,
                    user_id=uid, model_used="gemini-2.5-flash")
        A2 = Message(role="assistant", content=A2_TEXT, parent_id=R.id,
                     user_id=uid, model_used="gemini-2.5-flash")
        s.add_all([A, A2])
        s.commit()
        s.refresh(A)
        s.refresh(A2)

        R2 = Message(role="user", content="E2 other tree", parent_id=None,
                     user_id=uid, title="E2 other")
        s.add(R2)
        s.commit()
        s.refresh(R2)
        AX = Message(role="assistant", content=AX_TEXT, parent_id=R2.id,
                     user_id=uid, model_used="gemini-2.5-flash")
        s.add(AX)
        s.commit()
        s.refresh(AX)

        R_other = Message(role="user", content="other session root", parent_id=None,
                          user_id=uid_other, title="other")
        s.add(R_other)
        s.commit()
        s.refresh(R_other)
        return {"R": R.id, "A": A.id, "A2": A2.id, "R2": R2.id, "AX": AX.id, "R_other": R_other.id}


def run_e1_tests(client: httpx.Client, ids: dict, out: dict):
    """E1 測試。out 用來把之後 E2 會用到的 branch id 傳出去（b1、b2、ov 等）。"""
    root_id = ids["R"]
    uid = out["uid"]
    # E1 測試各用獨立的 AI 回覆（與 E2 的主線 A／A2 分開，互不影響）
    ai_e1 = _make_ai(root_id, uid=uid, text="0123456789" * 4)   # 主要測試對象
    ai_other = _make_ai(root_id, uid=uid, text="ABCDEFGHIJ" * 4)  # E1-e：不同則同 offset
    ai_double = _make_ai(root_id, uid=uid, text="abcdefghij" * 4)  # E1-f：雙重疊

    # ---- E1-a. 無重疊 → reused=false、demoted_ids=[]；回傳含 title/reused/demoted_ids ----
    try:
        r = create(client, root_id, ai_e1, "B1 text", 0, 5)
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
    b2 = None
    try:
        r = create(client, root_id, ai_e1, "B2 text", 3, 8)
        j = r.json()
        check("E1-b partial overlap: 200 and reused=false", r.status_code == 200 and j["reused"] is False,
              f"status={r.status_code} body={r.text[:200]}")
        check("E1-b partial overlap: demoted_ids contains old id", b1 in j.get("demoted_ids", []),
              f"demoted={j.get('demoted_ids')}")
        b2 = j["branch_id"]
        old = db_branch(b1)
        check("E1-b old: start/end NULL, anchor/text/title kept",
              old["anchor_start"] is None and old["anchor_end"] is None
              and old["anchor_message_id"] == ai_e1 and old["anchor_text"] == "B1 text"
              and old["title"] == "B1 text",
              f"old={old}")
        new = db_branch(b2)
        check("E1-b new: offsets 3..8", new["anchor_start"] == 3 and new["anchor_end"] == 8,
              f"new={new}")
    except Exception as e:
        check("E1-b partial overlap", False, f"exception: {e!r}")

    # ---- E1-c. 相鄰（舊.end == 新.start）→ 不降級 ----
    try:
        r = create(client, root_id, ai_e1, "B3 adjacent", 8, 12)
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
        before = count_branches(ai_e1)
        r = create(client, root_id, ai_e1, "B2 text", 3, 8)
        j = r.json()
        check("E1-d identical range: reused=true", r.status_code == 200 and j.get("reused") is True,
              f"status={r.status_code} body={r.text[:200]}")
        check("E1-d identical range: branch_id == existing", b2 is not None and j.get("branch_id") == b2,
              f"got={j.get('branch_id')} expected={b2}")
        check("E1-d identical range: demoted_ids=[] and title is existing title",
              j.get("demoted_ids") == [] and j.get("title") == "B2 text",
              f"demoted={j.get('demoted_ids')} title={j.get('title')!r}")
        check("E1-d identical range: branch count unchanged", count_branches(ai_e1) == before,
              f"before={before} after={count_branches(ai_e1)}")
    except Exception as e:
        check("E1-d identical range", False, f"exception: {e!r}")

    # ---- E1-e. 不同則訊息、同樣 offset → 不降級 ----
    try:
        r = create(client, root_id, ai_other, "other msg", 3, 8)
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
        ra = create(client, root_id, ai_double, "D1", 0, 5).json()
        rb = create(client, root_id, ai_double, "D2", 10, 15).json()
        r = create(client, root_id, ai_double, "D3 covers both", 3, 12)
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
        r = create(client, root_id, ai_e1, "no offset entry")
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
            before_count = count_branches(ai_e1)
            before_b2 = db_branch(b2) if b2 else None
            body = {"anchor_message_id": str(ai_e1), "anchor_text": "bad"}
            body.update(extra)
            r = client.post(f"/chats/{root_id}/branches", json=body)
            check(f"E1-h {label}: 422", r.status_code == 422, f"status={r.status_code} body={r.text[:200]}")
            check(f"E1-h {label}: no write", count_branches(ai_e1) == before_count
                  and (b2 is None or db_branch(b2) == before_b2),
                  f"count {before_count}->{count_branches(ai_e1)}")
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


def _make_ai(root_id, uid, text: str) -> uuid.UUID:
    """在 root 底下另外建一則 AI 回覆（E1 測試用，各自獨立，不影響 E2 的主線）。"""
    with Session(engine) as s:
        a = Message(role="assistant", content=text, parent_id=root_id,
                    user_id=uid, model_used="gemini-2.5-flash")
        s.add(a)
        s.commit()
        s.refresh(a)
        return a.id


def run_e2_tests(client: httpx.Client, client_b: httpx.Client, ids: dict, uid, uid_other, model: str):
    R, A, A2, R2, AX = ids["R"], ids["A"], ids["A2"], ids["R2"], ids["AX"]

    # ---- E2-0. 準備：在 A 上建分支 BR（[0,8)），用 /chat 送第一則（分支首則訊息綁上 root）----
    try:
        r = create(client, R, A, "ORIG", 0, 8)
        BR = r.json()["branch_id"]
        st, h, _ = chat(client, "branch Q", A, model, branch_id=BR)
        check("E2-0 setup: branch first message via /chat", st == 200, f"status={st}")
        RB1 = h.get("x-user-message-id")
        RB1_AI = h.get("x-message-id")
    except Exception as e:
        check("E2-0 setup", False, f"exception: {e!r}")
        return

    # ---- E2-1. regenerate 幽靈化：attach_root_id = 樹根 R ----
    try:
        st, headers, _ = regen(client, A, model)
        check("E2-1 regen A: 200", st == 200, f"status={st}")
        br = db_branch(BR)
        check("E2-1 ghost: is_orphaned true, anchor NULL", br["is_orphaned"] is True and br["anchor_message_id"] is None,
              f"br={br}")
        check("E2-1 ghost: attach_root_id == tree root R", br["attach_root_id"] == R,
              f"attach={br['attach_root_id']} expected={R}")
        check("E2-1 header lists BR", str(BR) in headers.get("x-orphaned-branch-ids", ""),
              f"header={headers.get('x-orphaned-branch-ids')!r}")
    except Exception as e:
        check("E2-1 regen ghosting", False, f"exception: {e!r}")

    # ---- E2-2. 幽靈清單依 user 過濾（B 是另一位真實使用者）----
    try:
        st, items = orphaned(client)
        check("E2-2 orphaned(A): 200 and contains BR", st == 200 and any(i["id"] == str(BR) for i in items),
              f"status={st} ids={[i['id'] for i in items]}")
        if items:
            check("E2-2 orphaned item fields",
                  set(items[0].keys()) == {"id", "title", "anchor_text", "root_message_id", "created_at"},
                  f"keys={sorted(items[0].keys())}")
        st2, items2 = orphaned(client_b)
        check("E2-2 orphaned(other user): does not contain BR",
              st2 == 200 and not any(i["id"] == str(BR) for i in items2),
              f"status={st2} ids={[i['id'] for i in items2]}")
    except Exception as e:
        check("E2-2 orphaned list", False, f"exception: {e!r}")

    # ---- E2-3. attach NULL 的幽靈（歸屬 = Branch.user_id）----
    G_same = make_legacy_ghost(uid, "G-SAME", "same range")
    G_range = make_legacy_ghost(uid, "G-RANGE", "range")
    G_wrong = make_legacy_ghost(uid, "G-WRONG", "wrong tree")
    G_other = make_legacy_ghost(uid_other, "G-OTHER", "other user")
    try:
        st, items = orphaned(client)
        ids_sid = {i["id"] for i in items}
        check("E2-3 ghost (attach NULL) listed for its owner",
              str(G_range["branch_id"]) in ids_sid and str(G_same["branch_id"]) in ids_sid,
              f"ids={ids_sid}")
        st2, items2 = orphaned(client_b)
        ids_other = {i["id"] for i in items2}
        check("E2-3 ghost of other user listed only for that user",
              str(G_other["branch_id"]) in ids_other and str(G_other["branch_id"]) not in ids_sid
              and str(G_range["branch_id"]) not in ids_other,
              f"ids_other={ids_other}")
    except Exception as e:
        check("E2-3 legacy listing", False, f"exception: {e!r}")

    # ---- E2-4. 準備：A2 上的兩個非幽靈分支（OV 會被 BR 的重連降級；EX 用來測範圍完全相同 → 409）----
    try:
        OV = create(client, R, A2, "OV", 12, 16).json()["branch_id"]
        EX = create(client, R, A2, "EX", 20, 26).json()["branch_id"]
    except Exception as e:
        check("E2-4 setup OV/EX", False, f"exception: {e!r}")
        OV = EX = None

    # ---- E2-5. 重連的拒絕情況（全部不寫入）----
    try:
        r = relink(client, uuid.uuid4(), R, A2, 10, 18)
        check("E2-5 random branch id → 404", r.status_code == 404, f"status={r.status_code}")
    except Exception as e:
        check("E2-5 random branch id", False, f"exception: {e!r}")

    for label, g in [("other user ghost", G_other)]:
        try:
            before = db_branch(g["branch_id"])
            r = relink(client, g["branch_id"], R, A2, 10, 18)
            check(f"E2-5 {label} → 404 (no leak)", r.status_code == 404, f"status={r.status_code} body={r.text[:200]}")
            check(f"E2-5 {label}: fields unchanged", db_branch(g["branch_id"]) == before,
                  f"before={before} after={db_branch(g['branch_id'])}")
        except Exception as e:
            check(f"E2-5 {label}", False, f"exception: {e!r}")

    try:
        before = db_branch(G_wrong["branch_id"])
        r = relink(client, G_wrong["branch_id"], R, AX, 0, 5)
        check("E2-5 anchor in another conversation → 400", r.status_code == 400,
              f"status={r.status_code} body={r.text[:200]}")
        check("E2-5 anchor in another conversation: unchanged", db_branch(G_wrong["branch_id"]) == before, "")
    except Exception as e:
        check("E2-5 wrong tree", False, f"exception: {e!r}")

    bad_offsets = [
        ("only start", 10, None),
        ("start == end", 7, 7),
        ("start > end", 9, 3),
        ("end beyond content", 5, len(A2_TEXT) + 1),
        ("negative start", -1, 3),
    ]
    for label, s_, e_ in bad_offsets:
        try:
            before = db_branch(G_range["branch_id"])
            r = relink(client, G_range["branch_id"], R, A2, s_, e_)
            check(f"E2-5 offsets {label} → 422", r.status_code == 422, f"status={r.status_code} body={r.text[:200]}")
            check(f"E2-5 offsets {label}: unchanged", db_branch(G_range["branch_id"]) == before, "")
        except Exception as e:
            check(f"E2-5 offsets {label}", False, f"exception: {e!r}")

    try:
        r = relink(client, G_range["branch_id"], R, uuid.uuid4(), 0, 3)
        check("E2-5 anchor not found → 404", r.status_code == 404, f"status={r.status_code}")
        r = relink(client, G_range["branch_id"], uuid.uuid4(), A2, 0, 3)
        check("E2-5 root not found → 404", r.status_code == 404, f"status={r.status_code}")
    except Exception as e:
        check("E2-5 not found cases", False, f"exception: {e!r}")

    if EX is not None:
        try:
            before = db_branch(G_same["branch_id"])
            r = relink(client, G_same["branch_id"], R, A2, 20, 26)
            check("E2-5 same range as existing non-ghost → 409", r.status_code == 409,
                  f"status={r.status_code} body={r.text[:200]}")
            check("E2-5 same range: ghost unchanged", db_branch(G_same["branch_id"]) == before, "")
        except Exception as e:
            check("E2-5 same range", False, f"exception: {e!r}")

    # ---- E2-6. 重連成功：BR → A2 [10,18)，與 OV [12,16) 重疊 → OV 降級 ----
    try:
        before_title = db_branch(BR)["title"]
        r = relink(client, BR, R, A2, 10, 18, text="RELINKED TEXT")
        j = r.json()
        check("E2-6 relink BR: 200 and reused=false", r.status_code == 200 and j.get("reused") is False,
              f"status={r.status_code} body={r.text[:200]}")
        check("E2-6 relink BR: demoted_ids == [OV]", OV is not None and j.get("demoted_ids") == [OV],
              f"demoted={j.get('demoted_ids')} OV={OV}")
        check("E2-6 relink BR: precise true", j.get("precise") is True, f"precise={j.get('precise')}")
        b = db_branch(BR)
        check("E2-6 relink BR: anchor/offset/text set",
              b["anchor_message_id"] == A2 and b["anchor_start"] == 10 and b["anchor_end"] == 18
              and b["anchor_text"] == "RELINKED TEXT",
              f"b={b}")
        check("E2-6 relink BR: is_orphaned false, attach NULL, title unchanged",
              b["is_orphaned"] is False and b["attach_root_id"] is None and b["title"] == before_title,
              f"b={b} title_before={before_title!r}")
        rb = db_msg(RB1)
        check("E2-6 relink BR: first message re-parented to new anchor",
              rb["parent_id"] == A2 and rb["anchor_message_id"] == A2, f"rb={rb}")
        check("E2-6 relink BR: tree root has_branch true", db_msg(R)["has_branch"] is True, "")
        ov = db_branch(OV)
        check("E2-6 relink BR: OV demoted (start/end NULL)", ov["anchor_start"] is None and ov["anchor_end"] is None,
              f"ov={ov}")
        st, items = orphaned(client)
        check("E2-6 after relink: GET /chats/R/branches contains BR precise",
              any(i["id"] == str(BR) and i["precise"] is True
                  for i in client.get(f"/chats/{R}/branches").json()),
              "")
        check("E2-6 after relink: orphaned list no longer has BR",
              not any(i["id"] == str(BR) for i in items), f"ids={[i['id'] for i in items]}")
    except Exception as e:
        check("E2-6 relink success", False, f"exception: {e!r}")

    # ---- E2-7. 非幽靈 → 409（BR 現在是非幽靈，屬於 A）----
    try:
        before = db_branch(BR)
        r = relink(client, BR, R, A2, 0, 3)
        check("E2-7 relink non-ghost → 409", r.status_code == 409, f"status={r.status_code} body={r.text[:200]}")
        check("E2-7 non-ghost unchanged", db_branch(BR) == before, "")
    except Exception as e:
        check("E2-7 non-ghost", False, f"exception: {e!r}")

    # ---- E2-8. 重連後在分支送訊息：假 LLM 收到的 history 以新錨點為上下文 ----
    try:
        LLM_CALLS.clear()
        st, _, _ = chat(client, "after relink Q", RB1_AI, model, branch_id=BR)
        check("E2-8 chat in relinked branch: 200", st == 200, f"status={st}")
        contents = [c for _, c in LLM_CALLS[-1]["history"]] if LLM_CALLS else []
        check("E2-8 history contains new anchor content (A2)", A2_TEXT in contents,
              f"contents={[c[:30] for c in contents]}")
        check("E2-8 history does not contain old anchor content (A)", A_TEXT not in contents,
              "")
    except Exception as e:
        check("E2-8 chat after relink", False, f"exception: {e!r}")

    # ---- E2-9. 原對話被刪：幽靈保留，attach_root_id 變 NULL ----
    try:
        RT = _make_root(uid, "E2 tree T")
        AT = _make_ai(RT, uid, "T-AI-" * 8)
        r = create(client, RT, AT, "T-ghost", 0, 4)
        BT = r.json()["branch_id"]
        st, h, _ = chat(client, "T branch Q", AT, model, branch_id=BT)
        RT_B1 = h.get("x-user-message-id")
        st_r, _, _ = regen(client, AT, model)
        check("E2-9 setup: T branch ghosted", st_r == 200 and db_branch(BT)["is_orphaned"] is True
              and db_branch(BT)["attach_root_id"] == RT, f"regen={st_r} br={db_branch(BT)}")
        d = client.delete(f"/chats/{RT}")
        check("E2-9 DELETE root with attach pointing to it → 200", d.status_code == 200,
              f"status={d.status_code} body={d.text[:200]}")
        b = db_branch(BT)
        check("E2-9 ghost survives with attach_root_id NULL", b["is_orphaned"] is True and b["attach_root_id"] is None,
              f"b={b}")
        check("E2-9 branch first message survives", db_msg(RT_B1)["exists"] is True, "")
        st3, items3 = orphaned(client)
        check("E2-9 ghost still listed for its owner", any(i["id"] == str(BT) for i in items3),
              f"ids={[i['id'] for i in items3]}")
    except Exception as e:
        check("E2-9 delete with ghost", False, f"exception: {e!r}")


def _make_root(uid, text: str) -> uuid.UUID:
    with Session(engine) as s:
        r = Message(role="user", content=text, parent_id=None, user_id=uid, title=text)
        s.add(r)
        s.commit()
        s.refresh(r)
        return r.id


def make_user(label: str) -> tuple[uuid.UUID, str]:
    """直接建立測試 User + AuthSession，回傳 (user_id, 原始 token)。"""
    with Session(engine) as s:
        u = User(oauth_provider="github", oauth_sub=f"branch-harness-{label}-{uuid.uuid4()}",
                 email=f"branch-harness-{label}@example.invalid")
        s.add(u)
        s.commit()
        s.refresh(u)
        token = auth_routes.create_session_token(s, u)
        return u.id, token


def cleanup(uids: list):
    """清掉測試資料（只動這些測試 user 的列）。
    順序：先斷開 branch 指向訊息的 FK → 斷開訊息之間的 FK → 刪訊息 → 刪分支 → 刪 auth_session → 刪 user。
    分支由這些 user 的訊息（branch_id／anchor／root／attach）、Branch.user_id 反查。"""
    try:
        with Session(engine) as s:
            msgs = s.exec(select(Message).where(Message.user_id.in_(uids))).all()
            msg_ids = [m.id for m in msgs]
            branch_ids = {m.branch_id for m in msgs if m.branch_id}
            branch_ids |= set(s.exec(select(Branch.id).where(Branch.user_id.in_(uids))).all())
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
        with Session(engine) as s:
            for m in s.exec(select(Message).where(Message.user_id.in_(uids))).all():
                m.parent_id = None
                m.branch_id = None
                m.anchor_message_id = None
                s.add(m)
            s.commit()
        with Session(engine) as s:
            for m in s.exec(select(Message).where(Message.user_id.in_(uids))).all():
                s.delete(m)
            s.commit()
        if branch_ids:
            with Session(engine) as s:
                for b in s.exec(select(Branch).where(Branch.id.in_(branch_ids))).all():
                    s.delete(b)
                s.commit()
        with Session(engine) as s:
            for a in s.exec(select(AuthSession).where(AuthSession.user_id.in_(uids))).all():
                s.delete(a)
            s.commit()
            for u in s.exec(select(User).where(User.id.in_(uids))).all():
                s.delete(u)
            s.commit()
        print(f"cleanup: removed users {[str(u) for u in uids]}")
    except Exception as e:  # 清理失敗要看得到，但不蓋掉測試結果
        print(f"cleanup FAILED for {uids}: {e}")


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
    created_uids: list = []
    server = None
    try:
        model = next(
            (m for m in ["gemini-2.5-flash-lite", "gemini-2.5-flash"] if main.is_model_allowed(m)),
            None,
        )
        check("setup: an allowed gemini model exists", model is not None, "no allowed model")
        uid, token = make_user("a")
        created_uids.append(uid)
        uid_other, token_other = make_user("b")
        created_uids.append(uid_other)
        ids = seed(uid, uid_other)
        server = start_server()
        with httpx.Client(base_url=BASE, timeout=30, cookies={"session": token}) as client, \
                httpx.Client(base_url=BASE, timeout=30, cookies={"session": token_other}) as client_b:
            out = {"uid": uid}
            run_e1_tests(client, ids, out)
            if model is not None:
                run_e2_tests(client, client_b, ids, uid, uid_other, model)
    except Exception as e:
        check("harness setup", False, f"exception: {e!r}")
    finally:
        if server is not None:
            server.should_exit = True
        if created_uids:
            cleanup(created_uids)

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
