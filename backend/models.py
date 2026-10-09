from typing import Optional, List
from sqlmodel import SQLModel, Field
from datetime import datetime, timezone
from pydantic import BaseModel, field_serializer
import uuid


def to_utc_iso(value: Optional[datetime]) -> Optional[str]:
    """
    把 datetime 一律序列化成「UTC + 結尾 Z」的 ISO 字串。

    為什麼要這樣做：
    資料庫欄位是 TIMESTAMP WITHOUT TIME ZONE，存的是 UTC，但讀出來是 naive，
    Pydantic 會序列化成 "2026-10-09T08:56:25" (沒有時區標記)。
    前端如果直接 new Date() 會被當成「使用者本機時間」，時區就會錯；
    之前前端自己補 "Z" 的写法，遇到 SQL 回傳的 +08:00 就會變成
    "...+08:00Z" → Invalid Date。

    統一由後端輸出帶 Z 的 UTC 字串，前端就不用再猜時區了。
    """
    if value is None:
        return None
    if value.tzinfo is None:
        # naive 一律視為 UTC (資料庫存的本来就是 UTC)
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


# 這是 Message 的資料表定義
class MessageBase(SQLModel):
    # 對話內容
    content: str
    role: str  # "user" 或 "assistant"

    # 使用哪個模型生成的 (例如 "gpt-4o", "gemini-pro")
    model_used: Optional[str] = None

    # 建立時間
    # 存 naive UTC：aware datetime 經 psycopg2 寫入 TIMESTAMP 欄位時，
    # 會被 PostgreSQL 依 DB 的 TimeZone (Asia/Taipei) 轉成本地時間，造成時間偏移 8 小時。
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )

    # 用戶 Session (用來隔離不同訪客的內容)
    session_id: str = Field(default="default")

    # --- 樹狀結構核心 ---
    # 指向父節點的 ID (上一則訊息)
    parent_id: Optional[uuid.UUID] = Field(default=None, foreign_key="message.id")

    # 關聯：透過 parent_id 找到父訊息 (這在程式碼中用來方便存取)
    # parent: Optional["Message"] = Relationship(back_populates="children", sa_relationship_kwargs={"remote_side": "Message.id"})

    # 關聯：找到所有子訊息 (這則訊息衍生出的不同回答)
    # children: List["Message"] = Relationship(back_populates="parent")

    # 對話標題
    # 只有 "對話開頭 (Root)" 的訊息會有這個值，其他訊息通常為 None
    title: str | None = Field(default=None)

    # 新增：是否包含分支的標記
    has_branch: bool = Field(default=False)

    @field_serializer("created_at")
    def serialize_created_at(self, value: Optional[datetime], _info) -> Optional[str]:
        return to_utc_iso(value)

# 第二層：真正的資料庫表 (繼承 Base，並加上 table=True)
class Message(MessageBase, table=True):
    # 使用 UUID 作為 ID，比數字 1,2,3 更適合分散式系統
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)

# 第三層：回傳給前端的白名單 (繼承 Base，並加入擴充欄位)
# 注意：這裡必須重新定義 id，確保序列化時能正確導出
class MessageWithActivity(MessageBase):
    id: uuid.UUID
    last_activity: Optional[datetime] = None
    model_config = {"from_attributes": True} # ★ 確保 Pydantic 能從資料庫 Row 讀取屬性

    @field_serializer("last_activity")
    def serialize_last_activity(self, value: Optional[datetime], _info) -> Optional[str]:
        return to_utc_iso(value)

# Pydantic 模型 (用於 API 請求驗證，不存入資料庫)
class ChatRequest(SQLModel):
    message: str
    parent_id: Optional[uuid.UUID] = None
    model: str = "gpt-3.5-turbo"
    session_id: str = "default"

class UpdateTitleRequest(SQLModel):
    title: str


class FreeModelsCache(SQLModel, table=True):
    id: int = Field(default=1, primary_key=True)
    models_json: str = Field(default="[]")
    # 欄位型別是 TIMESTAMP WITHOUT TIME ZONE，統一存 naive UTC，
    # 讀取時再用 scraper._as_utc() 補上時區，避免 naive / aware 混用出錯。
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )