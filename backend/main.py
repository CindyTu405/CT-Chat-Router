from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, BackgroundTasks, Request
from fastapi.responses import StreamingResponse
import asyncio
from types import SimpleNamespace
from sqlmodel import Session, select, text
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
import os
import uuid
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# 自訂模組
from database import get_session, engine
from auth_routes import router as auth_router
from models import (
    Message,
    ChatRequest,
    UpdateTitleRequest,
    MessageWithActivity,
    FreeModelsCache,
    Branch,
    CreateBranchRequest,
    to_utc_iso,
)
# from mock_llm import mock_chat_stream
from gemini_llm import gemini_chat_stream
from openrouter_llm import openrouter_chat_stream
from scraper import get_free_models



# (P3b-A1) 進行中 / 已完成的 AI 回覆緩衝。key = AI 訊息 id（str），value = {"text", "done"}。
# 生成在獨立的 asyncio task 裡跑，不綁 HTTP 連線；切走對話或斷線不會停止生成。
# 注意：只存在程序記憶體，後端重啟即遺失（D：接受遺失）。
GENERATIONS: dict[str, dict] = {}


async def run_generation(ai_msg_id: str, message: str, history: list, model: str):
    """背景執行一次 AI 生成：邊收 chunk 邊寫入緩衝，完成後寫回 DB。"""
    buf = GENERATIONS[ai_msg_id]
    try:
        if model.startswith("gemini"):
            stream = gemini_chat_stream(message, history, model)
        else:
            stream = openrouter_chat_stream(message, history, model)
        async for chunk in stream:
            buf["text"] += chunk
    except Exception as e:
        buf["text"] += f"\n\n⚠️ 生成中斷：{e}"
    finally:
        buf["done"] = True
        # 用獨立 session 寫回，避免依賴請求的 session 生命週期
        with Session(engine) as db_session:
            msg = db_session.get(Message, uuid.UUID(ai_msg_id))
            if msg:
                msg.content = buf["text"]
                db_session.add(msg)
                db_session.commit()
        # 寫入完成後保留緩衝一小段時間，讓正在續讀的前端能讀到 done
        await asyncio.sleep(60)
        GENERATIONS.pop(ai_msg_id, None)


# 1. Lifespan (生命週期管理器)
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 資料表一律由 Alembic 管理（alembic upgrade head），啟動時不再自動 create_all。
    yield
    print("伺服器關閉中...")


app = FastAPI(lifespan=lifespan)

# 2. Rate limit (slowapi)：以來源 IP 為 key。
# /chat 會觸發付費 LLM 呼叫，限制每分鐘 10 次，避免被刷。
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS 設定：只允許白名單來源（環境變數 CORS_ORIGINS，逗號分隔）。
# 不可用 "*"：allow_credentials=True 時萬用 origin 會讓任何網站帶著 cookie 呼叫 API。
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS", "http://localhost:5173,http://localhost:8000"
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Message-Id", "X-User-Message-Id"],
)

# 模型白名單（免費 tier）：環境變數 ALLOWED_MODELS，逗號分隔。
# 支援 `prefix*` 前綴匹配（例如 "gemini*" 允許所有 gemini 開頭的模型），其餘為精確比對。
# 目的：避免使用者填入任意 OpenRouter 付費 model ID，燒掉平台金鑰。
ALLOWED_MODELS = [m.strip() for m in os.getenv("ALLOWED_MODELS", "gemini*").split(",") if m.strip()]

def is_model_allowed(model: str, session: Session | None = None) -> bool:
    for entry in ALLOWED_MODELS:
        if entry.endswith("*"):
            if model.startswith(entry[:-1]):
                return True
        elif model == entry:
            return True

    # 環境變數白名單沒中，再查 OpenRouter 免費模型清單（動態，由 scraper 快取）。
    # 這段包 try/except：快取/網路出問題時只是「少允許一些模型」，
    # 絕不能讓白名單本身拋錯（否則整個 chat 端點 500）。
    if session is not None:
        try:
            for item in get_free_models(session):
                if isinstance(item, dict) and item.get("id") == model:
                    return True
        except Exception as e:
            print(f"[whitelist] 取得免費模型清單失敗，忽略: {e}")

    return False

# authlib 的 authorize_redirect 需要 session 存 OAuth state（CSRF 防護）。
# 生產環境務必用環境變數覆寫 SESSION_SECRET_KEY。
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SESSION_SECRET_KEY", "dev-secret-change-me"),
)

# OAuth 登入 / 回呼 / 登出
app.include_router(auth_router)


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
@limiter.limit("10/minute")
async def chat_endpoint(payload: ChatRequest, request: Request, session: Session = Depends(get_session)):
    # 0. 模型白名單檢查（免費 tier）：必須在任何寫入 DB / 呼叫 LLM 之前就擋掉，
    #    否則會留下沒有回覆的孤兒訊息；而且串流一旦開始就無法再回 403。
    if not is_model_allowed(payload.model, session):
        raise HTTPException(status_code=403, detail=f"Model '{payload.model}' is not allowed on this plan")

    # ★★★ 修正補上：先取得歷史對話紀錄 ★★★
    # 這行是為了讓後面的 gemini_chat_stream / openrouter_chat_stream 有 history 可以用
    history = get_conversation_history(session, payload.parent_id)

    # 1. 先存使用者的訊息 (User Message)
    user_msg = Message(role="user", content=payload.message, parent_id=payload.parent_id, session_id=payload.session_id,
                       branch_id=payload.branch_id, anchor_message_id=payload.anchor_message_id)
    session.add(user_msg)
    session.commit()
    session.refresh(user_msg)

    # (P2-9) 分支的第一則訊息要回填成該分支的 root_message_id：
    # 建立分支時不再預先塞一則 user 訊息，root 等使用者真的送出第一句話才綁定。
    if payload.branch_id:
        branch = session.get(Branch, payload.branch_id)
        if branch and branch.root_message_id is None:
            branch.root_message_id = user_msg.id
            session.add(branch)
            session.commit()

    if payload.parent_id and len(history) > 0:
        # 看看這個「爸爸」現在有幾個「小孩 (回覆)」了
        children = session.exec(select(Message.id).where(Message.parent_id == payload.parent_id)).all()
        
        # 如果小孩數量 > 1，代表這是一個分支操作！
        if len(children) > 1:
            root_node = history[0]  # history 的第一個元素剛好就是整棵樹的根節點 (Root)
            
            # 如果還沒被標記過，就把它標記為 True 並存檔
            if not root_node.has_branch:
                # 因為 root_node 已經在 session 裡了，所以直接改屬性再 commit 即可
                root_node.has_branch = True
                session.add(root_node)
                session.commit()

    # 2. 立刻建立 AI 訊息 (佔位)
    # 先存一個空字串，目的是為了馬上拿到 ID，確保連結不斷裂
    ai_msg = Message(
        role="assistant", 
        content="",  # 先留空，等串流完再補
        parent_id=user_msg.id, 
        model_used=payload.model,
        session_id=payload.session_id,
        branch_id=payload.branch_id  # 跟隨 user_msg 的分支（不回填 anchor）
    )
    session.add(ai_msg)
    session.commit()
    session.refresh(ai_msg) # 拿到真正的 UUID 了！

    # (P3b-A1) 生成交給背景 task；連線只負責讀緩衝。
    ai_id = str(ai_msg.id)
    GENERATIONS[ai_id] = {"text": "", "done": False}
    # 背景 task 不能拿請求 session 的 ORM 物件（commit 後會過期），先轉成純資料
    history_plain = [SimpleNamespace(role=m.role, content=m.content) for m in history]
    asyncio.create_task(run_generation(ai_id, payload.message, history_plain, payload.model))

    async def stream_generator():
        # 用續讀端點的同一套邏輯：從 0 開始讀到 done
        async for piece in _read_buffer(ai_id, 0):
            yield piece

    # 4. 回傳 Response，這時候 headers 裡已經有真正的 ID 了！
    return StreamingResponse(
        stream_generator(),
        media_type="text/plain",
        headers={"X-Message-Id": ai_id,
                "X-User-Message-Id": str(user_msg.id),  # 讓前端把樂觀顯示的 user 訊息補上真 id
                "X-Accel-Buffering": "no",      # ★ 叫 Nginx 絕對不要緩衝
                "Cache-Control": "no-cache",    # ★ 不要快取
                "Connection": "keep-alive"      # ★ 保持連線開啟
                }
    )


async def _read_buffer(ai_id: str, offset: int):
    """(P3b-A2) 從緩衝的 offset 位置開始吐新文字，直到 done。緩衝不存在則結束。
    offset 以「字元」計，與前端 aiResponseText.length 對齊。"""
    while True:
        buf = GENERATIONS.get(ai_id)
        if buf is None:
            return
        text = buf["text"]
        if len(text) > offset:
            yield text[offset:]
            offset = len(text)
        if buf["done"]:
            return
        await asyncio.sleep(0.1)


@app.get("/messages/{message_id}/stream")
async def stream_message(message_id: str, offset: int = 0, session: Session = Depends(get_session)):
    """(P3b-A2) 續讀一則 AI 回覆：回傳從 offset 之後的新文字。
    - 生成中：會持續等待直到完成（切回對話時用來接續顯示）。
    - 已完成（緩衝已清掉）：直接從 DB 回傳 offset 之後的內容。
    - 找不到：404。"""
    try:
        uuid.UUID(message_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found")

    if message_id in GENERATIONS:
        return StreamingResponse(_read_buffer(message_id, max(offset, 0)), media_type="text/plain",
                                 headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})

    msg = session.get(Message, uuid.UUID(message_id))
    if not msg or msg.role != "assistant":
        raise HTTPException(status_code=404, detail="not found")
    return StreamingResponse(iter([msg.content[max(offset, 0):]]), media_type="text/plain",
                             headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})

@app.get("/chats/roots", response_model=list[MessageWithActivity])
def get_chat_roots(session_id: str, sort_by: str = "updated", session: Session = Depends(get_session)):
    """
    取得側邊欄列表，支援兩種排序：
    1. created: 依建立日期排序 (舊版預設)
    2. updated: 依最後活躍時間排序 (尋找該對話樹中最新的訊息時間)
    """
    if sort_by == "created":
        # 簡單模式：只看根節點的建立時間
        statement = select(Message).where(
            Message.parent_id == None,
            Message.session_id == session_id
        ).order_by(Message.created_at.desc())
        return session.exec(statement).all()
    else:
        # 解決 PostgreSQL 的 m.* 解析問題，明確列出所有欄位
        query = text("""
        WITH RECURSIVE chat_tree AS (
            SELECT id AS root_id, id AS msg_id, created_at
            FROM message
            WHERE parent_id IS NULL AND session_id = :session_id
            
            UNION ALL
            
            SELECT ct.root_id, m.id, m.created_at
            FROM message m
            JOIN chat_tree ct ON m.parent_id = ct.msg_id
        ),
        tree_max_time AS (
            SELECT root_id, MAX(created_at) as last_activity
            -- created_at 欄位是 TIMESTAMP WITHOUT TIME ZONE，存的就是 UTC。
            -- 這裡刻意「不要」用 AT TIME ZONE 'UTC'：那會把結果變成 timestamptz，
            -- 回傳的 offset 會跟著 DB 的 TimeZone 設定跑 (本機 Asia/Taipei → +08:00，
            -- EC2 若是 UTC → +00:00)，前端很容易判斷錯時區。
            -- 維持 naive UTC，由 models.to_utc_iso() 統一輸出結尾帶 Z 的字串。
            FROM chat_tree
            GROUP BY root_id
        )
        SELECT 
            m.id, 
            m.content, 
            m.role, 
            m.model_used, 
            m.created_at, 
            m.session_id, 
            m.parent_id, 
            m.title, 
            m.has_branch,
            tmt.last_activity AS "last_activity"
        FROM message m
        JOIN tree_max_time tmt ON m.id = tmt.root_id
        ORDER BY tmt.last_activity DESC;
        """)
        
        results = session.exec(query, params={"session_id": session_id}).mappings().all()
        
        # ★ 強制手動映射：把 RowMapping 拆解並塞入白名單模型，絕對不讓 FastAPI/Driver 偷偷丟掉欄位
        return [MessageWithActivity(**row) for row in results]

@app.get("/chats/{root_id}/history", response_model=list[Message])
def get_chat_history(root_id: uuid.UUID, session: Session = Depends(get_session)):
    """
    (P2-6) history 只回「跟 root 相同 branch_id」的那條線。

    root 是主幹 (branch_id IS NULL) 就只走主幹；
    root 是分支根 (branch_id = X) 就只走 X 這條分支，不跨越回祖先主幹。
    這樣主線與分支各自乾淨，不會被別條分支的最新訊息污染。
    """
    
    # 單一遞迴 CTE：從 root 往下遞迴，只沿著 branch_id 與父節點相同的子訊息走。
    # IS NOT DISTINCT FROM：NULL 對 NULL 視為相等，主幹 (NULL) 才比對得起來。
    path_query = text("""
    WITH RECURSIVE chat_path AS (
        SELECT id, role, content, model_used, created_at, parent_id, title, session_id, has_branch, branch_id, anchor_message_id
        FROM message WHERE id = :root_id
        UNION ALL
        SELECT m.id, m.role, m.content, m.model_used, m.created_at, m.parent_id, m.title, m.session_id, m.has_branch, m.branch_id, m.anchor_message_id
        FROM message m
        JOIN chat_path cp ON m.parent_id = cp.id
        WHERE m.branch_id IS NOT DISTINCT FROM cp.branch_id
    )
    SELECT * FROM chat_path ORDER BY created_at ASC;
    """)
    
    # mappings() 將 SQL 結果轉為字典列表，FastAPI 才能正確轉換成 JSON
    results = session.exec(path_query, params={"root_id": root_id}).mappings().all()
    
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

# 取得整棵對話樹
@app.get("/chats/{root_id}/tree", response_model=list[Message])
def get_chat_tree(root_id: uuid.UUID, session: Session = Depends(get_session)):
    """
    取得整棵對話樹的「所有」節點 (用來畫前端的 React Flow 樹狀圖)
    """
    query = text("""
    WITH RECURSIVE chat_tree AS (
        -- 1. 找到樹根
        SELECT id, role, content, model_used, created_at, parent_id, title, session_id, has_branch, branch_id, anchor_message_id 
        FROM message WHERE id = :root_id
        
        UNION ALL
        
        -- 2. 往下找出所有子子孫孫 (不論有幾個分支全抓)
        SELECT m.id, m.role, m.content, m.model_used, m.created_at, m.parent_id, m.title, m.session_id, m.has_branch, m.branch_id, m.anchor_message_id 
        FROM message m
        JOIN chat_tree ct ON m.parent_id = ct.id
    )
    SELECT * FROM chat_tree ORDER BY created_at ASC;
    """)
    
    results = session.exec(query, params={"root_id": root_id}).mappings().all()
    return results


@app.post("/chats/{root_id}/branches")
def create_branch(
    root_id: uuid.UUID,
    payload: CreateBranchRequest,
    session: Session = Depends(get_session),
):
    """
    (P2-9) 從某則既有訊息 (anchor) 分岔出一條新分支。

    流程：
    1. 驗證 root 與 anchor 都存在，且 anchor 真的位於 root 這棵樹上。
    2. 直接建立 Branch：root_message_id 先留 None，等這條分支的第一則
       user 訊息送出時，由 /chat 回填 (見 chat_endpoint)。
       為什麼不再預建第一則 user 訊息：使用者可能只是想「先開一條分支」，
       預先塞空訊息會在樹上留下沒有內容的節點，也讓 root 的語意變模糊。
    3. 把整棵樹的根標記 has_branch = True，commit。
    """
    # --- 1. 驗證 ---
    root_msg = session.get(Message, root_id)
    if not root_msg:
        raise HTTPException(status_code=404, detail="Chat not found")

    anchor_msg = session.get(Message, payload.anchor_message_id)
    if not anchor_msg:
        raise HTTPException(status_code=404, detail="Anchor message not found")

    # 簡單驗證 anchor 屬於 root 這棵樹：從 anchor 往上遞迴找祖先，看是否會走到 root
    belongs = session.exec(
        text("""
        WITH RECURSIVE ancestors AS (
            SELECT id, parent_id FROM message WHERE id = :anchor_id
            UNION ALL
            SELECT m.id, m.parent_id FROM message m
            JOIN ancestors a ON a.parent_id = m.id
        )
        SELECT id FROM ancestors WHERE id = :root_id LIMIT 1;
        """),
        params={"anchor_id": payload.anchor_message_id, "root_id": root_id},
    ).first()
    if not belongs:
        raise HTTPException(
            status_code=400, detail="Anchor message does not belong to this chat"
        )

    # --- 2. Branch 本體（title 取 anchor_text 的單行前 50 字）---
    if payload.anchor_text and payload.anchor_text.strip():
        title = " ".join(payload.anchor_text.split())[:50]
    else:
        title = "新分支"

    branch = Branch(
        root_message_id=None,
        anchor_message_id=payload.anchor_message_id,
        anchor_text=payload.anchor_text,
        anchor_start=payload.anchor_start,
        anchor_end=payload.anchor_end,
        title=title,
        # 若 anchor 本身已屬於某條分支，代表這是「分支再分支」
        parent_branch_id=anchor_msg.branch_id,
    )
    session.add(branch)
    session.flush()  # 取得 branch.id

    # --- 3. 標記整棵樹的根 ---
    root_of_tree = root_msg
    if root_msg.parent_id is not None:
        # root_id 若不是樹根，往上找出 parent_id IS NULL 的那一則
        real_root_id = session.exec(
            text("""
            WITH RECURSIVE ancestors AS (
                SELECT id, parent_id FROM message WHERE id = :start_id
                UNION ALL
                SELECT m.id, m.parent_id FROM message m
                JOIN ancestors a ON a.parent_id = m.id
            )
            SELECT id FROM ancestors WHERE parent_id IS NULL LIMIT 1;
            """),
            params={"start_id": root_id},
        ).first()
        if real_root_id:
            root_of_tree = session.get(Message, real_root_id[0])

    if root_of_tree:
        root_of_tree.has_branch = True
        session.add(root_of_tree)

    session.commit()
    session.refresh(branch)

    return {
        "branch_id": str(branch.id),
        "anchor_message_id": str(branch.anchor_message_id),
        "anchor_text": branch.anchor_text,
        "anchor_start": branch.anchor_start,
        "anchor_end": branch.anchor_end,
        "precise": branch.anchor_start is not None and branch.anchor_end is not None,
        "root_message_id": None,
    }


@app.get("/chats/{root_id}/branches")
def list_branches(root_id: uuid.UUID, session: Session = Depends(get_session)):
    """
    (P2-11) 列出「錨定在這棵對話樹內」的所有分支。

    判定方式：從 root_id 出發，沿著 parent_id 往下遞迴展開所有子孫訊息，
    得到這棵樹的完整 message id 集合；再取出 anchor_message_id 落在集合內的分支。
    這樣即使 UI 傳來的 root_id 只是樹中間的某一則訊息，也能正確取到該子樹的分支。
    以 created_at 升冪排序 (分支建立順序，前端可穩定渲染)。
    """
    query = text("""
    WITH RECURSIVE tree AS (
        SELECT id FROM message WHERE id = :root_id
        UNION ALL
        SELECT m.id FROM message m
        JOIN tree t ON m.parent_id = t.id
    )
    SELECT b.id, b.title, b.anchor_message_id, b.anchor_text,
           b.anchor_start, b.anchor_end,
           b.root_message_id, b.parent_branch_id, b.created_at
    FROM branch b
    WHERE b.anchor_message_id IN (SELECT id FROM tree)
    ORDER BY b.created_at ASC;
    """)

    rows = session.exec(query, params={"root_id": root_id}).mappings().all()

    return [
        {
            "id": str(row["id"]),
            "title": row["title"],
            "anchor_message_id": str(row["anchor_message_id"]),
            "anchor_text": row["anchor_text"],
            "anchor_start": row["anchor_start"],
            "anchor_end": row["anchor_end"],
            "precise": row["anchor_start"] is not None and row["anchor_end"] is not None,
            "root_message_id": str(row["root_message_id"]) if row["root_message_id"] else None,
            "parent_branch_id": str(row["parent_branch_id"]) if row["parent_branch_id"] else None,
            "created_at": to_utc_iso(row["created_at"]),
        }
        for row in rows
    ]


@app.get("/api/free-models")
def get_free_models_endpoint(session: Session = Depends(get_session)):
    models = get_free_models(session)
    return {"models": models}