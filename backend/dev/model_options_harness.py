"""(V1-3) 模型選項端點（GET /api/model-options）與白名單測試腳本。

用法：cd backend && POSTGRES_DB=v1_models SQL_ECHO=false uv run python dev/model_options_harness.py

做的事：
- 連 docker chat_db（沿用 database.py 的設定），建立測試用 User + AuthSession，結束時只清掉本腳本建立的列。
- 把 main.gemini_chat_stream / main.openrouter_chat_stream 換成假串流（絕不呼叫真模型）。
- 把 main.get_free_models 換成可控的假清單（可設成空、或讓它拋錯）。
- 在 127.0.0.1:8766 起真的 uvicorn（背景 thread），用 HTTP 打 API。
- 白名單用 main._parse_allowed_models 解析真正的環境變數字串（例如 "none"）後設進 main.ALLOWED_MODELS。
"""
import asyncio
import os
import subprocess
import sys
import threading
import time
import uuid

# (V1-2) 每日額度改為很大的值：這些案例要測的不是額度。
os.environ["DAILY_MESSAGE_LIMIT"] = "100000"
os.environ["SITE_DAILY_MESSAGE_LIMIT"] = "1000000"
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

import main  # noqa: E402
import gemini_llm  # noqa: E402
from database import engine  # noqa: E402
import auth_routes  # noqa: E402
from models import AuthSession, Branch, Message, User  # noqa: E402

# database.py 的 echo=True 會印出每一句 SQL，這個腳本只要看測試結果，關掉它（只影響本腳本）。
engine.echo = False

PORT = 8766
BASE = f"http://127.0.0.1:{PORT}"

GEMINI_PRESET = {"value": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash Lite"}
FREE_A = "free/alpha:free"
FREE_B = "free/beta:free"

# 假的免費模型清單（可在測試中改寫）；raise 為 True 時模擬爬蟲失敗。
FREE_STATE = {"models": [{"id": FREE_A}, {"id": FREE_B}], "raise": False}


def fake_get_free_models(session, force_refresh=False):
    if FREE_STATE["raise"]:
        raise RuntimeError("scraper down (harness)")
    return list(FREE_STATE["models"])


# 不讓白名單與選項端點去抓 OpenRouter 清單（外部網路）
main.get_free_models = fake_get_free_models


async def fake_stream(message, history, model):
    """假的 LLM 串流：只 yield 固定文字，不連任何外部服務。"""
    for chunk in ["MOCK-OPT-", "done"]:
        await asyncio.sleep(0.01)
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


def set_state(allowed_env: str, default_env: str | None, free_models=None, free_raise: bool = False):
    """設定白名單（用真正的字串經過解析）、DEFAULT_MODEL 與假免費清單。"""
    os.environ["ALLOWED_MODELS"] = allowed_env
    main.ALLOWED_MODELS = main._parse_allowed_models(os.environ["ALLOWED_MODELS"])
    if default_env is None:
        os.environ.pop("DEFAULT_MODEL", None)
    else:
        os.environ["DEFAULT_MODEL"] = default_env
    if free_models is not None:
        FREE_STATE["models"] = free_models
    FREE_STATE["raise"] = free_raise


def options(client: httpx.Client):
    r = client.get("/api/model-options")
    return r.status_code, (r.json() if r.status_code == 200 else None)


def chat(client: httpx.Client, model: str):
    """送一則 /chat 並把串流讀完，回傳 status。"""
    main.limiter.reset()
    with client.stream("POST", "/chat", json={"message": "hi", "parent_id": None, "model": model}) as r:
        r.read()
        return r.status_code


def count_messages(uid: uuid.UUID) -> int:
    with Session(engine) as s:
        return len(s.exec(select(Message).where(Message.user_id == uid)).all())


def make_user() -> tuple[uuid.UUID, str]:
    with Session(engine) as s:
        u = User(oauth_provider="github", oauth_sub=f"opt-harness-{uuid.uuid4()}",
                 email="opt-harness@example.invalid")
        s.add(u)
        s.commit()
        s.refresh(u)
        token = auth_routes.create_session_token(s, u)
        return u.id, token


def cleanup(uid: uuid.UUID):
    """只清掉這個測試 user 的列：先斷 FK，再刪訊息、分支、auth_session、user。"""
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
    except Exception as e:
        print(f"cleanup warning: {e!r}")


def run_tests(client: httpx.Client, uid: uuid.UUID):
    original_env = {k: os.environ.get(k) for k in ("ALLOWED_MODELS", "DEFAULT_MODEL")}

    # ---- 0. 解析函式（用真正的字串） ----
    check("parse 'none' -> []", main._parse_allowed_models("none") == [],
          f"got {main._parse_allowed_models('none')!r}")
    check("parse 'gemini*,none' -> ['gemini*']", main._parse_allowed_models("gemini*,none") == ["gemini*"],
          f"got {main._parse_allowed_models('gemini*,none')!r}")
    check("parse 'gemini*' -> ['gemini*']", main._parse_allowed_models("gemini*") == ["gemini*"],
          f"got {main._parse_allowed_models('gemini*')!r}")

    # ---- 1. 未登入 → 401 ----
    try:
        with httpx.Client(base_url=BASE, timeout=30) as anon:
            r = anon.get("/api/model-options")
            check("1 unauthenticated -> 401", r.status_code == 401, f"status={r.status_code}")
    except Exception as e:
        check("1 unauthenticated -> 401", False, f"exception: {e!r}")

    # ---- 2. ALLOWED_MODELS=none ----
    set_state("none", None, free_models=[{"id": FREE_A}, {"id": FREE_B}])
    try:
        status, body = options(client)
        check("2a none: options 200", status == 200, f"status={status}")
        check("2a none: presets == []", body is not None and body["presets"] == [],
              f"body={body!r}")
        check("2a none: default is first free model", body is not None and body["default_model"] == FREE_A,
              f"body={body!r}")
    except Exception as e:
        check("2a none: options", False, f"exception: {e!r}")

    try:
        before = count_messages(uid)
        s_gem = chat(client, "gemini-2.5-flash-lite")
        check("2b none: gemini-2.5-flash-lite /chat -> 403", s_gem == 403, f"status={s_gem}")
        check("2b none: gemini rejected, no rows written", count_messages(uid) == before,
              f"before={before} after={count_messages(uid)}")
        s_none = chat(client, "none")
        check("2c none: model literally 'none' /chat -> 403", s_none == 403, f"status={s_none}")
        check("2c none: 'none' rejected, no rows written", count_messages(uid) == before,
              f"before={before} after={count_messages(uid)}")
    except Exception as e:
        check("2b/2c none: /chat rejections", False, f"exception: {e!r}")

    # ---- 2d. 同狀態下免費模型可送出 ----
    try:
        s_free = chat(client, FREE_A)
        check("2d none: free model /chat -> 200", s_free == 200, f"status={s_free}")
    except Exception as e:
        check("2d none: free model /chat", False, f"exception: {e!r}")

    # ---- 3. DEFAULT_MODEL ----
    set_state("none", FREE_B)
    try:
        status, body = options(client)
        check("3a DEFAULT_MODEL valid free model -> returned",
              status == 200 and body["default_model"] == FREE_B, f"status={status} body={body!r}")
    except Exception as e:
        check("3a DEFAULT_MODEL valid free model", False, f"exception: {e!r}")

    set_state("none", "nope/not-allowed:free")
    try:
        status, body = options(client)
        check("3b DEFAULT_MODEL not allowed -> first free model",
              status == 200 and body["default_model"] == FREE_A, f"status={status} body={body!r}")
    except Exception as e:
        check("3b DEFAULT_MODEL not allowed", False, f"exception: {e!r}")

    set_state("none", "")
    try:
        status, body = options(client)
        check("3c DEFAULT_MODEL empty -> first free model",
              status == 200 and body["default_model"] == FREE_A, f"status={status} body={body!r}")
    except Exception as e:
        check("3c DEFAULT_MODEL empty", False, f"exception: {e!r}")

    # ---- 4. gemini* 設定、未設 DEFAULT_MODEL ----
    set_state("gemini*", None)
    try:
        status, body = options(client)
        check("4a gemini* -> presets is [gemini preset]",
              status == 200 and body["presets"] == [GEMINI_PRESET], f"status={status} body={body!r}")
        check("4b gemini* no DEFAULT_MODEL -> default is gemini",
              status == 200 and body["default_model"] == GEMINI_PRESET["value"], f"body={body!r}")
    except Exception as e:
        check("4 gemini* options", False, f"exception: {e!r}")

    # ---- 4c. 精確項目與其他萬用字元 ----
    set_state("gemini*,free/exact:free,openai/*", None)
    try:
        status, body = options(client)
        expected = [GEMINI_PRESET, {"value": "free/exact:free", "label": "free/exact:free"}]
        check("4c exact entry value=label, other wildcard skipped",
              status == 200 and body["presets"] == expected, f"body={body!r}")
    except Exception as e:
        check("4c exact entry / wildcard skip", False, f"exception: {e!r}")

    # ---- 5. 沒有 presets 且免費清單為空 → null ----
    set_state("none", None, free_models=[])
    try:
        status, body = options(client)
        check("5 no presets + empty free list -> default null",
              status == 200 and body["default_model"] is None, f"status={status} body={body!r}")
    except Exception as e:
        check("5 no presets + empty free list", False, f"exception: {e!r}")

    # ---- 6. 爬蟲拋錯 → 200，不是 500 ----
    set_state("none", None, free_models=[{"id": FREE_A}], free_raise=True)
    try:
        status, body = options(client)
        check("6 scraper raises -> 200 (not 500)", status == 200, f"status={status}")
        check("6 scraper raises -> default null", status == 200 and body["default_model"] is None,
              f"body={body!r}")
    except Exception as e:
        check("6 scraper raises", False, f"exception: {e!r}")
    finally:
        FREE_STATE["raise"] = False

    # ---- 7. gemini_llm 無 GOOGLE_API_KEY 時可 import ----
    try:
        env_no_key = {k: v for k, v in os.environ.items() if k != "GOOGLE_API_KEY"}
        proc = subprocess.run(
            ["env", "-u", "GOOGLE_API_KEY", sys.executable, "-c", "import gemini_llm"],
            cwd=BACKEND_DIR, env=env_no_key, capture_output=True, text=True, timeout=120,
        )
        check("7a import gemini_llm without GOOGLE_API_KEY succeeds", proc.returncode == 0,
              f"rc={proc.returncode} stderr={proc.stderr[-300:]!r}")
    except Exception as e:
        check("7a import gemini_llm without GOOGLE_API_KEY", False, f"exception: {e!r}")

    # ---- 7b. 沒有金鑰時串流拋錯（不呼叫任何外部服務） ----
    saved_key = gemini_llm.GOOGLE_API_KEY
    gemini_llm.GOOGLE_API_KEY = None
    try:
        async def consume():
            async for _ in gemini_llm.gemini_chat_stream("hi", [], "gemini-2.5-flash-lite"):
                pass

        raised = None
        try:
            asyncio.run(consume())
        except RuntimeError as e:
            raised = str(e)
        check("7b gemini stream raises when key missing", raised is not None, f"raised={raised!r}")
    except Exception as e:
        check("7b gemini stream raises when key missing", False, f"exception: {e!r}")
    finally:
        gemini_llm.GOOGLE_API_KEY = saved_key

    # 還原環境變數
    for k, v in original_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


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
    server = None
    uid = None
    try:
        uid, token = make_user()
        server = start_server()
        with httpx.Client(base_url=BASE, timeout=30, cookies={"session": token}) as client:
            run_tests(client, uid)
    except Exception as e:
        check("harness setup", False, f"exception: {e!r}")
    finally:
        if server is not None:
            server.should_exit = True
        if uid is not None:
            time.sleep(0.5)  # 讓背景存檔（若有）結束再清理
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
