"""
[步驟 T1] 開發用測試資料腳本（不屬於產品功能）

直接透過 DATABASE_URL 寫入資料庫，不經過 API，用来產生跨越多個日期的
[SEED] 對話，供時間軸分組（P5a）與時間軸導航列（P5b）驗收使用。

用法：
    # 一般從 repo 根目錄或 backend/ 目錄執行皆可
    python backend/dev/seed_chats.py --session-id <你的 session id>

    # session id 從瀏覽器 devtools 取得：localStorage.chat_session_id

    # 清除所有 [SEED] 開頭的測試資料（不分 session）
    python backend/dev/seed_chats.py --cleanup

說明：
- 所有标题与内容都带 `[SEED]` 前缀，--cleanup 只会删除这些资料，
  其他对话不受影响。
- 重新 seed 前会先清掉旧的 [SEED] 资料，避免重复执行累积脏数据。
- created_at 一律写入 naive UTC（与 models.py 的约定一致：
  TIMESTAMP 栏位存 UTC，aware datetime 会被 psycopg2 依 DB 时区转换而错位）。
- 每笔时间固定在 UTC 12:00 前后，避免 UTC+8 等时区下分组错位。
"""

import argparse
import calendar
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# 让脚本无论从哪个目录执行，都能 import backend 下的 models / database
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import text  # noqa: E402
from sqlmodel import Session, create_engine  # noqa: E402

from models import Message  # noqa: E402
from database import DATABASE_URL  # noqa: E402

SEED_PREFIX = "[SEED]"

# 表格名：SQLModel 预设为小写类名 "message"
TABLE = Message.__tablename__

# ---------------------------------------------------------------------------
# 测试资料规格
# ---------------------------------------------------------------------------
# 每项：(标题, 使用者问题, 助手回复, root 几天/几周前, 回复几天前(None=跟 root 同时段))
# - 前 7 笔涵盖计划要求的日期：今天、昨天、3 天前、10 天前、20 天前、2 个月前、1 年前
# - 后 2 笔是「迟回覆」情境（建立很久、最近才有 assistant 回复），
#   用来对比「依建立日期」与「依最新回覆」两种排序下时间轴位置的变化。
def _chat_specs() -> list[tuple[str, str, str, dict, dict | None]]:
    return [
        # (标题, 问题, 回复, created 偏移, reply 偏移 None=同 root)
        ("今天对话", "今天的测试问题：时间轴应显示在「今天」。",
         "今天的测试回复。", {"days": 0}, None),
        ("昨天对话", "昨天的测试问题：时间轴应显示在「昨天」。",
         "昨天的测试回复。", {"days": 1}, None),
        ("3天前对话", "3 天前的测试问题：应落在「近 7 天」。",
         "3 天前的测试回复。", {"days": 3}, None),
        ("10天前对话", "10 天前的测试问题：应落在「近 30 天」。",
         "10 天前的测试回复。", {"days": 10}, None),
        ("20天前对话", "20 天前的测试问题：应落在「近 30 天」。",
         "20 天前的测试回复。", {"days": 20}, None),
        ("2个月前对话", "2 个月前的测试问题：应落在更早的月份群。",
         "2 个月前的测试回复。", {"months": 2}, None),
        ("1年前对话", "1 年前的测试问题：应落在去年同月的月份群。",
         "1 年前的测试回复。", {"years": 1}, None),
        # 迟回覆情境 1：40 天前建立，2 天前才有回复
        ("迟回覆A-40天前建2天前回", "40 天前建立的测试问题，2 天前才回覆。",
         "迟到的测试回覆 A：依最新回覆排序应跳到「近 7 天」。",
         {"days": 40}, {"days": 2}),
        # 迟回覆情境 2：2 个月前建立，10 天前才有回复
        ("迟回覆B-2月前建10天前回", "2 个月前建立的测试问题，10 天前才回覆。",
         "迟到的测试回覆 B：依最新回覆排序应落在「近 30 天」。",
         {"months": 2}, {"days": 10}),
    ]


# ---------------------------------------------------------------------------
# 时间工具
# ---------------------------------------------------------------------------
def _shift_months(dt: datetime, months: int) -> datetime:
    """往回（months>0 表示几个月前）移动月份，处理月底日期溢出（如 3/31 → 2/28）。"""
    idx = dt.year * 12 + (dt.month - 1) - months
    year, month = divmod(idx, 12)
    month += 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _utc_noon(days: int = 0, months: int = 0, years: int = 0) -> datetime:
    """
    产生「N 天/月/年前、UTC 12:00（或 12:10）」的 naive UTC datetime。

    - 固定中午前后：UTC 12:00/12:10 在 UTC+8 是晚上 20:00/20:10，
      在 UTC-x 是凌晨，无论前端按哪个时区分组都不会跨日错位。
    - naive：与 models.py 约定一致，TIMESTAMP 栏位存 naive UTC。
    """
    now = datetime.now(timezone.utc)
    if years:
        now = _shift_months(now, years * 12)
    if months:
        now = _shift_months(now, months)
    if days:
        now = now - timedelta(days=days)
    return now.replace(tzinfo=None, hour=12, minute=0, second=0, microsecond=0)


def _offset_to_dt(spec: dict, minute: int = 0) -> datetime:
    dt = _utc_noon(
        days=spec.get("days", 0),
        months=spec.get("months", 0),
        years=spec.get("years", 0),
    )
    return dt.replace(minute=minute)


# ---------------------------------------------------------------------------
# 写入 / 清除
# ---------------------------------------------------------------------------
def seed(engine, session_id: str) -> None:
    """写入 [SEED] 测试对话（先清掉旧的，避免重复执行累积）。"""
    cleanup(engine)

    with Session(engine) as session:
        chat_count = 0
        msg_count = 0
        for title, question, answer, created_spec, reply_spec in _chat_specs():
            root_id = uuid.uuid4()
            created_at = _offset_to_dt(created_spec)

            root = Message(
                id=root_id,
                content=f"{SEED_PREFIX} {question}",
                role="user",
                title=f"{SEED_PREFIX} {title}",
                session_id=session_id,
                parent_id=None,
                model_used=None,
                created_at=created_at,
            )
            session.add(root)
            msg_count += 1

            reply_at = (
                _offset_to_dt(reply_spec, minute=10) if reply_spec
                else created_at.replace(minute=10)
            )
            reply = Message(
                id=uuid.uuid4(),
                content=f"{SEED_PREFIX} {answer}",
                role="assistant",
                title=None,
                session_id=session_id,
                parent_id=root_id,
                model_used="seed-model",
                created_at=reply_at,
            )
            session.add(reply)
            msg_count += 1
            chat_count += 1

        session.commit()
        print(f"[seed] 写入完成：{chat_count} 个对话 / {msg_count} 则訊息"
              f"（session_id={session_id}）")


def cleanup(engine) -> None:
    """
    只删除 [SEED] 开头的资料。

    为避免违反外键约束（message.parent_id → message.id），
    先删没有子节点的 [SEED] 列（assistant 回复、或孤立的 root），
    再反复删除剩余的 [SEED] 列，直到清干净。
    """
    delete_leaves = text(f"""
        WITH seed_ids AS (
            SELECT id FROM {TABLE} WHERE content LIKE :prefix || '%'
        ),
        parents AS (
            SELECT DISTINCT parent_id FROM {TABLE} WHERE parent_id IS NOT NULL
        )
        DELETE FROM {TABLE}
        WHERE id IN (SELECT id FROM seed_ids WHERE id NOT IN (SELECT parent_id FROM parents))
    """)

    count_query = text(f"""
        SELECT COUNT(*) FROM {TABLE} WHERE content LIKE :prefix || '%'
    """)

    prefix = f"{SEED_PREFIX}%"
    total = 0
    with Session(engine) as session:
        while True:
            result = session.execute(delete_leaves, {"prefix": prefix})
            deleted = result.rowcount or 0
            total += deleted
            if deleted == 0:
                break
        remaining = session.execute(count_query, {"prefix": prefix}).scalar() or 0
        session.commit()

    if total:
        print(f"[cleanup] 已删除 {total} 则 [SEED] 訊息")
    else:
        print("[cleanup] 没有 [SEED] 资料需要删除")
    if remaining:
        print(f"[cleanup] 警告：仍有 {remaining} 则 [SEED] 资料未被删除，"
              "可能存在非 [SEED] 的子节点，请手动检查。")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description="[T1] 开发用测试资料脚本：写入/清除 [SEED] 开头的跨日期对话",
    )
    parser.add_argument(
        "--session-id",
        help="要写入的 session id（浏览器 localStorage.chat_session_id）",
    )
    parser.add_argument(
        "--cleanup",
        action="store_true",
        help="只删除所有 [SEED] 开头的资料后退出（不需 session-id）",
    )
    args = parser.parse_args()

    if not args.cleanup and not args.session_id:
        parser.error("一般模式需要 --session-id；仅清除资料请使用 --cleanup")

    engine = create_engine(DATABASE_URL, echo=False)

    # 确认能连到数据库，给出友好错误信息
    try:
        with engine.connect():
            pass
    except Exception as exc:  # pragma: no cover - 仅供开发使用
        print(f"错误：无法连接数据库（DATABASE_URL={DATABASE_URL}）：{exc}",
              file=sys.stderr)
        return 1

    if args.cleanup:
        cleanup(engine)
        return 0

    seed(engine, args.session_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
