from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select
from fastapi.middleware.cors import CORSMiddleware

# 自訂模組
from database import create_db_and_tables, get_session
from models import Message, ChatRequest
from mock_llm import mock_chat_stream


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # "*" 代表允許任何來源連線 (開發階段方便，正式上線建議改特定網址)
    allow_credentials=True,
    allow_methods=["*"],  # 允許所有 HTTP 方法 (GET, POST, OPTIONS...)
    allow_headers=["*"],  # 允許所有 Headers
)


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


@app.post("/chat")
async def chat_endpoint(request: ChatRequest, session: Session = Depends(get_session)):
    """
    核心對話 API：
    1. 儲存使用者訊息
    2. 串流回傳 AI 模擬回應
    3. (在串流結束後) 儲存 AI 訊息
    """

    # --- Step 1: 存入 User 訊息 ---
    user_msg = Message(
        content=request.message,
        role="user",
        parent_id=request.parent_id,
        model_used=request.model
    )
    session.add(user_msg)
    session.commit()
    session.refresh(user_msg)

    # 取得 user_msg.id 作為接下來 AI 訊息的 parent_id
    current_parent_id = user_msg.id

    # --- Step 2: 定義一個 Generator 函式來處理串流與存檔 ---
    async def stream_and_save():
        full_ai_response = ""

        # 呼叫模擬 AI，開始取得字串流
        async for chunk in mock_chat_stream(request.message):
            full_ai_response += chunk  # 收集完整的字串以便存檔
            yield chunk  # 即時傳送給前端

        # --- Step 3: 串流結束後，存入 AI 訊息 ---
        # 注意：這裡是在 Generator 內部，等全部吐完才存檔
        # 因為 session 不能跨 thread 使用，這裡我們要小心 (但在簡單場景下，FastAPI 的 Depends 會處理)
        # 為了安全起見，我們通常建議在 real-world 使用獨立的 DB 操作，但這裡先簡單做

        print(f"AI 回答完畢，正在存檔: {full_ai_response}")

        # 這裡需要一個新的 session 或者確保舊的還能用
        # 簡單起見，我們重新建立一個臨時的 Message 物件 (實際存檔邏輯通常會更複雜)
        # 由於 generator 執行時 session 可能已經關閉，
        # 在正式專案中我們會用 BackgroundTasks，但這裡為了展示串流，我們先只做「輸出」。

        # *** 重要教學點 ***
        # 在 StreamingResponse 中操作資料庫比較進階，
        # 為了讓你先看到效果，我們先「只做串流顯示」，
        # 存檔部分我會在下一步教你用 BackgroundTasks 來完美解決。

    return StreamingResponse(stream_and_save(), media_type="text/plain")


def save_ai_message(content: str, parent_id: str, model: str):
    # 因為背景任務是在 Request 結束後執行，我們需要一個新的 Session
    # 這裡我們手動建立 Session，用完就關掉
    from database import engine
    with Session(engine) as session:
        ai_msg = Message(
            content=content,
            role="assistant",
            parent_id=parent_id,
            model_used=model
        )
        session.add(ai_msg)
        session.commit()
        print(f"✅ [背景任務] AI 回應已存檔，ID: {ai_msg.id}")


@app.post("/chat")
async def chat_endpoint(
        request: ChatRequest,
        background_tasks: BackgroundTasks,  # <--- 注入背景任務管理器
        session: Session = Depends(get_session)
):
    # 1. 存入 User 訊息
    user_msg = Message(
        content=request.message,
        role="user",
        parent_id=request.parent_id,
        model_used=request.model
    )
    session.add(user_msg)
    session.commit()
    session.refresh(user_msg)

    # 2. 定義串流產生器 (只負責吐字，不負責存檔)
    async def stream_generator():
        full_response = ""
        async for chunk in mock_chat_stream(request.message):
            full_response += chunk
            yield chunk

        # 3. 串流結束時，把完整的字串交給背景任務去存檔
        # 注意：我們把「要存什麼」傳給背景任務，而不是在這邊直接存
        background_tasks.add_task(
            save_ai_message,
            content=full_response,
            parent_id=user_msg.id,
            model=request.model
        )

    return StreamingResponse(stream_generator(), media_type="text/plain")