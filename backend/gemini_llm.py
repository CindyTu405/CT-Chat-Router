import google.generativeai as genai
import os
import asyncio

# 設定 API Key
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

if not GOOGLE_API_KEY:
    raise ValueError("❌ 錯誤：找不到 GOOGLE_API_KEY！請檢查 .env 檔案或 docker-compose.yml 設定。")

genai.configure(api_key=GOOGLE_API_KEY)

async def gemini_chat_stream(message: str, history: list, model_name: str = "gemini-2.5-flash-lite"):
    """
    呼叫 Google Gemini API 並產生串流
    """
    print(f"🤖 正在使用模型: {model_name}")
    try:
        model = genai.GenerativeModel(model_name)
        
        # 1. 將我們的 Message 物件轉換成 Gemini 看得懂的格式
        # Gemini 的格式是: [{'role': 'user', 'parts': ['...']}, {'role': 'model', 'parts': ['...']}]
        gemini_history = []
        for msg in history:
            role = "user" if msg.role == "user" else "model"
            gemini_history.append({"role": role, "parts": [msg.content]})
        
        # 2. 建立聊天物件 (ChatSession)
        chat = model.start_chat(history=gemini_history)
        
        # 3. 發送訊息 (stream=True 代表要串流)
        # 這裡要注意：Gemini 的 send_message_async 目前是回傳整個 response，
        # 但它的 stream=True 可以讓我們用迭代器讀取。
        # 為了配合 FastAPI 的 async generator，我們需要包裝一下。
        
        response = await chat.send_message_async(message, stream=True)
        
        # 4. 逐段回傳
        async for chunk in response:
            if chunk.text:
                yield chunk.text
                # 這裡不需要 sleep，因為是真的網路請求，本身就有延遲

    except Exception as e:
        yield f"⚠️ 模型錯誤: {str(e)}"