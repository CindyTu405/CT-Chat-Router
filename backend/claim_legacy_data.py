"""(S-U1-5) 認領舊資料：把 user_id 為 NULL 的訊息與分支指定給某位使用者。

用法（在 backend/ 執行，api 容器內也可）：
  python claim_legacy_data.py --provider github --email me@example.com --session-id <sid> [--session-id <sid2>]
      試算（預設）：印出數字，rollback，不寫入。
  ... --apply                          寫入。
  ... --apply --delete-ownerless-branches
      另外刪除 user_id、anchor_message_id、root_message_id、attach_root_id 全為 NULL 的分支
      （查不到擁有者）。注意：這個旗標作用於整個資料庫的此類分支。

結束碼：0 成功；1 使用者找不到或多於一位；2 參數錯誤；3 父子或分支擁有者不一致（已 rollback）。
邏輯都在 claim()，它不 commit；commit / rollback 由 CLI 決定。冪等：重跑認領數為 0。
"""
import argparse
import sys
import uuid
from typing import Optional

from sqlalchemy import text as sa_text, update
from sqlmodel import Session, select

from database import engine
from models import Branch, Message, User

engine.echo = False


def _owner_of(session: Session, message_id) -> Optional[uuid.UUID]:
    if message_id is None:
        return None
    m = session.get(Message, message_id)
    return m.user_id if m is not None else None


def _count_integrity(session: Session, target_id) -> dict:
    parent_child = session.execute(sa_text(
        "SELECT count(*) FROM message c JOIN message p ON c.parent_id = p.id "
        "WHERE c.user_id IS NOT NULL AND p.user_id IS NOT NULL AND c.user_id <> p.user_id"
    )).scalar()
    branch_msg = session.execute(sa_text(
        "SELECT count(*) FROM branch b JOIN message m "
        "ON m.id = b.anchor_message_id OR m.id = b.root_message_id "
        "WHERE b.user_id = :t AND m.user_id IS NOT NULL AND m.user_id <> b.user_id"
    ), {"t": target_id}).scalar()
    return {"parent_child_mismatch": int(parent_child), "branch_message_mismatch": int(branch_msg)}


def claim(session: Session, user: User, session_ids: list, delete_ownerless: bool = False,
          only_branch_ids=None) -> dict:
    """在傳入的 session 內認領資料，不 commit。回傳統計 dict。

    only_branch_ids：只限制「刪除」的範圍（測試用）；None = 不限制。
    """
    # 1. 訊息
    res = session.execute(
        update(Message)
        .where(Message.session_id.in_(session_ids), Message.user_id.is_(None))
        .values(user_id=user.id)
    )
    msgs_claimed = res.rowcount
    session.flush()

    # 2. 分支：依 錨點 → 首則 → attach_root 訊息的 user_id；只有等於本次使用者才設定
    branches_claimed = 0
    for b in session.exec(select(Branch).where(Branch.user_id.is_(None))).all():
        candidate = None
        for mid in (b.anchor_message_id, b.root_message_id, b.attach_root_id):
            candidate = _owner_of(session, mid)
            if candidate is not None:
                break
        if candidate == user.id:
            b.user_id = user.id
            session.add(b)
            branches_claimed += 1
    session.flush()

    # 刪除：三個來源都是 NULL 的分支（仍被訊息或子分支參照者跳過，避免 FK 錯誤）
    deleted = 0
    skipped_referenced = 0
    if delete_ownerless:
        q = select(Branch).where(
            Branch.user_id.is_(None),
            Branch.anchor_message_id.is_(None),
            Branch.root_message_id.is_(None),
            Branch.attach_root_id.is_(None),
        )
        if only_branch_ids is not None:
            q = q.where(Branch.id.in_(list(only_branch_ids)))
        for b in session.exec(q).all():
            ref_msg = session.exec(select(Message.id).where(Message.branch_id == b.id).limit(1)).first()
            ref_child = session.exec(select(Branch.id).where(Branch.parent_branch_id == b.id).limit(1)).first()
            if ref_msg is not None or ref_child is not None:
                skipped_referenced += 1
                continue
            session.delete(b)
            deleted += 1
        session.flush()

    # 3. 一致性
    integrity = _count_integrity(session, user.id)

    # 4. 剩餘
    null_by_session = session.execute(sa_text(
        "SELECT session_id, count(*) FROM message WHERE user_id IS NULL GROUP BY session_id ORDER BY session_id"
    )).all()
    branches_null = session.execute(sa_text("SELECT count(*) FROM branch WHERE user_id IS NULL")).scalar()
    branches_ownerless = session.execute(sa_text(
        "SELECT count(*) FROM branch WHERE user_id IS NULL AND anchor_message_id IS NULL "
        "AND root_message_id IS NULL AND attach_root_id IS NULL"
    )).scalar()
    return {
        "messages_claimed": msgs_claimed,
        "branches_claimed": branches_claimed,
        "messages_null_by_session": [(sid, int(n)) for sid, n in null_by_session],
        "branches_null": int(branches_null),
        "branches_ownerless": int(branches_ownerless),
        "ownerless_deleted": deleted,
        "ownerless_skipped_referenced": skipped_referenced,
        "integrity": integrity,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Claim legacy (user_id NULL) data for one user.")
    p.add_argument("--provider", required=True)
    p.add_argument("--email", required=True)
    p.add_argument("--session-id", dest="session_ids", action="append", required=True)
    p.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    p.add_argument("--delete-ownerless-branches", action="store_true",
                   help="requires --apply; delete NULL-owner branches with no anchor/root/attach_root")
    args = p.parse_args(argv)
    if args.delete_ownerless_branches and not args.apply:
        p.error("--delete-ownerless-branches requires --apply")  # exits 2

    with Session(engine) as session:
        users = session.exec(select(User).where(
            User.oauth_provider == args.provider, User.email == args.email)).all()
        if len(users) != 1:
            print(f"error: expected exactly one user for provider={args.provider!r} email={args.email!r}, "
                  f"found {len(users)}", file=sys.stderr)
            return 1
        user = users[0]
        try:
            r = claim(session, user, args.session_ids, args.delete_ownerless_branches)
        except Exception:
            session.rollback()
            raise
        integ = r["integrity"]
        if integ["parent_child_mismatch"] or integ["branch_message_mismatch"]:
            session.rollback()
            print(f"INTEGRITY FAIL: parent/child user_id mismatches={integ['parent_child_mismatch']}, "
                  f"branches owned by target with message owned by another user="
                  f"{integ['branch_message_mismatch']}. Rolled back.")
            return 3

        print(f"session ids: {', '.join(args.session_ids)}")
        print(f"messages claimed: {r['messages_claimed']}")
        print(f"branches claimed: {r['branches_claimed']}")
        print("messages still NULL by session_id:")
        if not r["messages_null_by_session"]:
            print("  (none)")
        for sid, n in r["messages_null_by_session"]:
            print(f"  {sid}: {n}")
        print(f"branches still NULL: {r['branches_null']}")
        print(f"  of which ownerless (anchor/root/attach_root all NULL): {r['branches_ownerless']}")
        print(f"ownerless branches deleted: {r['ownerless_deleted']}")
        if r["ownerless_skipped_referenced"]:
            print(f"ownerless branches skipped (still referenced): {r['ownerless_skipped_referenced']}")

        if args.apply:
            session.commit()
            print("APPLIED")
        else:
            session.rollback()
            print("DRY RUN: no changes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
