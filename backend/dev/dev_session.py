"""(S-U1-7) 本機專用：直接在 DB 建一個登入 session，印出可貼進瀏覽器 console 的 cookie 指令。

用法：cd backend && uv run python dev/dev_session.py --provider github --email me@example.com
只在 DATABASE_URL 的 host 是 localhost / 127.0.0.1 / db 時執行，否則 exit 1。
stdout 只印一行：document.cookie="session=<token>; path=/"
"""
import argparse
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

ALLOWED_HOSTS = {"localhost", "127.0.0.1", "db"}


def main() -> int:
    parser = argparse.ArgumentParser(description="建立本機開發用登入 session（只印 cookie 指令）")
    parser.add_argument("--provider", choices=["github", "google"], default="github")
    parser.add_argument("--email", default=None, help="可省略（模擬沒有 email 的帳號）")
    args = parser.parse_args()

    os.environ["SQL_ECHO"] = "false"
    from sqlmodel import Session
    from database import engine
    from auth_routes import upsert_user, create_session_token

    host = engine.url.host
    if host not in ALLOWED_HOSTS:
        print(f"拒絕執行：資料庫 host 是 {host!r}，不是本機。", file=sys.stderr)
        return 1

    # 固定 sub，同一組 provider+email 重跑會拿到同一個 user
    sub = f"dev-{args.provider}-{args.email or 'noemail'}"
    with Session(engine) as session:
        user = upsert_user(session, args.provider, sub, args.email)
        token = create_session_token(session, user)
    print(f'document.cookie="session={token}; path=/"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
