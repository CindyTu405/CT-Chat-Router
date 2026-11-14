import os

import openai
from openai import AsyncOpenAI

# (G2-9) OpenRouter 的基底網址：模組常數（不是環境變數），harness 可換成假伺服器。
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# 初始化 OpenRouter 平台客戶端（試用者用）
# 注意 baseURL 要指向 openrouter
client = AsyncOpenAI(
    base_url=OPENROUTER_BASE_URL,
    api_key=os.getenv("OPENROUTER_API_KEY"),
)


class UserKeyInvalid(Exception):
    """(G2-9) 使用者自己的 OpenRouter 金鑰被拒絕（HTTP 401）。訊息固定，不含金鑰或供應商回應。"""

    def __init__(self):
        super().__init__("user OpenRouter key rejected")


class UserKeyInsufficientCredit(Exception):
    """(G2-9) 使用者自己的 OpenRouter 帳號額度不足（HTTP 402）。訊息固定。"""

    def __init__(self):
        super().__init__("user OpenRouter account has insufficient credit")


class UserKeyUpstreamError(Exception):
    """(G2-9) 使用者金鑰的其他失敗（例如 500、連線錯誤）。訊息固定。"""

    def __init__(self):
        super().__init__("user OpenRouter request failed")


def _max_output_tokens() -> int:
    """(V1-2) 單次回覆輸出上限：環境變數 MAX_OUTPUT_TOKENS，預設 3000，每次呼叫時讀取。
    不從 main 匯入（main 會 import 本檔，會循環）。"""
    raw = (os.getenv("MAX_OUTPUT_TOKENS") or "").strip()
    try:
        return int(raw)
    except ValueError:
        return 3000


async def _stream_chunks(c, message: str, history: list, model_name: str):
    """組出 OpenAI 格式的訊息並串流回傳文字。平台客戶端與使用者金鑰客戶端共用。"""
    # 1. 將歷史紀錄 (Message 物件) 轉換為 OpenAI 格式
    or_history = []
    for msg in history:
        # DB 裡的 role 是 "user" 或 "assistant"，剛好跟 OpenAI 完全一致！
        or_history.append({"role": msg.role, "content": msg.content})

    # 2. 加入當前使用者的新訊息
    or_history.append({"role": "user", "content": message})

    # 3. 發送請求 (啟用 stream=True)
    response = await c.chat.completions.create(
        model=model_name,
        messages=or_history,
        stream=True,
        max_tokens=_max_output_tokens(),
    )

    # 4. 讀取串流並產出
    async for chunk in response:
        # 確保有內容才 yield (有時候 chunk 只是狀態更新)
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content


async def openrouter_chat_stream(message: str, history: list, model_name: str, api_key: str | None = None):
    """
    呼叫 OpenRouter 平台上的各式模型並產生串流。
    (V1-2) 失敗時不再 yield 錯誤文字，改為往上拋，由 main.run_generation 統一處理。
    (G2-9) api_key 為 None → 用平台客戶端（試用者，行為不變）。
           api_key 有值 → 每次呼叫建立一個使用者金鑰客戶端，用完關閉；不快取、不記錄金鑰。
           使用者金鑰的失敗轉成固定訊息的例外（UserKeyInvalid / UserKeyInsufficientCredit / UserKeyUpstreamError），
           不含供應商回應；不重試（max_retries=0），確保一次生成只打一次上游。
    """
    print(f"🌐 路由至 OpenRouter，使用模型: {model_name}")

    if api_key is None:
        async for piece in _stream_chunks(client, message, history, model_name):
            yield piece
        return

    user_client = AsyncOpenAI(api_key=api_key, base_url=OPENROUTER_BASE_URL, max_retries=0)
    try:
        async for piece in _stream_chunks(user_client, message, history, model_name):
            yield piece
    except openai.AuthenticationError:
        raise UserKeyInvalid() from None
    except openai.APIStatusError as e:
        if e.status_code == 401:
            raise UserKeyInvalid() from None
        if e.status_code == 402:
            raise UserKeyInsufficientCredit() from None
        raise UserKeyUpstreamError() from None
    except Exception:
        raise UserKeyUpstreamError() from None
    finally:
        await user_client.close()
