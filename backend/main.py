from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException
from sqlmodel import Session, select

# 自訂模組
from database import create_db_and_tables, get_session
from models import Message, ChatRequest


# 1. Lifespan (生命週期管理器)
# 這是 FastAPI 新版標準寫法：在 Server 啟動前做什麼，關閉後做什麼
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("正在檢查並建立資料庫 Table...")
    create_db_and_tables()  # 啟動時建立 Table
    yield
    print("伺服器關閉中...")


# 初始化 FastAPI，並掛載 lifespan
app = FastAPI(lifespan=lifespan)


@app.get("/")
def read_root():
    return {"status": "ok", "message": "Chat API is running"}


# 2. 新增訊息 API (模擬使用者發話)
@app.post("/messages", response_model=Message)
def create_message(request: ChatRequest, session: Session = Depends(get_session)):
    """
    接收使用者的訊息，並存入資料庫
    """
    # 將 Pydantic (ChatRequest) 轉成 SQLModel (Message)
    user_message = Message(
        content=request.message,
        role="user",
        parent_id=request.parent_id,
        model_used=request.model
    )

    # 存入資料庫
    session.add(user_message)
    session.commit()
    session.refresh(user_message)  # 重新整理，取得 DB 生成的 ID 和 created_at

    return user_message


# 3. 讀取所有訊息 API (暫時用來檢查)
@app.get("/messages", response_model=list[Message])
def read_messages(session: Session = Depends(get_session)):
    messages = session.exec(select(Message)).all()
    return messages