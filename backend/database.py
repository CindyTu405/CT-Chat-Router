from sqlmodel import SQLModel, create_engine, Session
import os

# 從環境變數讀取連線字串 (在 docker-compose.yml 裡設定的)
# 如果讀不到，就預設用 localhost (方便你在 docker 外面測試 script)
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://user:password@localhost:5432/chat_db")

# 針對 Render/Heroku 的修正：有些平台給的網址是 postgres:// 開頭，但 SQLAlchemy 需要 postgresql://
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# 建立引擎
# echo=True 會在終端機印出所有 SQL 語法，方便 Debug
engine = create_engine(DATABASE_URL, echo=True)

# 依賴注入 (Dependency Injection) 用
# 讓 FastAPI 可以拿到資料庫連線
def get_session():
    with Session(engine) as session:
        yield session

# 初始化資料庫 (建立 Table)
def create_db_and_tables():
    SQLModel.metadata.create_all(engine)