import os
from openai import AsyncOpenAI

# 初始化 OpenRouter 客戶端
# 注意 baseURL 要指向 openrouter
client = AsyncOpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY"),
)

async def openrouter_chat_stream(message: str, history: list, model_name: str):
    """
    呼叫 OpenRouter 平台上的各式模型並產生串流
    """
    print(f"🌐 路由至 OpenRouter，使用模型: {model_name}")
    
    # 1. 將歷史紀錄 (Message 物件) 轉換為 OpenAI 格式
    or_history = []
    for msg in history:
        # DB 裡的 role 是 "user" 或 "assistant"，剛好跟 OpenAI 完全一致！
        or_history.append({"role": msg.role, "content": msg.content})
    
    # 2. 加入當前使用者的新訊息
    or_history.append({"role": "user", "content": message})

    try:
        # 3. 發送請求 (啟用 stream=True)
        response = await client.chat.completions.create(
            model=model_name,
            messages=or_history,
            stream=True,
        )
        
        # 4. 讀取串流並產出
        async for chunk in response:
            # 確保有內容才 yield (有時候 chunk 只是狀態更新)
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
                
    except Exception as e:
        yield f"\n[OpenRouter 發生錯誤: {str(e)}]"