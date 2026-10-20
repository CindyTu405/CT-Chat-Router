# CT-Chat-Router v2 — 商業化架構與分期計畫

> 建立日期：2026-10-18
> 狀態：草案（2026-10-18 更新：OAuth、用量策略、計費已決議）
> 前提：從 demo 轉向可商業化的完整產品，可大改，採「演進式重構」而非推翻重寫。
> 既有計畫：`PLAN_20261012.md`（尚未完成的 P2-fix、S4、S1、S2 細節以本文件為準；S4 已升級為 Obsidian 資料夾匯出）

---

## 一、核心決策

| 決策 | 內容 | 狀態 |
|---|---|---|
| 定位 | 可商業化的完整產品，安全性與功能並重 | 已定 |
| 登入 | OAuth（Google + GitHub 都上），httpOnly cookie session token | 已定 |
| 用量策略 | 免費 tier（平台 key + 免費模型 + 限次）→ 用戶輸入自己 key 後解鎖全部模型 | 已定 |
| 計費 | 平台不向用戶收費；變現靠 BYOK（用戶用自己的 API） | 已定 |
| 重構方式 | 演進式重構，不動已跑通的串流 / CTE 核心 | 已定 |
| 分支模型 | 升格為一級實體 `Branch` | 已定 |
| 分支面板 | 右側分割視窗，tab 支援多條 | 已定 |
| 分支發現性 | logo 變更作為分支地圖入口 | 已定 |
| 時間軸 | 對話頁右側 turn 圓點列，點擊跳轉 | 已定 |
| 匯出 | Obsidian 資料夾套件，分支用 `[[wiki 連結]]` | 已定 |

---

## 二、資料模型 v2

```
User
  id, oauth_provider, oauth_sub, email, created_at

Chat (root)              # 取代「root message 即對話」的隱含概念（MVP 可先不拆表，用 Message 的 root 表示）
  id, user_id, title, created_at, updated_at

Message
  id, chat_id, parent_id (自關聯), branch_id (NULL = 主幹)
  role, content, model, media (預留), created_at
  anchor_message_id      # 分支根專用：錨點在主幹的位置

Branch
  id, chat_id, root_message_id, anchor_message_id
  title (自動產生 + 可改名), created_at, parent_branch_id (支援分支內再分支)
```

**要點**
- 主線 = `branch_id IS NULL` 的鏈；分支 = 同一個 `branch_id` 的子樹。
- 主線載入 / 歷史 / 刪除的遞迴 CTE 邏輯沿用，只加 `branch_id` 過濾條件。
- 分支標題自動產生（取選取引文或首則訊息摘要）+ 可改名，服務 Obsidian 連結文字。

---

## 三、安全性清單（依優先序）

1. **OAuth 登入** + httpOnly SameSite cookie session，chats / messages 綁 `user_id`。
2. **CORS**：`allow_origins=["*"]` → 明確白名單。
3. **速率限制**（token bucket，per user / IP）+ 每用戶每日 token 預算。
4. **模型白名單**：免費 tier 只開放免費模型；任意 model ID 僅限 BYOK 用戶（他們自付費用）。
5. **搜尋 ILIKE 跳脫** `%` `_`；所有 raw SQL 參數化。
6. **BYOK key 加密儲存**（Fernet / pgcrypto），不回傳前端、不寫 log。
7. **內容 XSS**：若引入 markdown 渲染或高亮，強制 sanitizer。
8. **稽核**：記錄 provider 呼叫的 user / 成本，供追蹤。

---

## 四、API key 與用量策略（已定）

- **免費 tier（內建 API，限次）**：新用戶用平台 key 體驗，只開放白名單的免費模型。額度：每日 10 則、每則輸出上限 1500 tokens、每分鐘 10 次請求、輸入長度不限。
- **BYOK（用戶自己的 API key）**：用戶以 OAuth 連線（OpenRouter PKCE / Google）或手動輸入（加密儲存）綁定自己的 key，解鎖所有模型；費用由用戶的 provider 依其付費狀況計收，平台不經手。
- **平台不收費**：近期無計費系統；營運成本僅為免費 tier 的小額補貼。未來若要收費再加（Phase 6+）。

---

## 五、功能分期

### Phase 0 — 安全地基（優先，所有東西的地基）
OAuth 登入、CORS 白名單、rate limit、模型白名單、User 表與遷移。

### Phase 1 — 資料模型遷移
`Branch` 實體、`Message` 加欄位、遷移腳本（保住現有資料）。驗證舊功能不壞。

### Phase 2 — 分支重設計
選取文字 → 建立分支 → 右側分割視窗（tab 多條）→ 主線忽略分支上下文 → 分支地圖改主幹垂直 / 分支向右。

### Phase 3 — turn 時間軸（可與 Phase 1/2 並行，純前端）
對話頁右側垂直圓點列，每則一個點，點擊 scrollIntoView。

### Phase 4 — Obsidian 匯出
資料夾套件匯出（見下節）。

### Phase 5 — 收尾
BYOK（OAuth 連線 + 手動輸入加密儲存）、免費 tier 額度計數、監控、內容稽核。

---

## 五-B、Phase 0 任務拆解（編號 + 驗收）

> 執行方式：每任務由輕量模型（deepseek-v4.1-flash）實作，完成即 commit（訊息含任務編號），todo 追蹤進度。已完成的任務從表移除或標 ✅。

| 編號 | 任務 | 驗收標準 | 依賴 |
|---|---|---|---|
| P0-1 | 移除 `database.py` 硬編碼 DB 密碼 | `database.py` 無密碼字串；連線改讀 `DATABASE_URL`，無預設密碼 | 無 |
| P0-2 | 新增 `authlib` 並設定 OAuth client（Google+GitHub） | `uv add authlib`；client id/secret 從 env 讀；兩組 registry 可初始化 | 無 |
| P0-3 | OAuth 登入/回呼路由 | `/auth/google`、`/auth/github` 導向 provider；callback 後 upsert User、建 AuthSession、設 httpOnly cookie；`/logout` 清 cookie | P0-2 |
| P0-4 | 認證依賴 `get_current_user` | 讀 cookie→驗證 session→注入 user；無效/過期回 401 | P0-3 |
| P0-5 | CORS 白名單 | `allow_origins` 改讀 env 白名單；非白名單 origin 被拒 | 無 |
| P0-6 | Rate limit（slowapi） | `uv add slowapi`；chat 端點每分鐘 10 次；超限回 429 | 無 |
| P0-7 | 模型白名單（免費 tier） | 免費 tier 僅允許白名單模型；其他 model ID 回 4xx | 無 |
| P0-8 | 輪換 DB 密碼 | 產生新密碼寫入 `.env`；對 live DB 跑 `ALTER USER`；新密碼可連、舊密碼失效（使 git 歷史中的舊密碼作廢） | 無 |
| P0-9 | 模型白名單納入 OpenRouter 免費模型 | `is_model_allowed` 對 `gemini*` 和 OpenRouter 免費模型（`get_free_models` 回傳的 id）都回 True；隨機模型回 False | 無 |
| P0-10 | 停用 lifespan 的 `create_all` | lifespan 不再呼叫 `create_db_and_tables`；建表一律走 `alembic upgrade head` | 無 |

---

## 五-C、Phase 1 任務拆解（資料模型遷移）

| 編號 | 任務 | 驗收標準 | 依賴 |
|---|---|---|---|
| P1-1 | 新增 `Branch` 實體 + `Message` 加 `branch_id`/`anchor_message_id` | `import models` 成功；metadata 有 `branch` 表；`message` 表有兩個新欄位 | 無 |
| P1-2 | 產生 + 套用 Alembic migration | migration 含 `branch` 表 + `message` 加欄位；`upgrade head` 成功；舊資料（32 筆）保留 | P1-1 |
| P1-3 | 驗證舊功能不壞 | `import main` ok；`/chats/roots`、`/chats/{root_id}/history` 仍正常 | P1-2 |

---

## 五-D、Phase 2 任務拆解（分支重設計）

| 編號 | 任務 | 驗收標準 | 依賴 |
|---|---|---|---|
| P2-1 | 修 history/tree 的 SELECT 補齊欄位 | `/chats/{root}/history`、`/tree` 回傳正確的 `session_id`/`has_branch`/`branch_id`/`anchor_message_id`（不再填預設值） | 無 |
| P2-2 | `ChatRequest` + `chat_endpoint` 支援 `branch_id`/`anchor_message_id` | 帶 branch_id 送訊息時，user/assistant 訊息都標記該 branch_id | P2-1 |
| P2-3 | 建立分支 API `POST /chats/{root}/branches` | 傳 anchor_message_id + 選取文字 → 建 Branch 記錄 + 分支第一則訊息 | P2-2 |
| P2-4 | 前端文字選取 + 建立分支入口 | 選取 AI 回覆文字 → 出現「建立分支」按鈕 | 無（前端） |
| P2-5 | 右側分割視窗 + 多 tab 分支面板 | 分支在右側開啟、可同時多條 tab、各自獨立對話 | P2-3、P2-4 |
| P2-6 | 主線忽略分支上下文 | 主視窗只走主幹（branch_id IS NULL），分支上下文不混入 | P2-2、P2-5 |
| P2-7 | 分支地圖重設計（主幹垂直、分支向右） | React Flow 主幹由上而下、分支由左至右、葉節點可刪 | P2-3 |

---

## 五-E、Phase 2 修正（使用者測試回饋，wiki 高亮入口）

| 編號 | 任務 | 驗收標準 | 依賴 |
|---|---|---|---|
| P2-8 | 修選取文字可正常複製 | 選取 AI 文字後可 Ctrl+C／右鍵複製，不被浮動按鈕阻擋 | 無 |
| P2-9 | Branch 加 `anchor_text` 欄位＋migration | Branch 表有 anchor_text；存選取文字 | 無 |
| P2-10 | 建立分支改「文字進輸入框、不自動送出」 | 開分支後選取文字在輸入框、無已送出的 user 訊息 | P2-9 |
| P2-11 | `GET /chats/{root}/branches` 回傳分支清單 | 回傳該對話所有分支（id/title/anchor_message_id/anchor_text） | P2-9 |
| P2-12 | 前端 wiki 高亮渲染＋點擊開分支 | 錨點訊息內選取文字高亮、點擊高亮開對應分支 | P2-10、P2-11 |
| P2-13 | 移除舊版分支功能 | 鉛筆按鈕＋handleBranch 移除，不再混淆 | 無 |
| P2-14 | 修分支地圖 | 箭頭根部對齊、分支 user 不再佔兩格 | 無 |
| P2-15 | BranchPanel 可拖曳調寬度 | 滑鼠拖曳分隔條調整右側面板寬度 | 無 |

---

## 六、Obsidian 匯出規格

```
chat-{root_id}-{date}/
├── 主對話.md          # 主幹完整對話
├── media/             # 附件（現為空，預留）
└── 分支/
    ├── 分支A標題.md
    └── 分支B標題.md
```

- **連結格式開關**（匯出時可選）：`[[分支/標題]]`（Obsidian wiki-link）或 `[標題](分支/標題.md "分支")`（通用 Markdown）。
- 主 md 分支錨點處依開關格式放連結（預設 `[[分支/分支A標題]]`）。
- 分支 md 反向連結主對話，形成雙向導航。
- 檔名 sanitize 非法字元；標題衝突加序號。

---

## 七、已決議

| 問題 | 決議 |
|---|---|
| OAuth provider | Google + GitHub 都上 |
| 租戶模型 | 多租戶：每個用戶獨立帳號與資料；免費 tier 體驗 → BYOK 解鎖 |
| 計費 | 平台不收費，交給用戶自己的 API（BYOK） |

**已決議**：免費 tier 額度 = 每日 10 則、輸出上限 1500 tokens / 次、每分鐘 10 次請求、輸入長度不限。
