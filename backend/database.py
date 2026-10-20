from sqlmodel import create_engine, Session
import os
from urllib.parse import quote

from dotenv import load_dotenv

# 從環境變數讀取連線字串 (在 docker-compose.yml / 部署平台設定的)
# 讀不到就退回讀 repo 根目錄的 .env (backend/ 的上一層)，用裡面的 POSTGRES_* 變數組出連線字串。
# 這裡刻意不寫死任何帳號密碼：憑證只放在環境變數或 .env，不跟著程式碼進 git。
_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")


def _build_database_url() -> str:
    """取得 DATABASE_URL，優先序：環境變數 -> 根目錄 .env 的 POSTGRES_* -> 失敗就 raise。"""
    database_url = (os.getenv("DATABASE_URL") or "").strip()

    if not database_url:
        # 缺 DATABASE_URL 時才載入 .env；override=False 讓已存在的環境變數優先
        load_dotenv(_ENV_PATH, override=False)
        database_url = (os.getenv("DATABASE_URL") or "").strip()

    if not database_url:
        user = (os.getenv("POSTGRES_USER") or "").strip()
        password = (os.getenv("POSTGRES_PASSWORD") or "").strip()
        db_name = (os.getenv("POSTGRES_DB") or "").strip()

        if not password:
            raise RuntimeError(
                "缺少 DATABASE_URL 且 .env 沒有 POSTGRES_PASSWORD："
                f"請設定環境變數 DATABASE_URL，或在 {os.path.abspath(_ENV_PATH)} "
                "提供 POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB。"
            )

        # 帳密做 URL encode，避免密碼含特殊字元時把連線字串解析壞掉
        database_url = (
            f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}"
            f"@localhost:5432/{quote(db_name, safe='')}"
        )

    # 針對 Render/Heroku 的修正：有些平台給的網址是 postgres:// 開頭，但 SQLAlchemy 需要 postgresql://
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql://", 1)

    return database_url


DATABASE_URL = _build_database_url()

# 建立引擎
# echo=True 會在終端機印出所有 SQL 語法，方便 Debug
engine = create_engine(DATABASE_URL, echo=True)

# 依賴注入 (Dependency Injection) 用
# 讓 FastAPI 可以拿到資料庫連線
def get_session():
    with Session(engine) as session:
        yield session
