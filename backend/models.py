from typing import Optional, List
from sqlmodel import SQLModel, Field, Relationship
from datetime import datetime
import uuid


# 這是 Message 的資料表定義
class Message(SQLModel, table=True):
    # 使用 UUID 作為 ID，比數字 1,2,3 更適合分散式系統
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)

    # 對話內容
    content: str
    role: str  # "user" 或 "assistant"

    # 使用哪個模型生成的 (例如 "gpt-4o", "gemini-pro")
    model_used: Optional[str] = None

    # 建立時間
    created_at: datetime = Field(default_factory=datetime.utcnow)

    # --- 樹狀結構核心 ---
    # 指向父節點的 ID (上一則訊息)
    parent_id: Optional[uuid.UUID] = Field(default=None, foreign_key="message.id")

    # 關聯：透過 parent_id 找到父訊息 (這在程式碼中用來方便存取)
    # parent: Optional["Message"] = Relationship(back_populates="children", sa_relationship_kwargs={"remote_side": "Message.id"})

    # 關聯：找到所有子訊息 (這則訊息衍生出的不同回答)
    # children: List["Message"] = Relationship(back_populates="parent")


# Pydantic 模型 (用於 API 請求驗證，不存入資料庫)
class ChatRequest(SQLModel):
    message: str
    parent_id: Optional[uuid.UUID] = None
    model: str = "gpt-3.5-turbo"