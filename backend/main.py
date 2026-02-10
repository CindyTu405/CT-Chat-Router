from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select, text
from fastapi.middleware.cors import CORSMiddleware
import uuid  # 記得匯入這個，因為 parent_id 可能是 UUID

# 自訂模組
from database import create_db_and_tables, get_session
from models import Message, ChatRequest
# from mock_llm import mock_chat_stream
from gemini_llm import gemini_chat_stream



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
    expose_headers=["X-Message-Id"],
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

def get_conversation_history(session: Session, parent_id: uuid.UUID | None) -> list[Message]:
    """
    從給定的 parent_id 開始，一路往上找祖先，直到根節點。
    回傳順序：[最舊的訊息, ..., 最新的父訊息]
    """
    history = []
    current_id = parent_id

    # 使用 while 迴圈一路往回查 (Linked List Traversal)
    while current_id:
        # 從 DB 撈出這則訊息
        msg = session.get(Message, current_id)
        if not msg:
            break  # 找不到就斷掉（預防萬一）

        history.append(msg)
        current_id = msg.parent_id  # 往上找爸爸

    # 因為我們是從下往上找，所以列表現在是 [子, 父, 爺]
    # 但 AI 需要的是 [爺, 父, 子]，所以要反轉
    history.reverse()

    return history

@app.post("/chat")
async def chat_endpoint(request: ChatRequest, session: Session = Depends(get_session)):
    """
    核心對話 API
    """
    # 1. 先撈出歷史紀錄
    history = get_conversation_history(session, request.parent_id)
    # Debug 用：印出歷史紀錄長度
    print(f"📚 讀取到 {len(history)} 則歷史訊息")

    # 2. 存入 User 訊息
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

    # 3. 定義串流產生器
    async def stream_generator():
        full_response = ""

        # 開始模擬 AI 吐字; 呼叫 Mock AI 時傳入 history
        # async for chunk in mock_chat_stream(request.message, history):
        async for chunk in gemini_chat_stream(request.message, history, request.model):
            full_response += chunk
            yield chunk

        # 4. 串流結束，開始存檔
        print("串流結束，準備呼叫存檔函式...")
        save_ai_message_sync(full_response, user_msg.id, request.model)

    return StreamingResponse(stream_generator(),
                             media_type="text/plain",
                             headers={"X-Message-Id": str(user_msg.id)}
                             )

@app.get("/chats/roots", response_model=list[Message])
def get_chat_roots(session: Session = Depends(get_session)):
    """
    取得所有「對話開頭」 (Root Messages)
    用來顯示在側邊欄列表
    """
    # 1. 條件：parent_id 必須是 None
    # 2. 排序：最新的在最上面 (created_at desc)
    statement = select(Message).where(Message.parent_id == None).order_by(Message.created_at.desc())
    return session.exec(statement).all()

@app.get("/chats/{root_id}/history", response_model=list[Message])
def get_chat_history(root_id: uuid.UUID, session: Session = Depends(get_session)):
    """
    遞迴查詢：給定一個開頭 (Root ID)，找出所有相關的後續對話
    """
    # 使用 PostgreSQL 的 CTE (Common Table Expression) 進行遞迴
    # 這段 SQL 的意思是：
    # 1. 先抓出頭 (root)
    # 2. 再找出 parent_id 等於上一層 ID 的人 (children)
    # 3. 一直找下去，直到沒人為止
    query = text("""
    WITH RECURSIVE chat_tree AS (
        SELECT * FROM message WHERE id = :root_id
        UNION ALL
        SELECT m.* FROM message m
        JOIN chat_tree ct ON m.parent_id = ct.id
    )
    SELECT * FROM chat_tree ORDER BY created_at ASC;
    """)

    # 執行原始 SQL
    results = session.exec(query, params={"root_id": root_id}).all()
    return results