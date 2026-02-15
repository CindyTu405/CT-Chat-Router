from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select, text
from fastapi.middleware.cors import CORSMiddleware
import uuid

# 自訂模組
from database import create_db_and_tables, get_session
from models import Message, ChatRequest, UpdateTitleRequest
# from mock_llm import mock_chat_stream
from gemini_llm import gemini_chat_stream
from openrouter_llm import openrouter_chat_stream



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
    # ★★★ 修正補上：先取得歷史對話紀錄 ★★★
    # 這行是為了讓後面的 gemini_chat_stream / openrouter_chat_stream 有 history 可以用
    history = get_conversation_history(session, request.parent_id)

    # 1. 先存使用者的訊息 (User Message)
    user_msg = Message(role="user", content=request.message, parent_id=request.parent_id)
    session.add(user_msg)
    session.commit()
    session.refresh(user_msg)

    # 2. 立刻建立 AI 訊息 (佔位)
    # 先存一個空字串，目的是為了馬上拿到 ID，確保連結不斷裂
    ai_msg = Message(
        role="assistant", 
        content="",  # 先留空，等串流完再補
        parent_id=user_msg.id, 
        model_used=request.model
    )
    session.add(ai_msg)
    session.commit()
    session.refresh(ai_msg) # 拿到真正的 UUID 了！

    # 定義串流產生器
    async def stream_generator():
        full_response = ""
        
        # 交通警察邏輯
        # 注意：這裡使用的 history 變數，就是最上面撈出來的那個
        if request.model.startswith("gemini"):
            stream = gemini_chat_stream(request.message, history, request.model)
        else:
            stream = openrouter_chat_stream(request.message, history, request.model)

        # 開始串流
        async for chunk in stream:
            full_response += chunk
            yield chunk

        # 3. 串流結束後，更新內容 (Update)
        # 這裡直接用原本的 session 進行更新
        try:
            ai_msg.content = full_response
            session.add(ai_msg)
            session.commit()
            # print(f"✅ AI 訊息已更新內容，ID: {ai_msg.id}")
        except Exception as e:
            print(f"❌ 存檔失敗: {e}")

    # 4. 回傳 Response，這時候 headers 裡已經有真正的 ID 了！
    return StreamingResponse(
        stream_generator(), 
        media_type="text/plain",
        headers={"X-Message-Id": str(ai_msg.id)} 
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
    修改版 v3：加入 mappings() 確保欄位對應正確
    """
    
    # 1. 找出最新的一則訊息 ID (Leaf Node)
    latest_msg_query = text("""
    WITH RECURSIVE chat_descendants AS (
        SELECT id, created_at FROM message WHERE id = :root_id
        UNION ALL
        SELECT m.id, m.created_at FROM message m
        JOIN chat_descendants cd ON m.parent_id = cd.id
    )
    SELECT id FROM chat_descendants ORDER BY created_at DESC LIMIT 1;
    """)
    
    # 執行並取得第一筆結果 (Row)
    row = session.exec(latest_msg_query, params={"root_id": root_id}).first()
    
    if not row:
        return []
    
    # 從 Tuple 取出 ID
    latest_id = row[0]

    # 2. 從最新訊息往上找祖先 (Recursive Upwards)
    # ★★★ 重點：這裡要選出所有欄位，確保回傳完整 ★★★
    path_query = text("""
    WITH RECURSIVE chat_path AS (
        SELECT id, role, content, model_used, created_at, parent_id, title
        FROM message WHERE id = :latest_id
        UNION ALL
        SELECT m.id, m.role, m.content, m.model_used, m.created_at, m.parent_id, m.title 
        FROM message m
        JOIN chat_path cp ON cp.parent_id = m.id
    )
    SELECT * FROM chat_path ORDER BY created_at ASC;
    """)
    
    # ★★★ 關鍵修正：加上 .mappings() ★★★
    # 這會將 SQL 結果轉為字典列表，FastAPI 才能正確轉換成 JSON
    results = session.exec(path_query, params={"latest_id": latest_id}).mappings().all()
    
    return results

# ★★★ 功能 1: 修改對話標題 ★★★
@app.patch("/chats/{root_id}/title")
def update_chat_title(root_id: uuid.UUID, request: UpdateTitleRequest, session: Session = Depends(get_session)):
    msg = session.get(Message, root_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Chat not found")
    
    msg.title = request.title
    session.add(msg)
    session.commit()
    session.refresh(msg)
    return {"status": "ok", "title": msg.title}

# ★★★ 功能 2: 刪除對話串 ★★★
@app.delete("/chats/{root_id}")
def delete_chat(root_id: uuid.UUID, session: Session = Depends(get_session)):
    """
    刪除整串對話 (終極修正版：Depth-First Deletion)
    策略：計算每一則訊息的「層級 (Level)」，從最深層的葉子節點開始刪除。
    這能完美解決 Foreign Key Constraint 問題，不管有沒有分支或改名。
    """
    
    # 1. 使用遞迴查詢找出所有子孫，並計算「層級 (level)」
    # Root 的 level = 0, 子 = 1, 孫 = 2 ...
    query = text("""
    WITH RECURSIVE chat_descendants AS (
        SELECT id, 0 as level FROM message WHERE id = :root_id
        UNION ALL
        SELECT m.id, cd.level + 1 FROM message m
        JOIN chat_descendants cd ON m.parent_id = cd.id
    )
    SELECT id FROM chat_descendants ORDER BY level DESC;
    """)
    
    # 執行查詢
    results = session.exec(query, params={"root_id": root_id}).all()
    all_ids = [r[0] for r in results]
    
    if not all_ids:
        raise HTTPException(status_code=404, detail="Chat not found")

    # 2. 依照算出來的順序 (由深到淺) 逐一刪除
    # 這裡我們直接對每個 ID 執行刪除指令，確保順序絕對正確
    for msg_id in all_ids:
        msg = session.get(Message, msg_id)
        if msg:
            session.delete(msg)
            # 這裡可以選擇是否每刪一個就 flush，但通常全部標記完再一次 commit 即可
            # SQLAlchemy 會盡量安排順序，但我們手動餵給它的順序已經是安全的了
    
    try:
        session.commit()
    except Exception as e:
        # 如果還是失敗，可能是資料庫鎖定或其他問題
        print(f"刪除失敗細節: {e}")
        raise HTTPException(status_code=500, detail=f"刪除失敗: {str(e)}")
        
    return {"status": "ok", "deleted_count": len(all_ids)}