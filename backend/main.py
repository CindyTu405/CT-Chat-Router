from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select
from fastapi.middleware.cors import CORSMiddleware
import uuid  # 記得匯入這個，因為 parent_id 可能是 UUID

# 自訂模組
from database import create_db_and_tables, get_session
from models import Message, ChatRequest
from mock_llm import mock_chat_stream


# 1. Lifespan (生命週期管理器)
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("正在檢查並建立資料庫 Table...")
    create_db_and_tables()
    yield
    print("伺服器關閉中...")


app = FastAPI(lifespan=lifespan)

# CORS 設定
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {"status": "ok", "message": "Chat API is running"}


# 讀取所有訊息 (檢查用)
@app.get("/messages", response_model=list[Message])
def read_messages(session: Session = Depends(get_session)):
    messages = session.exec(select(Message)).all()
    return messages


# --- 關鍵修正區 ---

# 修正 1: 這裡改用 def (同步函式)，去掉 async
# 因為我們的 Session 是同步的，這樣寫最穩
def save_ai_message_sync(content: str, parent_id: uuid.UUID, model: str):
    print(f"🔄 開始執行存檔: {content[:10]}...")  # Debug 用

    # 這裡必須重新 import engine，因為要在新的 Session 運作
    from database import engine
    try:
        with Session(engine) as session:
            ai_msg = Message(
                content=content,
                role="assistant",
                parent_id=parent_id,
                model_used=model
            )
            session.add(ai_msg)
            session.commit()
            print(f"✅ AI 回應已存檔，ID: {ai_msg.id}")
    except Exception as e:
        print(f"❌ 存檔失敗: {e}")


@app.post("/chat")
async def chat_endpoint(request: ChatRequest, session: Session = Depends(get_session)):
    """
    核心對話 API
    """
    # 1. 存入 User 訊息
    print("收到使用者訊息，正在存入 DB...")
    user_msg = Message(
        content=request.message,
        role="user",
        parent_id=request.parent_id,
        model_used=request.model
    )
    session.add(user_msg)
    session.commit()
    session.refresh(user_msg)
    print(f"User 訊息已存入，ID: {user_msg.id}")

    # 2. 定義串流產生器
    async def stream_generator():
        full_response = ""

        # 開始模擬 AI 吐字
        async for chunk in mock_chat_stream(request.message):
            full_response += chunk
            yield chunk

        # 3. 串流結束，開始存檔
        print("串流結束，準備呼叫存檔函式...")

        # 修正 2: 因為上面改成 def 了，這裡直接呼叫即可 (不用 await)
        save_ai_message_sync(full_response, user_msg.id, request.model)

    return StreamingResponse(stream_generator(), media_type="text/plain")