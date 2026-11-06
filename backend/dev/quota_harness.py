"""(V1-2) 每日額度、每分鐘限流與輸出上限的測試腳本。

用法（只用臨時資料庫，不要指向正式 chat_db）：
    cd backend && POSTGRES_DB=v1_quota SQL_ECHO=false uv run python dev/quota_harness.py 2>&1 | grep -v sqlalchemy | tail -5

做的事：
- 建立測試 User + AuthSession，測試資料都寫 user_id；結束時只清掉本腳本建立的 user（daily_usage 一併清）。
- 把 main.gemini_chat_stream / main.openrouter_chat_stream 換成假串流（計數、可指定失敗方式），絕不呼叫真模型。
- 把 main.get_free_models 換成空清單，避免白名單檢查去連 OpenRouter。
- 在 127.0.0.1:8768 起真的 uvicorn（背景 thread），用 HTTP 打 API。
- 限流只在第 10 案開啟，其餘案例關閉，避免測試本身被每分鐘 10 次擋住。
"""
import asyncio
import json
import os
import sys
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time as dtime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

# 測試預設值；各案例需要不同額度時自行設定（見 reset_env）
os.environ["ALLOWED_MODELS"] = "gemini*"
os.environ["MAX_OUTPUT_TOKENS"] = "1500"

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from sqlalchemy import delete as sa_delete, func as sa_func  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

import main  # noqa: E402
import gemini_llm  # noqa: E402
import openrouter_llm  # noqa: E402
import auth_routes  # noqa: E402
from database import engine  # noqa: E402
from models import AuthSession, Branch, DailyUsage, Message, User  # noqa: E402

# database.py 的 echo 會印出所有 SQL；這個腳本只看測試結果，關掉它（只影響本腳本）。
engine.echo = False

PORT = 8768
BASE = f"http://127.0.0.1:{PORT}"

# 生成結束後的緩衝保留時間調短，讓測試快一點
main.BUFFER_RETENTION_SECONDS = 2
# 不讓白名單去抓 OpenRouter 免費模型清單；環境變數白名單照常生效
main.get_free_models = lambda session, force_refresh=False: []
# 限流預設關閉，只有第 10 案開啟
main.limiter.enabled = False

# 在 patch main 之前保存真實函式：第 11 案直接呼叫它們，測輸出上限與例外傳遞
REAL_GEMINI_STREAM = gemini_llm.gemini_chat_stream
REAL_OPENROUTER_STREAM = openrouter_llm.openrouter_chat_stream

MODEL = "gemini-2.5-flash-lite"
# 固定提示：用字面值寫死，不引用 main 的常數，避免測試變成同義反覆
FIXED = "\n\n⚠️ 生成中斷，請稍後再試"
SECRET = "PROVIDER-SECRET-DETAIL sk-test-123"
TZ8 = timezone(timedelta(hours=8))

LLM_CALLS = {"n": 0}
# 每次假串流開始時取一個模式：raise_before / raise_after_one / slow / 其餘（空佇列）= ok
MODE_QUEUE: deque = deque()


async def fake_stream(message, history, model):
    """假的 LLM 串流：只計數、依模式 yield 或失敗，不連任何外部服務。"""
    LLM_CALLS["n"] += 1
    mode = MODE_QUEUE.popleft() if MODE_QUEUE else "ok"
    if mode == "raise_before":
        raise RuntimeError(SECRET)
    if mode == "raise_after_one":
        yield "PARTIAL"
        raise RuntimeError(SECRET)
    if mode == "slow":
        for i in range(10):
            await asyncio.sleep(0.5)
            yield f"SLOW-{i} "
        return
    yield "MOCK-REPLY"


main.gemini_chat_stream = fake_stream
main.openrouter_chat_stream = fake_stream

RESULTS: list[tuple[str, bool, str]] = []
CREATED: list[uuid.UUID] = []


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

def reset_env(user_limit: int = 20, site_limit: int = 100000):
    os.environ["DAILY_MESSAGE_LIMIT"] = str(user_limit)
    os.environ["SITE_DAILY_MESSAGE_LIMIT"] = str(site_limit)


def today() -> date:
    return main.taiwan_today()


def expected_reset(day: date) -> str:
    """獨立算出 day 的下一個台灣 00:00 的 UTC 字串（不呼叫 main 的函式）。"""
    midnight = datetime.combine(day + timedelta(days=1), dtime(0), tzinfo=TZ8)
    return midnight.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_user() -> tuple[uuid.UUID, str]:
    with Session(engine) as s:
        u = User(oauth_provider="github", oauth_sub=f"quota-harness-{uuid.uuid4()}",
                 email="quota-harness@example.invalid")
        s.add(u)
        s.commit()
        s.refresh(u)
        uid = u.id
        token = auth_routes.create_session_token(s, u)
    CREATED.append(uid)
    return uid, token


def client_for(token: str) -> httpx.Client:
    return httpx.Client(base_url=BASE, timeout=60, cookies={"session": token})


def usage(uid: uuid.UUID, day: date | None = None) -> int:
    with Session(engine) as s:
        row = s.get(DailyUsage, (uid, day or today()))
        return row.count if row else 0


def set_usage(uid: uuid.UUID, count: int, day: date | None = None):
    with Session(engine) as s:
        s.merge(DailyUsage(user_id=uid, day=day or today(), count=count))
        s.commit()


def msg_count(uid: uuid.UUID) -> int:
    with Session(engine) as s:
        return len(s.exec(select(Message.id).where(Message.user_id == uid)).all())


def site_total() -> int:
    with Session(engine) as s:
        return int(s.exec(
            select(sa_func.coalesce(sa_func.sum(DailyUsage.count), 0)).where(DailyUsage.day == today())
        ).one())


def total_rows_today() -> int:
    with Session(engine) as s:
        return len(s.exec(select(DailyUsage.user_id).where(DailyUsage.day == today())).all())


def db_content(msg_id: str | None) -> str | None:
    if msg_id is None:
        return None
    with Session(engine) as s:
        m = s.get(Message, uuid.UUID(msg_id))
        return m.content if m else None


def post_chat(client: httpx.Client, body: dict):
    with client.stream("POST", "/chat", json=body) as r:
        raw = r.read().decode("utf-8")
        return r.status_code, r.headers, raw


def post_regen(client: httpx.Client, msg_id: str, body: dict):
    with client.stream("POST", f"/messages/{msg_id}/regenerate", json=body) as r:
        raw = r.read().decode("utf-8")
        return r.status_code, r.headers, raw


def detail_of(raw: str):
    try:
        return json.loads(raw).get("detail")
    except Exception:  # noqa: BLE001
        return None


def chat_body(message: str = "hi", **extra) -> dict:
    body = {"message": message, "model": MODEL}
    body.update(extra)
    return body


# ---------- 案例 ----------

def t01_limit_20():
    """第 20 次成功、第 21 次 429 且沒有新訊息、沒有呼叫 LLM。"""
    reset_env(20)
    uid, token = make_user()
    with client_for(token) as c:
        statuses = [post_chat(c, chat_body(f"q{i}"))[0] for i in range(20)]
        check("01a first 20 /chat succeed", statuses == [200] * 20, str(statuses))
        check("01b usage == 20 after 20 calls", usage(uid) == 20, str(usage(uid)))
        msgs_before, llm_before = msg_count(uid), LLM_CALLS["n"]
        st, _, raw = post_chat(c, chat_body("q21"))
        d = detail_of(raw) or {}
        check("01c 21st -> 429", st == 429, f"{st} {raw[:120]}")
        check("01d code daily_quota_exceeded", d.get("code") == "daily_quota_exceeded", str(d))
        check("01e reset_at == next Taiwan midnight", d.get("reset_at") == expected_reset(today()),
              f"{d.get('reset_at')} vs {expected_reset(today())}")
        check("01f no new Message rows", msg_count(uid) == msgs_before,
              f"before={msgs_before} after={msg_count(uid)}")
        check("01g LLM not called on 21st", LLM_CALLS["n"] == llm_before,
              f"before={llm_before} after={LLM_CALLS['n']}")
        check("01h usage still 20", usage(uid) == 20, str(usage(uid)))


def t02_shared_counter():
    """主對話、分支訊息、regenerate 共用同一個次數。"""
    reset_env(20)
    uid, token = make_user()
    with client_for(token) as c:
        st, h, _ = post_chat(c, chat_body("main q"))
        ai_main, root = h.get("X-Message-Id"), h.get("X-User-Message-Id")
        check("02a main chat -> usage 1", st == 200 and usage(uid) == 1, f"{st} {usage(uid)}")
        r = c.post(f"/chats/{root}/branches", json={"anchor_message_id": ai_main, "anchor_text": "main"})
        check("02b branch created", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        bid = r.json()["branch_id"]
        st, h, _ = post_chat(c, chat_body("branch q", parent_id=ai_main, branch_id=bid,
                                          anchor_message_id=ai_main))
        ai_branch = h.get("X-Message-Id")
        check("02c branch message -> usage 2", st == 200 and usage(uid) == 2, f"{st} {usage(uid)}")
        st, _, raw = post_regen(c, ai_branch, {"model": MODEL})
        check("02d regenerate -> usage 3", st == 200 and usage(uid) == 3, f"{st} {usage(uid)} {raw[:80]}")


def t03a_sql_atomicity():
    """20 個執行緒各自 Session + commit，剩 5 次 → 恰好 5 次成功。"""
    reset_env(20)
    uid, _ = make_user()
    set_usage(uid, 15)
    results: list = []
    lock = threading.Lock()

    def worker():
        try:
            with Session(engine) as s:
                main.charge_daily_quota(s, uid)
                s.commit()
            out = "ok"
        except HTTPException as e:
            out = e.status_code
        except Exception as e:  # noqa: BLE001
            out = f"other:{e!r}"
        with lock:
            results.append(out)

    threads = [threading.Thread(target=worker) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check("03a exactly 5 of 20 threads succeed", results.count("ok") == 5, str(results))
    check("03b the other 15 get 429 (no other errors)", results.count(429) == 15, str(results))
    check("03c count == limit 20", usage(uid) == 20, str(usage(uid)))


def t03b_http_concurrency():
    """20 個併發 HTTP /chat，剩 5 次 → 恰好 5 個 200。"""
    reset_env(20)
    uid, token = make_user()
    set_usage(uid, 15)

    def one():
        with client_for(token) as c:
            return post_chat(c, chat_body("concurrent"))[0]

    with ThreadPoolExecutor(max_workers=20) as ex:
        statuses = list(ex.map(lambda _: one(), range(20)))
    check("03d 20 concurrent HTTP /chat -> exactly 5 x 200", statuses.count(200) == 5, str(statuses))
    check("03e the other 15 -> 429", statuses.count(429) == 15, str(statuses))
    check("03f usage == 20", usage(uid) == 20, str(usage(uid)))


def t04_delete_no_refund():
    """刪除對話不退次數。"""
    reset_env(20)
    uid, token = make_user()
    with client_for(token) as c:
        _, h1, _ = post_chat(c, chat_body("a"))
        post_chat(c, chat_body("b"))
        check("04a two chats -> usage 2", usage(uid) == 2, str(usage(uid)))
        r = c.delete(f"/chats/{h1.get('X-User-Message-Id')}")
        check("04b delete chat -> 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        check("04c delete does not refund (usage still 2)", usage(uid) == 2, str(usage(uid)))
        check("04d first chat's messages removed (2 left)", msg_count(uid) == 2, str(msg_count(uid)))


def t05_taiwan_day():
    """台灣日界線與跨日重置。"""
    check("05a 2026-11-06T15:59Z is the 6th (Taiwan)",
          main.taiwan_date_of(datetime(2026, 11, 6, 15, 59, tzinfo=timezone.utc)) == date(2026, 11, 6))
    check("05b 2026-11-06T16:00Z is the 7th (Taiwan)",
          main.taiwan_date_of(datetime(2026, 11, 6, 16, 0, tzinfo=timezone.utc)) == date(2026, 11, 7))
    check("05c reset_at for the 6th is 2026-11-06T16:00:00Z",
          main.next_reset_at_utc(date(2026, 11, 6)) == "2026-11-06T16:00:00Z",
          main.next_reset_at_utc(date(2026, 11, 6)))

    reset_env(2)
    uid, token = make_user()
    set_usage(uid, 2)
    tomorrow = today() + timedelta(days=1)
    with client_for(token) as c:
        st, _, _ = post_chat(c, chat_body("blocked today"))
        check("05d exhausted today -> 429", st == 429, str(st))
        with mock.patch.object(main, "taiwan_today", lambda: tomorrow):
            st2, _, raw2 = post_chat(c, chat_body("next Taiwan day"))
        check("05e next Taiwan day -> allowed", st2 == 200, f"{st2} {raw2[:120]}")
        check("05f new row for tomorrow == 1", usage(uid, tomorrow) == 1, str(usage(uid, tomorrow)))
        check("05g today's row unchanged (2)", usage(uid) == 2, str(usage(uid)))


def t06_isolation():
    """A 用完不影響 B。"""
    reset_env(2)
    a, ta = make_user()
    b, tb = make_user()
    set_usage(a, 2)
    with client_for(ta) as ca:
        st_a, _, _ = post_chat(ca, chat_body("A over"))
    with client_for(tb) as cb:
        st_b, _, _ = post_chat(cb, chat_body("B fine"))
    check("06a A exhausted -> 429", st_a == 429, str(st_a))
    check("06b B still 200", st_b == 200, str(st_b))
    check("06c B usage == 1", usage(b) == 1, str(usage(b)))
    check("06d A usage still 2", usage(a) == 2, str(usage(a)))


def t07_site_cap():
    """全站上限到了 → 503，即使使用者自己還有額度；上限加 1 後同一人可以送出。"""
    uid, token = make_user()
    reset_env(20, site_limit=site_total())
    llm_before, msgs_before = LLM_CALLS["n"], msg_count(uid)
    with client_for(token) as c:
        st, _, raw = post_chat(c, chat_body("site full"))
        check("07a site cap reached -> 503", st == 503, f"{st} {raw[:120]}")
        check("07b code site_quota_exceeded", (detail_of(raw) or {}).get("code") == "site_quota_exceeded",
              str(detail_of(raw)))
        check("07c no rows for user", msg_count(uid) == msgs_before and usage(uid) == 0,
              f"msgs={msg_count(uid)} usage={usage(uid)}")
        check("07d LLM not called", LLM_CALLS["n"] == llm_before,
              f"before={llm_before} after={LLM_CALLS['n']}")
        reset_env(20, site_limit=site_total() + 1)
        st2, _, raw2 = post_chat(c, chat_body("site ok now"))
        check("07e site limit +1 -> 200 for same user (503 came from site cap)", st2 == 200,
              f"{st2} {raw2[:120]}")


def t08_refund_on_failure():
    """沒有任何輸出就失敗 → 退 1 次且訊息只含固定提示；回到一半才失敗 → 不退；退次數不低於 0。"""
    reset_env(20)
    uid, token = make_user()
    with client_for(token) as c:
        MODE_QUEUE.append("raise_before")
        st, h, raw = post_chat(c, chat_body("fail early"))
        check("08a raise before any chunk: usage back to 0", usage(uid) == 0, str(usage(uid)))
        check("08b body is the fixed text only", raw == FIXED, repr(raw))
        content = db_content(h.get("X-Message-Id"))
        check("08c stored content is fixed text, no provider detail",
              content == FIXED and "PROVIDER" not in content and "sk-test" not in content, repr(content))

        MODE_QUEUE.append("raise_after_one")
        st, h, raw = post_chat(c, chat_body("fail late"))
        check("08d raise after output: no refund (usage 1)", usage(uid) == 1, str(usage(uid)))
        content2 = db_content(h.get("X-Message-Id"))
        check("08e stored content is partial + fixed text, no provider detail",
              content2 == "PARTIAL" + FIXED and "PROVIDER" not in content2, repr(content2))

    set_usage(uid, 0)
    main.refund_daily_quota(uid, today())
    check("08f refund never goes below 0", usage(uid) == 0, str(usage(uid)))


def t09_rejected_before_charge():
    """白名單、擁有者、生成中、非最後一則、空白內容 → 都不扣次數。"""
    reset_env(20)
    a, ta = make_user()
    b, tb = make_user()
    with client_for(ta) as ca, client_for(tb) as cb:
        _, h, _ = post_chat(ca, chat_body("first"))
        ai1 = h.get("X-Message-Id")
        _, h, _ = post_chat(ca, chat_body("second", parent_id=ai1))
        ai2 = h.get("X-Message-Id")
        check("09-setup A has 2 charged messages", usage(a) == 2, str(usage(a)))

        before = usage(a)
        st, _, _ = post_chat(ca, chat_body("x", model="not-allowed-model"))
        check("09a /chat model not whitelisted -> 403, no charge", st == 403 and usage(a) == before,
              f"{st} usage {before}->{usage(a)}")

        _, hb, _ = post_chat(cb, chat_body("B only"))
        b_ai = hb.get("X-Message-Id")
        before = usage(a)
        st, _, _ = post_chat(ca, chat_body("steal", parent_id=b_ai))
        check("09b other user's parent_id -> 404, no charge", st == 404 and usage(a) == before,
              f"{st} usage {before}->{usage(a)}")

        before = usage(a)
        st, _, _ = post_regen(ca, ai2, {"model": MODEL, "content": "   "})
        check("09c regenerate blank content -> 422, no charge", st == 422 and usage(a) == before,
              f"{st} usage {before}->{usage(a)}")

        before = usage(a)
        st, _, _ = post_regen(ca, ai1, {"model": MODEL})
        check("09d regenerate not the last message -> 409, no charge", st == 409 and usage(a) == before,
              f"{st} usage {before}->{usage(a)}")

        before = usage(a)
        st, _, _ = post_regen(ca, ai2, {"model": "not-allowed-model"})
        check("09e regenerate model not whitelisted -> 403, no charge", st == 403 and usage(a) == before,
              f"{st} usage {before}->{usage(a)}")

        # 生成中：用慢速假串流佔住一則 AI 回覆
        MODE_QUEUE.append("slow")
        slow = {}
        ready = threading.Event()

        def slow_thread():
            with client_for(ta) as c2:
                with c2.stream("POST", "/chat", json=chat_body("slow one")) as r:
                    slow["ai"] = r.headers.get("X-Message-Id")
                    ready.set()
                    r.read()

        th = threading.Thread(target=slow_thread)
        th.start()
        ready.wait(15)
        before = usage(a)
        st, _, raw = post_regen(ca, slow.get("ai") or "00000000-0000-0000-0000-000000000000",
                                {"model": MODEL})
        check("09f regenerate while still generating -> 409, no charge",
              st == 409 and usage(a) == before, f"{st} {raw[:80]} usage {before}->{usage(a)}")
        th.join(timeout=30)


def t10_rate_limit():
    """每分鐘 10 次依使用者（同 IP 兩人互不影響）；沒有 cookie → 401 且沒有額度列。"""
    reset_env(100)
    a, ta = make_user()
    b, tb = make_user()
    main.limiter.reset()
    main.limiter.enabled = True
    try:
        with client_for(ta) as ca:
            statuses = [post_chat(ca, chat_body(f"r{i}"))[0] for i in range(11)]
        check("10a A's first 10 in a minute -> 200", statuses[:10] == [200] * 10, str(statuses))
        check("10b A's 11th -> 429 from slowapi", statuses[10] == 429, str(statuses))
        with client_for(ta) as ca:
            st, _, raw = post_chat(ca, chat_body("r11"))
        check("10c slowapi 429 carries no quota code", st == 429 and "daily_quota_exceeded" not in raw
              and "code" not in raw, raw[:200])
        with client_for(tb) as cb:
            st_b, _, raw_b = post_chat(cb, chat_body("B same IP"))
        check("10d B (same IP) still 200", st_b == 200, f"{st_b} {raw_b[:120]}")
        rows_before = total_rows_today()
        with httpx.Client(base_url=BASE, timeout=30) as anon:
            st_n, _, _ = post_chat(anon, chat_body("no cookie"))
        check("10e no cookie -> 401", st_n == 401, str(st_n))
        check("10f no cookie: no daily_usage row created", total_rows_today() == rows_before,
              f"before={rows_before} after={total_rows_today()}")
    finally:
        main.limiter.enabled = False
        main.limiter.reset()


def t11_output_cap_and_provider_errors():
    """LLM 函式帶上輸出上限；供應商例外往上拋而不是變成文字。"""
    os.environ["MAX_OUTPUT_TOKENS"] = "777"
    try:
        async def consume(agen):
            return [piece async for piece in agen]

        captured_or: dict = {}

        async def fake_create(**kwargs):
            captured_or.update(kwargs)

            async def gen():
                yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="or-ok"))])
            return gen()

        with mock.patch.object(openrouter_llm.client.chat.completions, "create", fake_create):
            out = asyncio.run(consume(REAL_OPENROUTER_STREAM("hi", [], "some/model")))
        check("11a openrouter create gets max_tokens=777", captured_or.get("max_tokens") == 777,
              str(captured_or.get("max_tokens")))
        check("11b openrouter yields the chunk", out == ["or-ok"], str(out))

        captured_gem: dict = {}

        class FakeGemChat:
            async def send_message_async(self, message, **kwargs):
                captured_gem.update(kwargs)

                async def gen():
                    yield SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=["x"]))],
                                          text="gem-ok")
                return gen()

        class FakeGenModel:
            def __init__(self, model_name, *args, **kwargs):
                self.model_name = model_name

            def start_chat(self, history=None):
                return FakeGemChat()

        with mock.patch.object(gemini_llm.genai, "GenerativeModel", FakeGenModel):
            out_g = asyncio.run(consume(REAL_GEMINI_STREAM("hi", [], MODEL)))
        check("11c gemini generation_config max_output_tokens=777",
              captured_gem.get("generation_config") == {"max_output_tokens": 777}, str(captured_gem))
        check("11d gemini yields the chunk", out_g == ["gem-ok"], str(out_g))

        async def failing_create(**kwargs):
            raise RuntimeError("OR-PROVIDER-DOWN")

        raised = None
        with mock.patch.object(openrouter_llm.client.chat.completions, "create", failing_create):
            try:
                asyncio.run(consume(REAL_OPENROUTER_STREAM("hi", [], "some/model")))
            except RuntimeError as e:
                raised = str(e)
        check("11e openrouter propagates provider exception (not yielded as text)",
              raised == "OR-PROVIDER-DOWN", str(raised))

        class FailingGemChat:
            async def send_message_async(self, message, **kwargs):
                raise RuntimeError("GEM-PROVIDER-DOWN")

        class FailingGenModel(FakeGenModel):
            def start_chat(self, history=None):
                return FailingGemChat()

        raised = None
        with mock.patch.object(gemini_llm.genai, "GenerativeModel", FailingGenModel):
            try:
                asyncio.run(consume(REAL_GEMINI_STREAM("hi", [], MODEL)))
            except RuntimeError as e:
                raised = str(e)
        check("11f gemini propagates provider exception (not yielded as text)",
              raised == "GEM-PROVIDER-DOWN", str(raised))
    finally:
        os.environ["MAX_OUTPUT_TOKENS"] = "1500"


def t12_rollback():
    """扣款後、commit 前失敗 → 次數不變；對照組：正常 commit 會同時寫入扣款與訊息。"""
    reset_env(20)
    uid, _ = make_user()
    before_usage, before_msgs = usage(uid), msg_count(uid)
    failed = None
    try:
        with Session(engine) as s:
            main.charge_daily_quota(s, uid)
            s.add(Message(role="user", content="rollback probe", user_id=uid))
            with mock.patch.object(s, "commit", side_effect=RuntimeError("simulated commit failure")):
                s.commit()
    except RuntimeError as e:
        failed = str(e)
    check("12a simulated commit failure raised", failed == "simulated commit failure", str(failed))
    check("12b usage unchanged after failed commit", usage(uid) == before_usage,
          f"before={before_usage} after={usage(uid)}")
    check("12c no message row after failed commit", msg_count(uid) == before_msgs,
          f"before={before_msgs} after={msg_count(uid)}")

    with Session(engine) as s:
        main.charge_daily_quota(s, uid)
        s.add(Message(role="user", content="control", user_id=uid))
        s.commit()
    check("12d control: successful commit writes charge and message together",
          usage(uid) == before_usage + 1 and msg_count(uid) == before_msgs + 1,
          f"usage={usage(uid)} msgs={msg_count(uid)}")


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
        reset_env()
        server = start_server()
        for fn in [t01_limit_20, t02_shared_counter, t03a_sql_atomicity, t03b_http_concurrency,
                   t04_delete_no_refund, t05_taiwan_day, t06_isolation, t07_site_cap,
                   t08_refund_on_failure, t09_rejected_before_charge, t10_rate_limit,
                   t11_output_cap_and_provider_errors, t12_rollback]:
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
