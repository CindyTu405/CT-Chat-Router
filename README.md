[English](README_en.md) | **繁體中文**

# CT-Chat-Router: 多模型 AI 聚合聊天平台

## 專案簡介
CT-Chat-Router 是一個全端、響應式(RWD)的 AI 聊天應用程式。本專案的核心目標是打造一個能統一呼叫多種大型語言模型 (LLM) 的聚合介面，並在底層資料庫實作了**樹狀對話結構 (Tree-based Conversation)**。使用者可以在單一介面中無縫切換不同的 AI 模型來進行對話與測試。

## 展示影片 Demo

https://github.com/user-attachments/assets/78270ed4-3bd7-4a4c-9262-499483097318

## 核心功能
* **多模型動態路由 (Multi-Model Routing):** 後端實作了動態路由機制，原生支援 Google Gemini API，並透過 OpenRouter 整合多款開源/免費模型（如 Arcee AI, DeepSeek 等）。
* **自訂模型注入:** 提供使用者手動輸入任何 OpenRouter 支援的 Model ID 進行即時測試。
* **樹狀對話分支底層 (Tree-Based Branching - MVP 階段):** 資料庫每一則訊息皆帶有 `parent_id` 形成關聯樹。
  * *目前實作進度：* 支援從歷史對話中途編輯並開展新的對話分支。目前的 UI 邏輯會優先載入並顯示「最新的時間線」（會暫時隱藏舊的平行分支）。
  * *未來優化方向：* 開發前端的分支切換器 (Branch Switcher)，讓使用者能自由穿梭在不同的平行對話中。
* **即時串流輸出 (Real-Time Streaming):** 實作 Server-Sent Events (SSE)，提供如打字機般平滑的文字生成體驗，解決 HTTP 長時間等待的 Timeout 問題。
* **對話紀錄管理 (CRUD):** 側邊欄功能支援創建新對話、讀取歷史紀錄、自訂對話標題 (Rename) 以及刪除功能。

## 技術棧 (Tech Stack)
* **前端 (Frontend):** React, Vite, Tailwind CSS, Lucide React
* **後端 (Backend):** Python, FastAPI, SQLModel (SQLAlchemy), PostgreSQL
* **架構與部署 (Infrastructure):** Docker & Docker Compose, Render 雲端部署

## 專案結構
```text
.
├── backend/
│   ├── main.py              # FastAPI 核心應用與 API 路由
│   ├── models.py            # SQLModel 資料庫綱要 (Message, ChatRequest)
│   ├── database.py          # 資料庫連線與引擎設定
│   ├── gemini_llm.py        # Google Gemini SDK 串接邏輯
│   ├── openrouter_llm.py    # OpenRouter API 串接邏輯
│   ├── migrate.py           # 資料庫遷移腳本
│   └── Dockerfile           # 後端容器化設定
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # React 主元件與畫面邏輯
│   │   └── index.css        # Tailwind 樣式設定
│   └── package.json         # Node 套件依賴
└── docker-compose.yml       # 多容器編排設定檔
```
## 給開發者的架構筆記 (Architecture Notes)
1. 遞迴 CTE 與對話樹 (Recursive CTE & Chat Tree)
為了支援未來的多重分支功能，資料庫不使用單純的 JSON Array 儲存對話，而是採用帶有 parent_id 的 Linked List/Tree 結構。

讀取邏輯 (/chats/{root_id}/history): 後端使用 PostgreSQL 的 Recursive CTE (遞迴通用資料表運算式)。系統會先找出該對話樹中「最新」的葉節點 (Leaf Node)，接著向上遞迴尋找祖先直到根節點 (Root)，最後回傳一條乾淨的線性對話陣列給前端渲染。

刪除邏輯: 實作了深度優先 (Depth-First) 的刪除機制，依照節點層級 (Level DESC) 由深至淺刪除，完美避開 Foreign Key Constraint (外鍵約束) 的衝突問題。

2. 模型路由器 (Model Router)
後端 main.py 扮演交通警察的角色。當接收到前端請求時，會檢查 request.model 的字首：

若為 gemini 開頭，則路由至原生的 Google GenAI SDK。

其餘字串則統一轉發至 openrouter_llm.py 處理，達成單一 API 接口支援無限模型的擴充能力。

## 部署資訊
本專案已成功容器化 (Dockerized)。

Backend: 部署於 Render Web Service，連接受控管的 PostgreSQL 資料庫。

Frontend: 部署於 Render Static Site。
