# CT-Chat-Router v2 — 商業化架構與分期計畫

> 建立日期：2026-10-18
> 狀態：草案（2026-10-18 更新：OAuth、用量策略、計費已決議）
> 前提：從 demo 轉向可商業化的完整產品，可大改，採「演進式重構」而非推翻重寫。
> 既有計畫：`PLAN_20261012.md`（尚未完成的 P2-fix、S4、S1、S2 細節以本文件為準；S4 已升級為 Obsidian 資料夾匯出）

---

## 零、進度總覽（統一進度表，2026-10-31 整理）

> **進度一律記在本文件。** `HANDOVER.md`（10/22）已過時，僅供歷史參考；`BUGS.md` 只放 bug 細節；`BACKLOG.md` 只放未討論需求；`DESIGN_P3.md` 只放設計。

| 階段 | 狀態 | 備註 |
|---|---|---|
| Phase 0 安全地基 | ✅ 完成 | P0-1 ~ P0-10 |
| Phase 1 資料模型遷移 | ✅ 完成 | P1-1 ~ P1-3 |
| Phase 2 分支重設計 | ✅ 完成 | P2-1 ~ P2-15（2026-10-20） |
| Phase 3 時間軸 | ⏳ 待辦（T1） | 改為 Gemini Voyager 式時間軸；左欄時間軸已於 F2-fix 移除 |
| Phase 3b 互動/UI | 🔶 進行中 | 見第八節任務表 |
| Phase 4 Obsidian 匯出 | ⏳ 未開始 | |
| Phase 5 收尾（BYOK／額度／監控） | ⏳ 未開始 | |

**下一步**：S-U1 已完成（2026-11-06）；Cloudflare Access 保留到 S-U2 完成。B11、M1 已部署 → 正式初版（見下方「V1 範圍」）。以下為初版之後：S-U2 之外的項目依序 → → E5（暫停中，幽靈分支定義已改，細節待確認，見 BACKLOG E6）→ 窄面板微調（G3-2 延後項）→ T1 → Phase 4 → Phase 5。B4 待重新評估。

### V1 範圍：正式初版（2026-11-06 使用者定方向，細節待確認）

目標：陌生人能安全使用的網站，完成後告一段落。

| 編號 | 內容 | 狀態 |
|---|---|---|
| V1-1 | 部署 B11、M1 | ✅ 2026-11-06 使用者已部署 |
| V1-2 | S-U2：每人每日 20 次（使用者決定，取代第四節的 10 則）、依使用者限流 | ✅ 2026-11-06 完成，使用者瀏覽器驗收通過，尚未部署（部署要跑 migration） |
| V1-3 | 正式站拔掉 Gemini，只留 OpenRouter 免費模型（使用者決定：平台 Gemini key 短時間就被限制） | ✅ 2026-11-08 完成，使用者瀏覽器驗收通過，尚未部署（VM `.env` 要加 `ALLOWED_MODELS=none`、`DEFAULT_MODEL=openrouter/free`） |
| V1-4 | 安全標頭、自動備份與還原演練、基本監控、日誌大小上限、上線前安全檢查 | V1-4a 完成（7c64865），本機驗過六個標頭，部署後待瀏覽器檢查 CSP；V1-4c 審查完成（2026-11-08），發現 B13–B16（另有 B17）記入 `BUGS.md`；B13 已修（2026-11-09），B17 已修（2026-11-09），B14 已修（2026-11-09），B15 已確認（2026-11-09），以上已部署（2026-11-09），B16 延到 V1 後；V1-4b 未開始 |
| V1-5 | 隱私權說明與聯絡方式 | ✅ 2026-11-08 完成（1ee6c9a），使用者瀏覽器驗收通過，尚未部署；聯絡信箱留到 V1-6 再加 |
| V1-6 | 移除 Cloudflare Access、確認 Google OAuth 對外開放、上線驗證 | ⏳ 最後做 |

風險：OpenRouter `:free` 模型的額度是整個帳號共用（查詢日 2026-11-06：累計購買未滿 10 美元每日 50 次，達到後每日 1000 次，每分鐘 20 次）。

初版之後：BYOK、E5、E6、T1、Phase 4、X1、S-U3、窄面板微調、模型選單改版、OpenRouter 授權連線。

教學與決策表：`docs/20261106_(V1)first-release-guide.html`。使用者讀完說「開始」才動工。隱私權頁的聯絡信箱：親友階段先不放，V1-6 公開開放前必須補上。

**V1-2 額度（`backend/models.py`、新 migration、`backend/main.py`、`backend/gemini_llm.py`、`backend/openrouter_llm.py`、`backend/dev/*`，前端提示另一個 commit 改 `frontend/src/App.jsx`）**
- 新表 `daily_usage`：`user_id`（FK）、`day`（date，台灣日期）、`count`，主鍵 `(user_id, day)`。
- 環境變數：`DAILY_MESSAGE_LIMIT`（預設 20）、`SITE_DAILY_MESSAGE_LIMIT`（預設 900）、`MAX_OUTPUT_TOKENS`（預設 3000，2026-11-06 使用者決定，取代原本的 1500）；同時加進兩個 compose 檔。
- `/chat`、`POST /messages/{id}/regenerate`：在白名單與擁有者檢查之後、任何寫入與 LLM 呼叫之前扣額度。先查全站當日總和，達上限 → 503 `{"detail": {"code": "site_quota_exceeded"}}`；再用單條 `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < :limit RETURNING` 扣使用者額度，無回傳列 → 429 `{"detail": {"code": "daily_quota_exceeded", "reset_at": <下一個台灣 00:00 的 UTC ISO>}}`。扣額度與訊息寫入同一個交易，後續檢查失敗不留下扣款。
- `run_generation`：生成例外且尚無任何輸出 → 退回 1 次（用扣款當時的 `day`，不低於 0）。兩個 LLM 函式改為往上拋例外，不再把錯誤文字當回覆；使用者只看到固定的「生成中斷，請稍後再試」，供應商錯誤只寫 log。
- `/chat`、regenerate 的 slowapi key 改為依登入 cookie（雜湊後），沒有 cookie 才用 IP；維持 `10/minute`。
- 兩個 LLM 串流函式都套用 `MAX_OUTPUT_TOKENS`。
- 前端：`/chat`、regenerate、分支送出遇到 429 → 顯示「今日額度已用完，將於台灣時間 00:00 重置」；503 → 顯示「今日服務額度已滿，請明天再試」；每分鐘限流的 429（沒有 `detail.code`）→ 顯示「傳送太頻繁，請稍後再試」。被拒絕時撤掉樂觀訊息、文字放回輸入框；重新生成還原舊回覆與模型。訊息文字變更需瀏覽器確認後才 commit。

驗收（一律用假 LLM、臨時資料庫）：
1. `alembic upgrade head`、`alembic check` → 無差異；downgrade 再 upgrade 成功
2. 新 harness `POSTGRES_DB=<臨時庫> SQL_ECHO=false uv run python dev/quota_harness.py 2>&1 | grep -v sqlalchemy | tail -5` → `ALL PASS`，涵蓋：第 20 次成功、第 21 次 429 且沒有新增訊息、沒有呼叫 LLM；主對話、分支、regenerate 共用次數；20 個併發請求只成功剩餘次數；刪對話不退次數；跨台灣日期重置；A 用完不影響 B；全站上限 503；模型未回字就失敗退 1 次，回到一半才失敗不退；白名單或擁有者檢查失敗不扣次數；每分鐘限流依使用者（同 IP 兩人互不影響）；傳給 LLM 的參數含輸出上限
3. `branch_entries_harness`、`regenerate_harness`、`auth_harness` → 都 `ALL PASS`
4. `cd frontend && npm run build` → `✓ built`；瀏覽器：額度設成 1，第二次送出看到提示，輸入內容不遺失（桌面、手機）

**B12 規格與驗收（`backend/main.py`、新檔 `backend/dev/pool_harness.py`）**
- `/chat`、regenerate、`/messages/{id}/stream`：回傳 `StreamingResponse` 前，把需要的值存成區域變數，再 `session.close()`。
- `run_generation`：寫回訊息與 `refund_daily_quota` 改用 `await asyncio.to_thread(...)`；寫回失敗只記 log，不能中斷後面的緩衝清理。
- 連線池大小不變。

驗收（假模型、臨時資料庫）：
1. `POSTGRES_DB=<臨時庫> SQL_ECHO=false uv run python dev/pool_harness.py 2>&1 | grep -v sqlalchemy | tail -5` → `ALL PASS`，涵蓋：30 個慢串流同時進行時無關用戶的 `GET /auth/me` 2 秒內回 200；30 個都回 200 且內容完整寫回 DB；續讀端點同樣不佔連線；輸出沒有 `QueuePool`
2. `quota_harness` 連跑 5 次都 `ALL PASS`
3. `model_options_harness`、`regenerate_harness`、`branch_entries_harness`、`auth_harness` → 都 `ALL PASS`

**V1-3 模型選項（`backend/main.py`、`docker-compose.prod.yml`、`docker-compose.yml`、`backend/dev/*`、`frontend/src/App.jsx`、`frontend/src/components/ModelSelector.jsx`）**
- `GET /api/model-options`（需登入）：`presets` 列出 `ALLOWED_MODELS` 中可直接選的項目（`gemini*` 展開為 `gemini-2.5-flash-lite`；`none` 不列）；`default_model` 取 `DEFAULT_MODEL`，不可用時取第一個 preset 或第一個免費模型，都沒有就 `null`。
- 前端：`model` 初始值與 Google 群組改由此端點決定，移除寫死的 `gemini-2.5-flash-lite`；`presets` 為空不顯示群組；`default_model` 為 `null` 時停用送出並提示暫無可用模型。
- 正式站 `.env`：`ALLOWED_MODELS=none`、`DEFAULT_MODEL=openrouter/free`（2026-11-06 使用者決定，Free Models Router）。

驗收：
1. `ALLOWED_MODELS=none` 時：`gemini-2.5-flash-lite` 送 `/chat` → 403；端點 `presets` 為 `[]`；未登入 → 401（harness）
2. `DEFAULT_MODEL` 不在清單 → 回傳第一個免費模型（harness）
3. `cd frontend && npm run build` → `✓ built`；瀏覽器：`ALLOWED_MODELS=none` 選單沒有 Gemini，開新對話直接送出可用；本機預設設定仍可選 Gemini（桌面、手機）

**V1-4a 安全標頭與日誌（`frontend/nginx.prod.conf`、`docker-compose.prod.yml`）**
- nginx 主站 server 加上教學第 4 節的標頭（`always`）；CSP 依實際載入資源撰寫，`script-src` 不用 `unsafe-inline`、`unsafe-eval`。
- 所有服務加 `logging`：`json-file`、`max-size: 10m`、`max-file: 5`。

驗收：
1. nginx 以測試憑證 `nginx -t` → `test is successful`；`docker compose -f docker-compose.prod.yml config --quiet`（測試環境變數）→ exit 0
2. 部署後 `curl -sI https://fluentbranch.com/` 經 Access 登入後或 VM 上 `curl -skI --resolve fluentbranch.com:443:127.0.0.1 https://fluentbranch.com/` → 六個標頭都在
3. 瀏覽器：登入、串流、分支、Markdown 圖片都正常，Console 沒有 CSP 錯誤（桌面、手機）

**V1-4b 備份（使用者操作，步驟見教學第 6 節）**：Snapshots 頁面出現新快照；還原演練查得到訊息筆數。

**V1-4c 上線前安全檢查**：對 main 做一次安全審查，發現的問題記入 `BUGS.md` 並逐項處理。

**V1-5 隱私權頁（新檔 `frontend/public/privacy.html`、`frontend/src/components/AuthGate.jsx`、`frontend/src/components/Sidebar.jsx`）**
- 靜態頁，內容見教學第 8 節；登入頁與側邊欄底部各一個連結。視覺變更需瀏覽器確認後才 commit。

驗收：`cd frontend && npm run build` → `✓ built`、`dist/privacy.html` 存在；瀏覽器：未登入與已登入都打得開（桌面、手機）。

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
| ✅ P2-8 | 修選取文字可正常複製 | 選取 AI 文字後可 Ctrl+C／右鍵複製，不被浮動按鈕阻擋 | 無 |
| ✅ P2-9 | Branch 加 `anchor_text` 欄位＋migration | Branch 表有 anchor_text；存選取文字 | 無 |
| ✅ P2-10 | 建立分支改「文字進輸入框、不自動送出」 | 開分支後選取文字在輸入框、無已送出的 user 訊息 | P2-9 |
| ✅ P2-11 | `GET /chats/{root}/branches` 回傳分支清單 | 回傳該對話所有分支（id/title/anchor_message_id/anchor_text） | P2-9 |
| ✅ P2-12 | 前端 wiki 高亮渲染＋點擊開分支 | 錨點訊息內選取文字高亮、點擊高亮開對應分支 | P2-10、P2-11 |
| ✅ P2-13 | 移除舊版分支功能 | 鉛筆按鈕＋handleBranch 移除，不再混淆 | 無 |
| ✅ P2-14 | 修分支地圖 | 箭頭根部對齊、分支 user 不再佔兩格 | 無 |
| ✅ P2-15 | BranchPanel 可拖曳調寬度 | 滑鼠拖曳分隔條調整右側面板寬度 | 無 |

> ✅ 全部完成（2026-10-20）。P2-14 的「user 佔兩格」係由 P2-10（不再自動送出選取文字）根治；P2-14 本身修的是箭頭根部對齊（四支水平 handle 統一 top 50%）。

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

---

## 八、Phase 3b — 互動/UI 修正

> 狀態：互動/UI 已定稿，實作進行中；任務編號 P3b-x。後端細節（offset 演算法、/chat 的 context 組裝、幽靈分支 FK 處理）見 `DESIGN_P3.md`（依主題逐一定稿；B2–B4／F9 實作前須先讀）。

### 任務進度表（2026-10-31）

| 編號 | 任務 | 狀態 | 備註／commit |
|---|---|---|---|
| F1a / F1b | 捲動只在底部 100px、閱讀位置還原與 reload 定位 | ✅ | 9b51661、28b2a35 |
| F2 / F2-fix | 左欄 12–30% 拖寬；移除時間軸、⋯ 選單 | ✅ | 4569605、8442487 |
| F3 | 右欄 20–50% 拖寬 | ✅ | c434e81 |
| F1a-fix | 貼底自動捲＋捲到底按鈕 | ✅ | fd1c2e0 |
| Bug A | 串流中切走再切回卡 Thinking（A1–A3：背景任務生成＋resume 端點） | ✅ | 8e63c6d、c1bfe96 |
| Bug B | 左欄標題右端被裁太早（漸層 mask） | ✅ | f8958a3 … c96b0e5 |
| BUGS B1 | 空白輸入框出現滾動條 | ✅ | 1ab0238 |
| BUGS B2 | 手機側邊欄收起時時間軸標籤浮現 | ✅ | 見 BUGS.md |
| F4 | 模型選單移到輸入框下方；右上角改右欄開關 | ✅ | 5ca1402 … b8ec867 |
| F5 | 手機左右滿版 drawer | ✅ | e815b51 |
| F6 | 上下文開關面板（假資料 UI） | ⛔ 廢棄 | 已 revert（dfd0fe5），不再做 |
| B1 | 後端：Branch `anchor_start`／`anchor_end` 欄位＋migration | ✅ | 3bfd1f9 |
| F7 | 前端：選取 → source offset 對映 | ✅ | 2898163 |
| F8 | 前端：AST offset 高亮 | ✅ | 6ab113d |
| G1 | 新對話可直接開分支（回傳 user message id） | ✅ | 4034f55（教學：optimistic-update-guide） |
| B2 | 後端：刪除舊一輪端點＋幽靈分支（`is_orphaned`、`attach_root_id`） | 🔶 部分 | 資料欄位與幽靈化併入 G6-1；刪除舊一輪（主題 3）暫不做 |
| B3 | 後端：幽靈分支重連 API | ➡️ 併入 E2 | 改為 DESIGN_P3 主題 6 |
| B4 | 後端：`/chat` context 組裝（`include_main`／`context_branch_ids`、token 截斷） | ⚠️ 待重新評估 | 依賴已廢棄的 F6，需確認是否仍要做 |
| F9 | 前端：編輯最後一則（inline regenerate）、幽靈分支重連 UI、入口管理右鍵選單 | 🔶 | 編輯最後一則拆為 F9-1／F9-2（下兩列）；幽靈分支重連 UI、入口右鍵選單（主題 5）仍待討論 |
| F9-1 | 後端：`regenerate` body 加可選 `content`，同一個 commit 更新 user 訊息內容 | ✅ | 3a5bf6f（假 LLM harness 47 PASS，含 F9 新增 10a–10e）；規格見下方「F9 規格與驗收」；教學：`docs/20261103_(F9)edit-last-message-guide.html` |
| F9-2 | 前端：最後一則 user 訊息 inline 編輯（主對話＋分支共用，桌面功能列＋手機長按選單） | ✅ | 7013db6（使用者瀏覽器驗證通過）；驗收中發現 BUGS B4（剛送出的 user 無 id）→ F9-B4 f5ca79e 修正 |
| G2 | 分支地圖依錨點位置排序 | ✅ | 1013464（cherry-pick 自 1c574f1，已在瀏覽器確認） |
| G3-1 | 共用組件抽取：`MessageList`／`ChatInput` 加 `variant`；「回到底部」改 absolute | ✅ | be02ad3（已在瀏覽器確認）；教學：`docs/20261101_(G3)shared-chat-pane-guide.html` |
| G3-2 | 分支面板套用共用組件（含 G4 模型標籤） | ✅ | 433effe（使用者瀏覽器驗收 7 項通過；窄面板微調延後） |
| G8 | 訊息功能列（首項：複製）＋ http 剪貼簿備援＋手機 user 長按選單 | ✅ | ff6f733（使用者驗證通過）；教學：`docs/20261102_(G8)message-actions-guide.html`；驗收見下方 |
| G5-B3 | 選取保持反白（G5）＋手機選字出現建立分支按鈕（BUGS B3）：Markdown 元件固定身分、selectionchange＋防抖、手機按鈕在下方 | ✅ | 804d0fd（使用者瀏覽器驗證通過）； 教學：`docs/20261102_(G5-B3)selection-change-guide.html`；驗收見下方 |
| G9 | user 訊息：原樣顯示（只渲染程式碼區塊／行內程式碼）＋畫面超過 10 行摺疊 | ✅ | f6b5f1a（使用者瀏覽器驗證通過）； 教學：`docs/20261103_(G9)user-message-collapse-guide.html`；驗收見下方 |
| G6-1 | 後端：幽靈分支資料欄位 migration、`POST /messages/{id}/regenerate`（原地重新生成＋幽靈化）、`/chats/roots` 過濾、緩衝清除競態修正 | ✅ | 3019e83（migration c6d7e8f9a0b1；假 LLM harness 27 PASS）； 教學：`docs/20261103_(G6)regenerate-guide.html`；驗收見下方 |
| G6-2 | 前端：最後一則 AI 回覆的重傳鈕（主對話＋分支） | ✅ | 7d17035（使用者瀏覽器驗證通過） | 草稿已於 e051fec revert |
| T1 | 對話頁時間軸，效果參考 Gemini Voyager 插件（BACKLOG 第 4 項） | ⏳ 待辦 | 細節待討論；原 Phase 3 圓點列方案與已移除的左欄時間軸（F2-fix）皆不沿用 |
| E1 | 後端：建立分支重疊降級（同一交易）、回傳 `title`／`reused`／`demoted_ids` | ✅ | e13be39（branch_entries_harness 34 PASS、regenerate_harness 47 PASS）；規格見下方「E 規格與驗收」；DESIGN_P3 主題 6 |
| E2 | 後端：幽靈化記原對話、`GET /branches/orphaned`、`POST /branches/{id}/relink`、刪對話前清 `attach_root_id` | ✅ | caeeae1（branch_entries_harness 87 PASS、regenerate_harness 47 PASS）；取代 B3；另加：錨點在分支自己的訊息之下 → 400（避免 parent 循環） |
| E3 | 前端：AI 回覆底部入口（橫線＋每行一個 anchor_text）、建立分支處理 `reused` | ✅ | 2bbf0af（使用者確認換行；含 BUGS B8 入口改可換行）；驗收中發現 B6（873a440）、B7（f785aed） |
| E4 | 前端：分支面板左上角分支列表（滿版覆蓋、依位置排序、點了開分支＋主對話捲到位置）、移除 tab 列 | ✅ | a2f2ce0（使用者瀏覽器確認）；標題旁不加生成中提示（使用者決定） |
| E5 | 前端：選字時「連結幽靈分支」按鈕＋選單、列表的幽靈分支區 | ⏳ 暫停 | 取代 F9 的「幽靈分支重連 UI」；E1–E4 已 merge 回 main（2026-11-05），E5 之後另開 branch；半成品（BranchListOverlay 幽靈區、BranchPanel 傳參）在 `git stash` 「E5 partial」 |

> B2–B4／F9 的拆分以 HANDOVER 為準，尚未寫驗收指令；開工前先補（可執行指令形式）並出教學文件。

### G2–G9（全部已確認）

細節見 `BACKLOG.md`。G1–G4、G7 已完成。

| 編號 | 需求摘要 | 狀態 |
|---|---|---|
| G2 | 分支地圖依「位置順序」排序，不依建立時間 | ✅ 完成（1013464） |
| G3 | 「跳至底部」按鈕不應出現在分支視窗 → 擴大為主對話／分支共用組件 | ✅ 完成（be02ad3、433effe） |
| G4 | 分支對話顯示模型資訊 | ✅ 完成（併入 G3-2，433effe） |
| G5 | 調整選取範圍時保持反黑（手機控制棒／桌面 shift+方向鍵） | ✅ 完成（G5-B3，804d0fd） |
| G6 | 模型回傳錯誤時的重傳機制 → 最後一則回覆一律可重傳 | ✅ 完成（3019e83、7d17035） |
| G7 | 手機版聊天區與分支對話隱藏頭像 | ✅ 完成（0665365；手機主對話無頭像、AI 氣泡無右側留白；分支本來就無頭像） |
| G8 | 複製訊息按鈕 → 訊息功能列 | ✅ 完成（ff6f733） |
| G9 | user 訊息顯示換行，超過 5 行摺疊 → 改為 10 行，只渲染程式碼 | ✅ 完成（f6b5f1a） |

### G3-1／G3-2 規格與驗收（2026-11-01 定稿）

決策見 `docs/20261101_(G3)shared-chat-pane-guide.html` 第 8 節。重點：分支與主對話共用 `MessageList`＋`ChatInput`；分支只差「無頭像、白底（外層容器）、輸入框提示文字」，字級／內距／程式碼區塊／輸入框尺寸全部相同；模型標籤與 user 送出時間比照主對話；分支有模型選單，與主對話共用同一個 `model` state；分支不能再開分支、沒有高亮。

**G3-1 抽取（只動 `MessageList.jsx`、`ChatInput.jsx`，不動 BranchPanel／App）**
- `MessageList` 加 `variant`（預設 `main`）、`MESSAGE_LIST_VARIANTS = { main: { showAvatar: true }, branch: { showAvatar: false } }`、可選 `emptyState`（未傳時用現有建議卡片）。
- 「回到底部」按鈕：外層包 `relative flex-1 min-h-0 flex flex-col`，捲動容器在內，按鈕為捲動容器的兄弟、`absolute bottom-4 right-4`。
- `ChatInput` 加 `variant`（預設 `main`）、`CHAT_INPUT_VARIANTS` 只含 `hint` 提示文字。

驗收：
1. `cd frontend && npm run build` → 結尾印出 `✓ built`
2. `grep -n "fixed bottom-24" frontend/src/components/MessageList.jsx` → 無輸出
3. `grep -c "MESSAGE_LIST_VARIANTS" frontend/src/components/MessageList.jsx` → ≥ 2；`grep -c "CHAT_INPUT_VARIANTS" frontend/src/components/ChatInput.jsx` → ≥ 2
4. `git show --stat HEAD` → 只有 `MessageList.jsx`、`ChatInput.jsx`
5. 瀏覽器（桌面 ≥ 768）：主對話畫面除按鈕位置外不變；往上捲 → 按鈕在主對話區右下、輸入框上方；打開分支面板 → 按鈕仍在主對話區內，不在分支面板上
6. 瀏覽器（手機 < 768）：往上捲 → 按鈕在主對話區右下、不擋輸入框

**G3-2 套用（`BranchPanel.jsx`、`App.jsx`）**
- `BranchPanel` 訊息區改 `<MessageList key={activeBranchId} variant="branch" emptyState=… />`，輸入區改 `<ChatInput variant="branch" … />`；刪除自己的 Markdown／氣泡／textarea／`messagesEndRef` 捲動。
- `App.jsx` 把 `setModel`、`isCustomModel`、`setIsCustomModel`、`freeModels`、`freeModelsLoading` 傳進 `BranchPanel`。
- 分支送出時強制捲到底（比照主對話 `forceScrollToken`）。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -cE "ReactMarkdown|<textarea|SyntaxHighlighter" frontend/src/components/BranchPanel.jsx` → `0`
3. `grep -c 'variant="branch"' frontend/src/components/BranchPanel.jsx` → `2`
4. `git show --stat HEAD` → 只有 `BranchPanel.jsx`、`App.jsx`
5. 瀏覽器（桌面）：分支無頭像；字級與主對話相同；AI 訊息下有模型標籤、user 訊息下有送出時間；輸入框下有模型選單與「分支訊息與主對話各自獨立…」；在分支換模型 → 主對話選單同步變；分支往上捲 → 按鈕在分支面板右下；切 tab → 捲到底；送出 → 捲到底；拖曳把手調寬仍正常、重整後寬度保留
6. 瀏覽器（手機）：分支滿版時有模型選單與「回到底部」按鈕；X 可關閉；選取分支內 AI 文字不出現「建立分支」

### M1 規格與驗收：手機側邊欄三點常駐與長按選單（2026-11-06）

教學與決策表：`docs/20261106_(M1)sidebar-long-press-guide.html`。使用者讀完說「開始」才動工。

| 編號 | 負責 | 內容 | 狀態 |
|---|---|---|---|
| M1 | implementer | `frontend/src/components/Sidebar.jsx` 的 `ChatRow` | ✅ 2026-11-06 使用者瀏覽器驗收通過，已部署 |

- 三點外層：開啟中同現狀；已選取 → 手機常駐、桌面 hover 才顯示；未選取 → 手機透明且 `pointer-events-none`，桌面 hover 才顯示（`md:` 斷點）。
- 長按：掛在列的主按鈕。`touchstart` 重設旗標並開始 500ms 計時；移動超過 10px、`touchend`、`touchcancel` 取消；時間到打開選單並設旗標；`click` 遇到旗標 → 重設並略過；touch 引發的 `contextmenu` 要 `preventDefault`；手機關閉列內文字選取與 touch callout；unmount 清計時器。
- 視覺變更：build 後先不 commit，瀏覽器確認後才 commit。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `git diff --stat` → 程式只改 `Sidebar.jsx`
3. 瀏覽器（手機 < 768）：已選取列常駐三點、可開選單；未選取列沒有三點，點列右側是進入對話；長按任一列開選單且不切換對話；放開後選單仍在；點選單外關閉；短按正常進入對話；長按後下一次短按正常；在列上滑動是捲動，不開選單；長按不會選到文字或跳出系統選單；最後一列的選單不被裁切
4. 瀏覽器（桌面 ≥ 768）：三點仍只在 hover 或選單開啟時顯示；點列進入對話；右鍵仍是瀏覽器選單；標題遮罩與選單位置不變

### B11 規格與驗收：刪除有分支的對話（2026-11-06）

教學與決策表：`docs/20261106_(B11)delete-chat-guide.html`。使用者讀完說「開始」才動工。不需要 migration。

| 編號 | 負責 | 內容 | 狀態 |
|---|---|---|---|
| B11-1 | implementer | 後端：刪除範圍、三步刪除、錯誤回應、harness | ✅ 431b4fd（branch_entries 107、regenerate 47、auth 131 PASS；本機資料副本 32 個對話全量刪除無失敗、無多刪） |
| B11-2 | implementer | 前端：失敗提示、確認文字、關閉已刪對話的分支面板 | ✅ 2026-11-06 本機桌面與手機瀏覽器驗收通過，已部署 |

**B11-1 後端（`backend/main.py`、`backend/dev/branch_entries_harness.py`、`backend/dev/auth_harness.py`）**
- `DELETE /chats/{root_id}` 維持開頭的 `get_owned_message` 檢查，不是本人的回 404。
- 刪除範圍取到不再變大為止：訊息集合 D 起始為 `root_id` 的所有子孫（含自己）；分支集合 B＝`anchor_message_id`、`root_message_id` 或 `attach_root_id` 落在 D，或 `id` 被 D 內訊息的 `branch_id` 引用的分支；再把 B 內分支的 `root_message_id` 子孫與 `branch_id` 屬於 B 的訊息加入 D，重複。
- 刪除前檢查 D、B 全部的 `user_id` 都等於目前使用者；不符 → rollback、寫 log、回 500（固定訊息），不刪任何資料。
- 同一個交易依序：B 的 `anchor_message_id`、`root_message_id`、`attach_root_id` 設 NULL；不在 B 但 `parent_branch_id` 落在 B 的分支，`parent_branch_id` 設 NULL；B 自身的 `parent_branch_id` 設 NULL；一條 SQL 刪 D；一條 SQL 刪 B。取代原本由深到淺逐則刪除與清空 `attach_root_id` 的做法。
- commit 失敗：rollback、完整錯誤寫 log、回 500 `{"detail": "Failed to delete chat"}`，不回傳 `str(e)`。
- 成功回 `{"status": "ok", "deleted_count": <D 筆數>, "deleted_branches": <B 筆數>}`。
- `attach_root_id` 為 NULL 的舊幽靈不在範圍內，保留不動。
- harness：E2-9 改成新行為（幽靈與其訊息一起刪）；`auth_harness.py` 的 A flow 刪除改用含分支的對話，移除 B11 註解。

驗收：
1. `docker compose ps` → chat_db running
2. 三支 harness 在臨時資料庫執行（`POSTGRES_DB=<臨時庫> SQL_ECHO=false uv run python dev/<名稱>.py 2>&1 | grep -v sqlalchemy | tail -5`）：`branch_entries_harness`、`regenerate_harness`、`auth_harness` → 都 `ALL PASS`。新增涵蓋：
   - inline 分支、底部入口、空分支、分支內有多輪訊息的對話 → 200，訊息與分支都不存在，`deleted_count`、`deleted_branches` 正確
   - 有幽靈（含幽靈的訊息、幽靈回覆上再錨定的分支）→ 全部刪除
   - `attach_root_id` 為 NULL 的舊幽靈、別的對話及其分支、別的使用者的資料 → 欄位與筆數不變
   - `parent_branch_id` 指向 B、自身不在 B 的分支 → 保留，`parent_branch_id` 為 NULL
   - B 刪 A 的對話 → 404，資料不變；範圍內混到別人的資料 → 500、不刪任何資料
   - 強制 commit 失敗 → 500、回應不含 SQL 或表名、資料不變
   - 生成中刪除（假 LLM）→ 200，生成結束不報錯、訊息不會重新出現
3. `grep -n 'str(e)' backend/main.py` → `delete_chat` 範圍內無輸出
4. `git show --stat HEAD` → 只有上列 3 個檔案

**B11-2 前端（`frontend/src/App.jsx`）**
- `handleDeleteChat`：檢查回應。`res.ok` 或 404 → 走成功流程；401 → 不提示（`apiFetch` 已處理）；其他 → `alert("刪除失敗，請稍後再試")`，對話留在列表，畫面不變。
- 確認文字改為「確定要刪除這個對話串嗎？其中的分支也會一起刪除。此動作無法復原。」
- 刪的是目前開著的對話：除了 `startNewChat()`，也關閉分支面板、清空 `activeBranchId`、`branches`。
- 視覺變更：build 後先不 commit，瀏覽器確認後才 commit。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -c "res.ok\|response.ok" frontend/src/App.jsx` 比修改前多 1 以上；`grep -c "其中的分支也會一起刪除" frontend/src/App.jsx` → 1
3. `git show --stat HEAD` → 只有 `frontend/src/App.jsx`
4. 瀏覽器（桌面 ≥ 768、手機 < 768 各一次）：刪含高亮分支的對話 → 從列表消失；開著該對話和分支面板時刪除 → 回到新對話、面板關閉；刪別的對話 → 目前畫面與面板不變；模擬 500 → 看到錯誤、對話仍在；重新整理後狀態一致

### S-U1 規格與驗收：資料綁定使用者（2026-11-05 定稿）

教學與決策表：`docs/20261105_(S-U1)user-ownership-guide.html`。對應安全性清單第 1 項。Cloudflare Access 在 S-U1 全程保留；移除前提是 S-U2（BACKLOG）。
在 branch `feat/s-u1-user-ownership` 開發（使用者說「開始」後才建立；其他 session 共用此資料夾時改用 worktree）。S-U1-1～S-U1-7 驗收後 merge 回 main。
波次：W1＝S-U1-1→5（後端，依序、同一 branch，不需停下等驗證）；W2＝S-U1-6→7（前端，依序，瀏覽器驗證後才 commit S-U1-7）；W3＝S-U1-8（使用者部署與驗證）；W4＝S-U1-9（第 4 項決策定案後）。
所有 harness 不呼叫真模型、真 OAuth，資料用唯一識別建立並在結束時清除。每個後端任務開工前先 `docker compose ps` 確認 chat_db 為 running，不是就停下回報。

| 編號 | 負責 | 內容 | 狀態 |
|---|---|---|---|
| S-U1-1 | implementer | B10：state cookie 改名、登入流程 harness | ✅ 6541856 |
| S-U1-2 | implementer | `/auth/me`、POST 登出、OAuth 失敗導回 | ✅ ffd9565 |
| S-U1-3 | implementer | `user_id` 欄位（允許 NULL）、唯一約束 migration | ✅ 551ca95（revision d7e8f9a0b1c2） |
| S-U1-4 | implementer | 所有路由加登入與擁有者檢查、隔離 harness | ✅ c2015b8（發現既有 bug B11） |
| S-U1-5 | implementer | 舊資料認領腳本 | ✅ 897d976（auth_harness 187 PASS） |
| S-U1-6 | implementer | 前端 `apiFetch`、移除 `session_id` | ✅ 61a2733 |
| S-U1-7 | implementer | 登入閘門、登入頁、帳號區 | ✅ a721e2e、3ebc03e（本機 compose 傳 OAuth 變數）；2026-11-05 本機真實 Google/GitHub 登入與隔離驗收通過 |
| S-U1-8 | 使用者 | OAuth 主控台與 VM 設定、部署、認領、真實登入與隔離驗證 | ✅ 2026-11-06 完成：部署與驗收 1～15 通過；認領後正式站可見舊對話；VM `message`、`branch` 的 NULL 筆數皆為 0，dump 存在 |
| S-U1-9 | implementer | `user_id` NOT NULL、刪 `session_id` | ✅ fc3e92d（merge ca491d1，revision e8f9a0b1c2d3）；臨時資料庫驗收通過（auth 130、regenerate 47、branch_entries 84 PASS）；2026-11-06 VM 部署完成，備份、migration、欄位檢查與正式站對話驗證皆通過 |

**S-U1-1 B10（`backend/main.py`、新檔 `backend/dev/auth_harness.py`）**
- `SessionMiddleware` 加 `session_cookie="oauth_state"`、`max_age=600`、`same_site="lax"`、`https_only=cookie_secure()`（`cookie_secure` 從 `auth_routes` import）。
- harness：真 uvicorn（`127.0.0.1:8767`），沿用 `branch_entries_harness.py` 的寫法。假 provider：patch `auth_routes.is_provider_configured`、`oauth.github.authorize_redirect`（把 `_state_github_<state>` 存進 `request.session` 並導向 callback）、`oauth.github.authorize_access_token`（pop 同一個 key，回傳假 token）、`auth_routes._fetch_github_user`。
- 登入流程必須用 `curl -b <jar> -c <jar>` 重播，並直接檢查 callback 的 `Set-Cookie` 標頭；不可用 httpx／TestClient 的 cookie jar 判斷（它們會掩蓋 B10）。

驗收：
1. `docker compose ps` → chat_db running
2. `cd backend && uv run python dev/auth_harness.py 2>&1 | grep -v sqlalchemy | tail -15` → 每項 PASS，最後一行 `ALL PASS`。涵蓋：login 回應只設 `oauth_state`、不設 `session`；callback 的 `Set-Cookie` 中 `session` 只出現一次且值不是 `null`、`oauth_state` 被清除；curl 重播後 cookie 檔內有 `session`；把 `session_cookie` 改回預設時此項 FAIL（implementer 暫時改動以確認測得出來，不 commit）
3. `git show --stat HEAD` → 只有 `main.py`、`auth_harness.py`
4. commit 後把 BUGS B10 狀態改為「已修，待真實瀏覽器驗證（S-U1-8）」，獨立 `docs:` commit

**S-U1-2 認證端點（`backend/auth_routes.py`、`backend/dev/auth_harness.py`）**
- 新增 `GET /auth/me`（`Depends(get_current_user)`）：回 `{ "email": ..., "provider": ... }`，不回 id，header `Cache-Control: no-store`。
- `GET /auth/logout` 改成 `POST /auth/logout`，行為不變。
- provider 未設定：login 改為 303 導向 `FRONTEND_URL/?auth_error=provider_unavailable`（不存在的 provider 仍 404）。
- callback 內 `authorize_access_token` 或取使用者資料拋例外（使用者拒絕授權、state 不符、provider 出錯）、或拿不到 sub → 303 導向 `FRONTEND_URL/?auth_error=login_failed`，不建立使用者與 session，例外細節只寫 log。

驗收：
1. `cd backend && uv run python dev/auth_harness.py 2>&1 | grep -v sqlalchemy | tail -25` → `ALL PASS`。新增涵蓋：`/auth/me` 無 cookie → 401、亂造 token → 401、過期 session → 401 且該列被刪、有效 → 200 且 JSON 鍵只有 `email`、`provider`；`GET /auth/logout` → 405；`POST /auth/logout` → 該 token 再打 `/auth/me` 為 401；provider 未設定 → 303 含 `auth_error=provider_unavailable`；假 provider 拋例外 → 303 含 `auth_error=login_failed`、`user` 與 `auth_session` 筆數不變
2. `git show --stat HEAD` → 只有 `auth_routes.py`、`auth_harness.py`

**S-U1-3 資料欄位（`backend/models.py`、新 migration）**
- `Message`（table class，不放 `MessageBase`）與 `Branch` 加 `user_id: Optional[uuid.UUID]`，FK `user.id`，有 index，允許 NULL，API 回應不輸出此欄位。
- `user` 加唯一約束 `(oauth_provider, oauth_sub)`；`auth_session.token_hash` 改唯一。migration 寫完整 downgrade。
- 不改任何路由（下一步才用）。

驗收：
1. `cd backend && uv run alembic upgrade head && uv run alembic current` → 新 revision 為 head
2. `docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d message" -c "\d branch" -c "\d \"user\"" -c "\d auth_session"'` → 兩表都有可為 NULL 的 `user_id` 與 FK；`user`、`auth_session` 有唯一約束
3. `cd backend && uv run alembic downgrade -1 && uv run alembic upgrade head` → 都成功，訊息與分支筆數不變
4. `cd backend && uv run python dev/regenerate_harness.py 2>&1 | grep -v sqlalchemy | tail -3` 與 `uv run python dev/branch_entries_harness.py 2>&1 | grep -v sqlalchemy | tail -3` → 都 `ALL PASS`
5. `git show --stat HEAD` → 只有 `models.py`、新 migration

**S-U1-4 路由保護（`backend/main.py`、`backend/models.py`、`backend/dev/auth_harness.py`、`backend/dev/regenerate_harness.py`、`backend/dev/branch_entries_harness.py`、`backend/dev/seed_chats.py`）**
- 新增 `get_owned_message(session, id, user)`、`get_owned_branch(session, id, user)`：不存在或 `user_id != user.id`（含 NULL）→ 404。
- 除 `/`、`/auth/*` 外，每條路由加 `user: User = Depends(get_current_user)`。
- 刪除 `GET /messages`、未使用的 `save_ai_message_sync`。`/docs`、`/redoc`、`/openapi.json` 只在環境變數 `ENABLE_API_DOCS` 為真時開啟，預設關閉。
- `ChatRequest` 移除 `session_id`。新寫入一律不再指定 `session_id`，欄位暫留到 S-U1-9。

| 路由 | 擁有者檢查（都在任何寫入、LLM 呼叫之前） |
|---|---|
| `POST /chat` | `parent_id`、`branch_id`、`anchor_message_id` 有帶的都要屬於本人；user 與 AI 訊息寫入 `user_id` |
| `GET /messages/{id}/stream` | **先**檢查訊息屬於本人，再查 `GENERATIONS` |
| `POST /messages/{id}/regenerate` | AI 訊息屬於本人 |
| `GET /chats/roots` | 移除 `session_id` 參數；兩種排序都用 `user_id` 過濾根訊息 |
| `GET /chats/{id}/history`、`/tree` | 起點屬於本人；不存在時由空陣列改回 404 |
| `PATCH /chats/{id}/title`、`DELETE /chats/{id}` | 起點屬於本人 |
| `POST /chats/{id}/branches` | root、anchor 都屬於本人；新分支寫入 `user_id` |
| `GET /chats/{id}/branches` | root 屬於本人 |
| `GET /branches/orphaned` | 移除 `session_id` 參數；只用 `Branch.user_id` 過濾 |
| `POST /branches/{id}/relink` | 分支、root、anchor 都屬於本人；取代原本比對 session 的邏輯 |
| `GET /api/free-models` | 只要求登入 |

- harness 測試方式：直接建立 `User`＋`AuthSession`，用 `Cookie: session=<token>` 打 API（沿用真 uvicorn＋假 LLM）。既有兩支 harness 改成這樣登入，原有測項全部保留；`/branches/orphaned` 的隔離測項改用兩個使用者。`seed_chats.py` 改收 `--provider`、`--email`，寫入 `user_id`。

驗收：
1. `docker compose ps` → chat_db running
2. `cd backend && uv run python dev/auth_harness.py 2>&1 | grep -v sqlalchemy | tail -50` → `ALL PASS`。新增涵蓋：
   - 列舉 `main.app.routes`：未登入呼叫每條路由 → 401，例外只有 `/`、`/auth/*`，以及 `ENABLE_API_DOCS` 關閉時不存在的文件路由
   - 使用者 B 對 A 的資料呼叫上表每條路由 → 404，且 A 的訊息內容、標題、分支欄位都沒變，假 LLM 未被呼叫
   - B 用 A 的 `parent_id`、`branch_id`、`anchor_message_id` 打 `/chat` → 404，訊息筆數不變
   - A 的回覆生成中，B 打 `/messages/{id}/stream` → 404（證明先查擁有者再查緩衝）
   - `user_id` 為 NULL 的舊訊息與分支：每個登入者都讀不到、`/chats/roots` 不列出
   - A 自己的完整流程：送訊息、取清單、重傳、建立分支、在分支送訊息、幽靈化、重連、刪除都正常
   - `SELECT count(*) FROM message c JOIN message p ON c.parent_id=p.id WHERE c.user_id IS DISTINCT FROM p.user_id` 限本次測試資料 → 0
   - 回應 JSON 都不含 `user_id`
3. `cd backend && uv run python dev/regenerate_harness.py 2>&1 | grep -v sqlalchemy | tail -3` 與 `uv run python dev/branch_entries_harness.py 2>&1 | grep -v sqlalchemy | tail -3` → 都 `ALL PASS`
4. `cd backend && env -u ENABLE_API_DOCS uv run python -c "import main; print(main.app.docs_url, main.app.openapi_url)" 2>/dev/null | tail -1` → `None None`
5. `grep -n "save_ai_message_sync\|session_id" backend/main.py` → 無輸出
6. `git show --stat HEAD` → 只有上列檔案

**S-U1-5 認領腳本（新檔 `backend/claim_legacy_data.py`、`backend/dev/auth_harness.py`）**
- 參數：`--provider`、`--email`（找不到或多於一位 → 非 0 結束）、可重複的 `--session-id`、`--apply`。沒帶 `--apply` 只印數字、不寫入。
- 同一個交易：`session_id` 符合且 `user_id` 為 NULL 的訊息設為該使用者；`user_id` 為 NULL 的分支，依序取錨點訊息、首則訊息、`attach_root_id` 訊息的 `user_id`，落在本次使用者時才設定。已有 `user_id` 的資料不動。
- 分開列印：認領的訊息數與分支數、仍為 NULL 的訊息數（依 `session_id`）、仍為 NULL 的分支數、其中查不到擁有者的分支數。
- 新增 `--delete-ownerless-branches`（需同時帶 `--apply`）：刪除三個來源都是 NULL 的分支。
- 寫入前檢查：有父子 `user_id` 不一致（雙方都非 NULL）就 rollback 並非 0 結束。
- 剩餘資料的處理（決策 4）不在此任務；定案後另補規格。

驗收：
1. `cd backend && uv run python dev/auth_harness.py 2>&1 | grep -v sqlalchemy | tail -60` → `ALL PASS`。新增涵蓋：試算不寫入；`--apply` 後訊息與分支（錨定、底部入口、幽靈、尚無訊息）歸屬正確；已歸他人的資料不動；別的 session 的資料不動；重跑結果相同；email 不存在 → 非 0；`--delete-ownerless-branches` 只刪沒有擁有者的分支；父子不一致 → 非 0 且全部 rollback
2. `git show --stat HEAD` → 只有 `claim_legacy_data.py`、`auth_harness.py`

**S-U1-6 前端 API 層（新檔 `frontend/src/api.js`、`frontend/src/App.jsx`、`frontend/src/BranchTreeModal.jsx`）**
- `apiFetch(path, options)`：組上 `VITE_API_URL`、`credentials: 'include'`；回應 401 時 `window.dispatchEvent(new Event('auth:unauthorized'))`；回傳 response。
- `App.jsx`、`BranchTreeModal.jsx` 全部 `fetch` 改用它。
- 移除 `sessionId` state 與請求中的 `session_id`；App 掛載時 `localStorage.removeItem('chat_session_id')`。
- 此任務沒有登入畫面，本機要到 S-U1-7 才能在瀏覽器完整操作；無視覺變更，可直接 commit。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -nE "\bfetch\(" frontend/src/App.jsx frontend/src/BranchTreeModal.jsx` → 無輸出；`grep -c "credentials: 'include'" frontend/src/api.js` → `1`
3. `grep -n "session_id\|sessionId" frontend/src/App.jsx` → 只有 `removeItem('chat_session_id')` 一行
4. `git show --stat HEAD` → 只有上列 3 個檔案

**S-U1-7 登入閘門（新檔 `frontend/src/components/AuthGate.jsx`、`frontend/src/main.jsx`、`frontend/src/App.jsx`、`frontend/src/components/Sidebar.jsx`、新檔 `backend/dev/dev_session.py`）**
- `AuthGate`：mount 時 `GET /auth/me`。確認中不渲染、未登入顯示登入頁、已登入才掛載 `<App user={user} />`；收到 `auth:unauthorized` → 回登入頁（App 卸載，草稿不保留）。網路錯誤也視為未登入。
- 登入頁（全螢幕）：產品名稱＋「使用 Google 繼續」「使用 GitHub 繼續」，都是一般連結 `${VITE_API_URL}/auth/{provider}/login`。`?auth_error=` 有值時顯示固定中文訊息（不顯示參數原文），並用 `history.replaceState` 從網址移除。
- `Sidebar` 底部帳號區：Email（沒有就顯示「GitHub 帳號」／「Google 帳號」）＋登入方式圖示＋「登出」。登出：`POST /auth/logout` → `window.location.replace('/')`。
- `backend/dev/dev_session.py --provider --email`：只供本機；建立使用者與 `AuthSession`，印出可貼到 console 的 `document.cookie="session=...; path=/"`。不掛任何路由。讓本機瀏覽器驗證不需要真實 OAuth；本機對話要先用 `claim_legacy_data.py` 認領才看得到。token 不寫進 repo、不貼到聊天。
- 視覺變更：build 後先不 commit，給使用者調整參數，確認後才 commit。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -c "AuthGate" frontend/src/main.jsx` → ≥ 1；`grep -c "/auth/logout" frontend/src/components/Sidebar.jsx frontend/src/App.jsx | grep -v ":0"` → 至少一行
3. `git show --stat HEAD` → 只有上列 5 個檔案
4. 瀏覽器（桌面 ≥ 768，假 LLM）：未登入 → 只看到登入頁、Network 沒有 `/chats/*` 請求；`?auth_error=login_failed` → 顯示訊息且網址參數消失；設定 dev session 後重新整理 → 進入 App、側邊欄底部有帳號與登出；既有功能正常（送訊息、切換對話續讀串流、重傳、編輯、建立與開啟分支、分支地圖、改名、刪除）；console 刪掉 session 列或另開分頁登出後，下一個請求 → 回登入頁且對話內容消失；按登出 → 回登入頁、重新整理仍是登入頁；換另一個 dev 使用者 → 看不到前一位的對話；側邊欄拖寬、時間軸與底部帳號區不重疊
5. 瀏覽器（手機 < 768）：登入頁按鈕在畫面內可點；側邊欄 drawer 底部有帳號與登出，不被瀏覽器工具列擋住；其餘同桌面

**S-U1-8 使用者：部署與真實驗證（implementer 不執行）**

前置：
1. Google 與 GitHub 主控台 callback 設為 `https://fluentbranch.com/api/auth/{provider}/callback`；client id／secret 放進 VM `.env`。
2. 部署前備份並檢查（VM）：
   - `sudo docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ~/fluentbranch-before-s-u1.dump`（必須加 `-T`，避免 TTY 破壞二進位檔）
   - `sudo docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select oauth_provider, oauth_sub, count(*) from \"user\" group by 1,2 having count(*)>1"'` → 0 列（有重複時唯一約束 migration 會失敗，先回報）

部署（VM）：`git pull` → `sudo docker compose up -d --build` → `sudo docker compose exec api alembic upgrade head`。

驗收：
1. 用已通過 Access 但尚未登入 App 的瀏覽器，在 console 執行：`fetch('/api/chats/roots').then(r=>r.status)` → `401`；`fetch('/api/docs').then(r=>r.status)` → `404`；登入後 `fetch('/api/messages').then(r=>r.status)` → `404`
2. 真實 Google、GitHub 各登入一次（瀏覽器 DevTools 確認 `session` cookie 為 HttpOnly、Secure），BUGS B10 改為已完成；拒絕授權 → 回登入頁並顯示訊息
3. 認領（VM）：先 `sudo docker compose exec api python claim_legacy_data.py --provider ... --email ... --session-id ...` 看數字，再加 `--apply`；登入後舊對話、分支都在
4. 跨帳號：Google 帳號開一則對話，複製 root id；GitHub 帳號在 console 執行 ``fetch(`/api/chats/${id}/history`).then(r=>r.status)`` → `404`；側邊欄看不到該對話
5. 真實模型送一則訊息（使用者執行）→ 正常串流
6. `sudo docker compose logs api --tail 50` → 沒有 token、client secret 或訊息內容

**S-U1-9 收縮（`backend/models.py`、新 migration、`backend/dev/*`）— 等決策 4 定案、S-U1-8 完成才開工**
- migration：開頭檢查 `message`、`branch` 的 `user_id` 是否還有 NULL，有就中止並印出筆數；`user_id` 改 NOT NULL；`message` 刪除 `session_id`。downgrade 加回 `session_id`（值為 `default`）並改回可為 NULL。
- 刪除 `MessageBase.session_id` 與 `backend/migrate.py`。`claim_legacy_data.py` 用途結束，一併刪除。
- 部署順序：VM 上先確認兩表 NULL 筆數為 0，部署新程式後立刻 `alembic upgrade head`。`message.session_id` 目前是 NOT NULL 且沒有資料庫預設值，兩個動作之間新增訊息會失敗，所以選低使用時段、接受這段短暫中斷（Access 仍在，使用者只有白名單）。

驗收：
1. 有 NULL 時：`cd backend && uv run alembic upgrade head` → 非 0 且資料表不變
2. 無 NULL 時：`cd backend && uv run alembic upgrade head` 成功；`docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d message"'` → `user_id` 為 not null、無 `session_id`
3. `cd backend && uv run python dev/auth_harness.py 2>&1 | grep -v sqlalchemy | tail -3`、`regenerate_harness.py`、`branch_entries_harness.py` → 都 `ALL PASS`
4. `grep -rn "session_id" backend/main.py backend/models.py backend/dev/` → 無輸出（`auth_session` 不算）

### H 規格與驗收：fluentbranch.com HTTPS 上線（2026-11-04 定稿）

教學與決定：`docs/20261104_fluentbranch-https-guide.html`。

| 編號 | 負責 | 內容 | 狀態 |
|---|---|---|---|
| H0 | 使用者 | Cloudflare Access 臨時門禁，白名單 Email | 完成（2026-11-05） |
| H1 | 使用者 | 確認 Elastic IP；Origin Certificate 放到 VM `/etc/fluentbranch/tls/`；VM `.env` 加 `SESSION_SECRET_KEY` | 完成（2026-11-05） |
| H2 | implementer | 新增 `frontend/nginx.prod.conf`；修改 `docker-compose.prod.yml` | 完成並本機驗證（7be69e3）；已由 H3 部署 |
| H3 | 使用者 | VM 部署；切 Full (strict)；開 Always Use HTTPS | 完成（2026-11-05） |
| H4 | 使用者 | Security Group：443 只開 Cloudflare IP，移除 80 對外 | 完成（2026-11-05） |

H2 驗收：
1. nginx 以測試憑證執行 `nginx -t` → `test is successful`
2. `SESSION_SECRET_KEY=x docker compose -f docker-compose.prod.yml config --quiet` → exit 0；移除該變數 → 非 0 並提示 `SESSION_SECRET_KEY is required`
3. uvicorn 以 `--root-path /api --forwarded-allow-ips '*'` 啟動，`GET /auth/github/login` 帶 `Host: fluentbranch.com`、`X-Forwarded-Proto: https` → 302，`redirect_uri` 為 `https://fluentbranch.com/api/auth/github/callback`
4. `git show --stat HEAD` → 只有 `frontend/nginx.prod.conf`、`docker-compose.prod.yml`

H3／H4 驗收：教學第 6 節「驗收指令」。

### E 規格與驗收：分支入口、重疊降級、分支列表、幽靈重連（2026-11-04 定稿）

設計見 DESIGN_P3 主題 6；決策見 `docs/20261104_(E)branch-entries-guide.html` 決策表。在 branch `feat/branch-entries` 開發，E1–E5 全部驗收後 merge 回 main。
波次（每波停下等使用者驗證）：W1＝E1→E2（後端，同一個 implementer 依序兩個 commit）；W2＝E3；W3＝E4；W4＝E5。前端三個任務都動 `App.jsx`，一律依序。

**E1 後端：建立分支重疊降級（`backend/main.py`、新檔 `backend/dev/branch_entries_harness.py`）**
- 抽出共用函式 `demote_overlaps(session, anchor_message_id, start, end, exclude_id=None) -> list[str]`：找同一 `anchor_message_id`、`is_orphaned=False`、`anchor_start／end` 皆非空、且 `舊.start < end and start < 舊.end` 的分支 → `anchor_start=anchor_end=None`（其他欄位不動），回傳被降級的 id。不 commit，由呼叫端統一 commit。
- `POST /chats/{root_id}/branches`：驗證通過後（含下方 offset 驗證），若有帶 start／end：先找「同一則、範圍完全相同、非幽靈」的分支 → 有就**不新建**，直接回傳它（`reused: true`、`demoted_ids: []`）；否則呼叫 `demote_overlaps`，再建新分支，同一個 commit。沒帶 start／end → 不檢查重疊（直接成為底部入口）。
- 輸入驗證（安全性）：`anchor_start`／`anchor_end` 只帶一個 → 422；有帶時必須 `0 <= start < end <= len(anchor 訊息 content)`，否則 422（在任何寫入之前）。
- 回傳加 `title`、`reused`、`demoted_ids`；原有欄位不變。
- harness：沿用 `regenerate_harness.py` 的寫法（真 uvicorn、假 LLM、唯一 session_id 建資料、結束清掉；port 用 8766 避免和舊 harness 衝突）。

驗收：
1. `docker compose ps` → chat_db 為 running（不是就停下回報）
2. `cd backend && uv run python dev/branch_entries_harness.py 2>&1 | grep -v sqlalchemy | tail -30` → 每項 PASS，最後一行 `ALL PASS`。涵蓋：無重疊 → `reused=false`、`demoted_ids=[]`；部分重疊 → 舊的 start／end 為 NULL、`anchor_message_id`／`anchor_text`／`title` 不變，新的有 offset，`demoted_ids` 含舊 id；同時重疊兩個 → 兩個都降級；相鄰（舊.end == 新.start）→ 不降級；範圍完全相同 → `reused=true`、`branch_id` 等於既有、branch 筆數不變；不同則訊息同樣 offset → 不降級；不帶 offset 建立 → 不降級任何分支；只帶 start 不帶 end、start >= end、end 超過回覆長度 → 422 且 branch 筆數不變；`GET /chats/{root}/branches` 中被降級者 `precise=false`
3. `cd backend && uv run python dev/regenerate_harness.py 2>&1 | grep -v sqlalchemy | tail -3` → `ALL PASS`
4. `git show --stat HEAD` → 只有 `main.py`、`branch_entries_harness.py`

**E2 後端：幽靈清單與重連（`backend/main.py`、`backend/dev/branch_entries_harness.py`）**
- `POST /messages/{id}/regenerate` 幽靈化時：`attach_root_id` = 該 AI 回覆所在對話的樹根 id（parent_id 為 NULL 的祖先）。
- `DELETE /chats/{root_id}`：刪訊息前，把 `attach_root_id` 落在要刪的訊息 id 內的分支設為 NULL（同一個交易）。（2026-11-06 將由 B11-1 取代：幽靈跟著對話一起刪）
- `GET /branches/orphaned?session_id=`：`is_orphaned=True`，且（`attach_root_id` 那則訊息的 `session_id` 等於參數，或 `attach_root_id` 為 NULL 且分支首則訊息 `root_message_id` 的 `session_id` 等於參數）；依 `created_at` 新到舊；欄位 `id, title, anchor_text, root_message_id, created_at`。
- `POST /branches/{branch_id}/relink`，body `{ root_id, anchor_message_id, anchor_start, anchor_end, anchor_text }`：分支不存在，或幽靈的歸屬 session（`attach_root_id` 那則訊息的 session_id；為 NULL 時用分支首則訊息的 session_id；兩者都沒有 → 視為不屬於任何人）與 `root_id` 那則訊息的 session_id 不同 → 一律 404（不洩漏是否存在，安全性）；`is_orphaned` 不是 True → 409；offset 驗證同 E1（422）；錨點不存在 → 404、不在 root 這棵樹 → 400（沿用 create_branch 的檢查）；同一則上有範圍完全相同的非幽靈分支 → 409（不寫入）。通過後同一個 commit：`demote_overlaps(..., exclude_id=branch_id)`；設 `anchor_message_id／anchor_start／anchor_end／anchor_text`、`is_orphaned=False`、`attach_root_id=None`、`title` 不變；分支首則訊息（若有）`parent_id` 與 `anchor_message_id` 設為新錨點；樹根 `has_branch=True`。回傳格式同建立分支（`reused=false`）。

驗收：
1. `docker compose ps` → chat_db running
2. `cd backend && uv run python dev/branch_entries_harness.py 2>&1 | grep -v sqlalchemy | tail -40` → `ALL PASS`。新增涵蓋：regenerate 幽靈化後 `attach_root_id` = 樹根；`GET /branches/orphaned?session_id=<sid>` 含該幽靈，換一個 session_id → 不含；`attach_root_id` 為 NULL 但首則訊息屬於 sid 的舊資料 → 含；relink 非幽靈 → 409；錨點在別的對話 → 400；別的 session 的幽靈連到自己的對話 → 404 且幽靈欄位未變；offset 超出範圍或 start >= end → 422；relink 成功 → 欄位如上、首則訊息 `parent_id` == 新錨點、`GET /chats/{root}/branches` 含它、`GET /branches/orphaned` 不含它；relink 時重疊 → 舊的降級；relink 範圍與既有完全相同 → 409 且幽靈欄位未變；有幽靈 `attach_root_id` 指向的對話被刪 → 200，幽靈仍存在且 `attach_root_id` 為 NULL；relink 後在分支送訊息（假 LLM）→ 收到的 history 以新錨點為上下文
3. `cd backend && uv run python dev/regenerate_harness.py 2>&1 | grep -v sqlalchemy | tail -3` → `ALL PASS`
4. `git show --stat HEAD` → 只有 `main.py`、`branch_entries_harness.py`

**E3 前端：底部入口（`frontend/src/components/MessageList.jsx`、`frontend/src/App.jsx`）**
- `MessageList`（只在 `variant === 'main'`）：AI 回覆內容下方、功能列上方，若有「`anchor_message_id === msg.id` 且 `precise === false`」的分支 → 一條橫線，下方每個入口一行，顯示 `anchor_text`（空則顯示 `title`），沿用 inline 高亮的顏色樣式，單行、超出截斷；依 `created_at` 排序；點擊 → `onBranchClick`（同點 inline 高亮）。入口元素掛 `data-branch-entry={id}`（E4 捲動用）。
- 移除舊的 `buildAnchorSegments` 切段 fallback（`renderContent` 中沒有 offset 的分支不再用 anchor_text 子字串高亮）：沒有 offset 的分支一律只出現在底部入口，否則被降級的分支會同時以子字串高亮＋底部入口出現兩次。
- `handleCreateBranch`：`data.reused` 為 true → 不建新 tab，改用 `openBranchFromHighlight`（以 `branchList` 中該 id 的物件）；新 tab 標題改用 `data.title`。其餘不變（仍 `loadBranchList`）。
- 視覺變更：build 後先不 commit，給使用者調整參數，確認後才 commit。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -c "data-branch-entry" frontend/src/components/MessageList.jsx` → ≥ 1；`grep -c "reused" frontend/src/App.jsx` → ≥ 1；`grep -c "buildAnchorSegments" frontend/src/components/MessageList.jsx` → 0
3. `git show --stat HEAD` → 只有 `MessageList.jsx`、`App.jsx`
4. 瀏覽器（桌面 ≥ 768）：選一段與既有高亮部分重疊的文字 → 建立分支 → 新的變 inline 高亮、舊的高亮消失並出現在該則回覆底部（橫線下一行）；點底部入口 → 右欄開舊分支；選與既有高亮完全相同的範圍 → 不新增、直接開既有分支；沒有入口的回覆沒有橫線；被降級的舊分支文字在回覆中已無任何高亮（只在底部入口）；重新整理後狀態一致；分支面板內的回覆沒有入口區
5. 瀏覽器（手機 < 768）：底部入口顯示一行一個、點了開分支 drawer；長按 AI 選字建立分支的重疊行為同桌面

**E4 前端：分支列表＋移除 tab 列（新檔 `frontend/src/components/BranchListOverlay.jsx`、`BranchPanel.jsx`、`App.jsx`）**
- 移除 `BranchPanel` 的 tab 列（2026-11-04 使用者確認）：面板只顯示 `activeBranchId` 那一條；App 的 `branches` 陣列保留當作已載入分支的快取（背景生成照常寫入，切回來接續顯示），只是不再列成 tab。header 標題改為目前分支標題（單行截斷；沒有開分支時「分支對話」），副標只顯示模型。
- `BranchPanel` header 左上角分支圖示改成按鈕（`aria-label="分支列表"`），點了在面板內顯示 `BranchListOverlay`（`absolute inset-0` 蓋住整個面板，含 header），左上角 X 關閉。
- 清單：App 傳入 `branchList` 與主對話 `messages`。排序鍵 `(訊息在 messages 的 index, precise ? 0 : 1, precise ? anchor_start : created_at)`；anchor 不在目前 messages 裡的排最後。每項：標題（單行）＋ `anchor_text` 前 40 字（灰色小字，單行）。
- 點一項 → 關閉清單、`openBranchFromHighlight(branch)`（面板換成這條），並在主對話捲動：precise → `[data-branch="id"]`，否則 → `[data-branch-entry="id"]`，`scrollIntoView({ block: 'center', behavior: 'smooth' })`。手機：分支 drawer 開著時主對話被蓋住，捲動照做（關 drawer 後看得到）。
- 沒有分支 → 清單顯示「目前對話還沒有分支」。
- 視覺變更：先不 commit。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -c "BranchListOverlay" frontend/src/components/BranchPanel.jsx` → ≥ 1；`grep -c "scrollIntoView" frontend/src/App.jsx frontend/src/components/*.jsx | grep -v ":0"` → 至少一行
3. `git show --stat HEAD` → 只有上列 3 個檔案
4. 瀏覽器（桌面 ≥ 768）：分支面板沒有 tab 列；header 顯示目前分支標題；點主對話另一個高亮 → 面板換成那條、標題跟著換；分支生成中切到別條再切回 → 接續顯示；點分支面板左上角圖示 → 清單蓋滿面板、左上角有 X；順序 = 依回覆先後、同一則內 inline 依位置、底部入口在該則 inline 之後；點一項 → 清單關閉、開成 tab、主對話捲到該高亮／入口並置中；X 關閉回到原面板；拖寬分支面板後清單仍滿版；面板寬度、拖曳把手位置不變
5. 瀏覽器（手機 < 768）：分支 drawer 沒有 tab 列、header 顯示分支標題；點圖示 → 清單滿版、X 可關、點一項換成該分支

**E5 前端：連結幽靈分支（`MessageList.jsx`、`BranchListOverlay.jsx`、`App.jsx`）**
- App：`ghostList` state，`loadGhostList()` 打 `GET /branches/orphaned?session_id=`；在載入對話、regenerate 回傳幽靈 id、relink 成功後刷新。
- `MessageList`（`variant === 'main'`）：選字浮動按鈕區，`ghostList.length > 0` 時「建立分支」旁多一顆「連結幽靈分支」；點了在按鈕下方展開選單（每項：標題＋`anchor_text` 前 40 字），點一項 → `onRelinkGhost(ghostId, messageId, text, start, end)`；點選單外關閉。手機放在建立分支按鈕旁（同 G5-B3 位置規則）。
- App `handleRelinkGhost`：`POST /branches/{id}/relink`（body 見 E2）→ 成功 → `loadBranchList`、`loadGhostList`，清除選取；**不**自動開右欄（之後點高亮開啟時，輸入框預填規則同既有：沒訊息才預填新的 anchor_text）；409 → `alert("這段文字已經有同範圍的分支")`；其他錯誤 → `alert("連結幽靈分支失敗")`。
- `BranchListOverlay`：最下面「幽靈分支」區（有幽靈才顯示），依 `created_at` 新到舊；點一項 → 關閉清單、開成 tab，不捲動、無重連按鈕。
- 視覺變更：先不 commit。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -c "relink" frontend/src/App.jsx` → ≥ 1；`grep -c "orphaned" frontend/src/App.jsx` → ≥ 1
3. `git show --stat HEAD` → 只有上列 3 個檔案
4. 瀏覽器（桌面 ≥ 768）：先對有分支的回覆按重傳造出幽靈；選主對話 AI 文字 → 出現「建立分支」與「連結幽靈分支」；點後者 → 選單列出幽靈；點一項 → 該段變高亮、右欄沒有自動開啟；點高亮 → 右欄開該分支、內容是原本的訊息；分支列表幽靈區不再有它；再按一次選字 → 若已無幽靈只剩「建立分支」；連結時範圍與既有高亮重疊 → 舊的降到底部；分支列表最下面有幽靈區，點了開 tab 不捲動；重新整理後一致
5. 瀏覽器（手機 < 768）：長按選字 → 兩顆按鈕都在選取下方、不被控制棒擋住；選單可點；其餘同桌面

### F9 規格與驗收：編輯最後一則 user 訊息（2026-11-03 定稿）

決策見 `docs/20261103_(F9)edit-last-message-guide.html` 決策表。取代 DESIGN_P3 主題 3（不刪訊息，原地更新）。在 branch `feat/f9-edit-last-message` 開發，F9-1、F9-2 都驗收後 merge 回 main。

**F9-1 後端（`backend/models.py`、`backend/main.py`、`backend/dev/regenerate_harness.py`）**
- `RegenerateRequest` 加 `content: Optional[str] = None`。
- `POST /messages/{ai_id}/regenerate`：有帶 `content` 時，`content.strip()` 為空 → 422（在任何寫入之前，排在 404 之後）；通過所有檢查後，`user_msg.content = content` 與幽靈化、清空 AI、換模型**同一個 commit**；生成用的 user 文字改用新內容。沒帶 `content` 時行為與 G6 完全相同。
- 不記編輯歷史、不加 `edited_at`；user 的 `created_at` 不變。
- harness 新增測試（同樣在真的 uvicorn＋假 LLM 上跑，不呼叫真模型）。

驗收：
1. `docker compose ps` → chat_db 為 running（不是就停下回報）
2. `cd backend && uv run python dev/regenerate_harness.py 2>&1 | grep -v "sqlalchemy" | tail -30` → 每項 PASS，最後一行 `ALL PASS`。新增涵蓋：帶 content → user 內容已更新、AI 內容＝假串流文字、model_used 已更新；送進假 LLM 的 user 文字是新內容；帶 content 且有錨定分支 → 幽靈化同 G6；content 為 `"   "` → 422 且 user／AI 內容都沒變；帶 content 但非最後一則（409）→ user 內容沒變（證明檢查在寫入之前）；不帶 content → 原 G6 測試全部仍 PASS
3. `git show --stat HEAD` → 只有 `models.py`、`main.py`、`regenerate_harness.py`

**F9-2 前端（`MessageActions.jsx`、`MessageList.jsx`、新檔 `UserMessageEditor.jsx`、`BranchPanel.jsx`、`App.jsx`）**
- `buildMessageActions(msg, { onRetry, onEdit })`：有 `onEdit` 時在複製右邊加 lucide `Pencil`「編輯」（run 回傳 false）。`MessageActionMenu` 也接 `onEdit`，手機長按選單出現「編輯」，點了關閉選單並開啟編輯。
- `MessageList` 新增 `onEdit(userMsg, aiMsg, newContent)` prop 與內部 `editingId` state。鉛筆／選單「編輯」只在：有傳 `onEdit`、該則是 user 且 `index === messages.length - 2`、下一則是 assistant、兩則都有 id、非 `isLoading`。
- 編輯中：user 氣泡原地換成 `UserMessageEditor`；該則欄寬撐到 user 欄最大寬（`w-full`，上限沿用 `max-w-[85%] md:max-w-[75%]`）；隱藏時間＋功能列；不掛長按事件。
- `UserMessageEditor`：textarea 預填原文、自動聚焦游標在結尾、自動長高上限 10 行後框內捲動；鍵盤同 ChatInput（`window.innerWidth >= 768`：Enter 送出、Shift+Enter 換行；手機 Enter 換行）＋ Esc 取消；內容 trim 後為空或與原文相同 → 送出停用；下方先一行警語（只在 N > 0：紅色小字「此回覆上有 N 個分支，重新生成後會變成幽靈分支」，N＝`branchList` 中 `anchor_message_id === aiMsg.id` 的數量，含空分支），再一列右對齊「取消」「送出」。
- 關閉編輯：取消、送出、`isLoading` 變 true（例如從主輸入框送出新訊息）、或該則不再是可編輯狀態。
- App：主對話 `handleRetry(aiMsg, { content })`、分支 `retryBranchMessage(branchId, aiMsg, { content })` 擴充既有函式（不另寫一套串流）：有 content 時先把 user 那則改成新內容、body 帶 `content`；`!response.ok` 或請求未發出就失敗 → user 那則還原成舊內容，AI 那則顯示「⚠️ 連線錯誤…」（同 G6-2）；其餘（幽靈分支 tab 關閉、`loadBranchList`、切走切回）沿用 G6-2。`BranchPanel` 把 `onEdit` 傳進 `MessageList`。
- 視覺變更：build 後先不 commit，給使用者調整參數，確認後才 commit。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -c "Pencil" frontend/src/components/MessageActions.jsx` → ≥ 1；`grep -c "onEdit" frontend/src/components/BranchPanel.jsx` → ≥ 1；`grep -A6 "/regenerate" frontend/src/App.jsx | grep -c "content"` → ≥ 2（主對話＋分支的 body 都帶 content）
3. `git show --stat HEAD` → 只有上列 5 個檔案
4. 瀏覽器（桌面 ≥ 768）：只有最後一則 user 訊息的時間右邊有鉛筆（複製右邊）；生成中不顯示；點鉛筆 → 泡泡原地變編輯框、撐到最大寬、游標在結尾；未改或清空時送出停用；Enter 送出、Shift+Enter 換行、Esc 取消；送出 → 泡泡顯示新內容、AI 那則 Thinking... → 新回覆，模型標籤為選單模型；重新整理後 user 與 AI 都是新內容；有分支的回覆 → 編輯框下有紅色警語且 N 正確，送出後高亮消失、分支 tab 關閉；沒分支的回覆無警語；編輯中從主輸入框送出 → 編輯框關閉；分支面板最後一則 user 同樣可編輯
5. 瀏覽器（手機 < 768）：user 氣泡無鉛筆；長按最後一則 user → 選單有「複製」「編輯」，其他 user 訊息只有「複製」；點「編輯」→ 編輯框；Enter 換行、只能點送出；送出流程同桌面；分支面板同樣可用
6. 生成中切走再切回 → 接續顯示（沿用 resume）

### G6 規格與驗收（2026-11-03 定稿）

決策見 `docs/20261103_(G6)regenerate-guide.html` 第 8 節。

**G6-1 後端（`backend/models.py`、`backend/main.py`、新 migration、新 `backend/dev/regenerate_harness.py`）**
- migration：`branch.anchor_message_id` 改 nullable；新增 `branch.is_orphaned boolean not null default false`、`branch.attach_root_id uuid null`（FK message.id）。
- `run_generation`：保留時間改為模組常數 `BUFFER_RETENTION_SECONDS = 60`；清除時 `if GENERATIONS.get(id) is buf` 才 pop。
- `/chats/roots` 兩種排序的根都加 `branch_id IS NULL`。
- `POST /messages/{message_id}/regenerate`，body `{ model }`，`@limiter.limit("10/minute")`：404（非 AI）→ 403（白名單）→ 409（生成中）→ 409（同 `branch_id` 線上還有子訊息）→ 幽靈化錨在此則的分支（anchor_message_id／anchor_start／anchor_end 設 NULL、is_orphaned=true；其 root 訊息 parent_id、anchor_message_id 設 NULL）＋ 內容清空、model_used 改為新模型，一次 commit → 背景 `run_generation` → 串流，headers 含 `X-Message-Id`、`X-Orphaned-Branch-Ids`（逗號分隔，可為空）。
- 測試腳本：連 docker chat_db、建測試資料、把 LLM 換成假串流、在真的 uvicorn（埠 8765）上打 API、最後清掉測試資料；不呼叫真模型。

驗收：
1. `docker compose ps` → chat_db 為 running（不是就停下回報）
2. `cd backend && uv run alembic upgrade head` → 成功；`uv run alembic current` → 新 revision 為 head
3. `cd backend && uv run python dev/regenerate_harness.py 2>&1 | grep -v "sqlalchemy" | tail -20` → 每項 PASS，最後一行 `ALL PASS`。涵蓋：重傳後內容＝假串流文字且 model_used 已更新；錨定分支 is_orphaned=true、anchor 為 NULL、其 root 訊息 parent_id 為 NULL；`X-Orphaned-Branch-Ids` 含該分支；`/chats/roots` 不含幽靈分支 root；非最後一則 → 409；生成中再按 → 409；非 AI → 404；不在白名單 → 403；`BUFFER_RETENTION_SECONDS` 調短後連續重傳兩次，第二次的緩衝不會被第一次的清除動作清掉
4. `git show --stat HEAD` → 只有 models.py、main.py、新 migration、harness

**G6-2 前端（`MessageActions.jsx`、`MessageList.jsx`、`BranchPanel.jsx`、`App.jsx`）**
- `buildMessageActions(msg, { onRetry })`：有 onRetry 時在複製右邊加 `RefreshCw`「重新生成」。
- `MessageList` 新增 `onRetry` prop；只在最後一則、AI、有 id、非 loading 時傳給該則的 `MessageActions`。
- App：主對話 `handleRetry(msg)`、分支 `retryBranchMessage(branchId, msg)`：清空該則內容、model_used 換成選單模型、loading、POST regenerate、串流寫回同 id；主對話完成後 `loadBranchList`；依 `X-Orphaned-Branch-Ids` 關閉對應分支 tab；失敗時顯示「⚠️ 連線錯誤」於該則。切走再切回沿用 `resumeGeneration`。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -c "RefreshCw" frontend/src/components/MessageActions.jsx` → ≥ 1；`grep -c "/regenerate" frontend/src/App.jsx` → ≥ 2（主對話＋分支）
3. 瀏覽器（桌面＋手機）：只有最後一則 AI 回覆有重傳鈕、在複製右邊；生成中不顯示；按下 → Thinking... → 新內容取代，模型標籤為選單模型；重新整理後內容是新的；分支面板同樣可重傳；有分支高亮的回覆重傳後高亮消失、該分支 tab 關閉、側邊欄沒有多出對話；重傳中切走再切回能接續顯示；「⚠️ 連線錯誤」那則沒有重傳鈕

### G9 規格與驗收（2026-11-03 定稿）

決策見 `docs/20261103_(G9)user-message-collapse-guide.html` 第 7 節。

- 新檔 `frontend/src/userContent.js`：`parseUserContent(text)` → `[{type:'text'|'fence'|'code', ...}]`（先切 ```` ``` ```` 區塊再切行內）。
- 新檔 `frontend/src/components/UserMessageContent.jsx`：渲染片段（text 用 `whitespace-pre-wrap break-words`；fence 用 `SyntaxHighlighter` vscDarkPlus，樣式同 AI；code 用 user 行內樣式）；量測 `scrollHeight` 與 10 × lineHeight，`ResizeObserver` 重量；摺疊時 maxHeight＋overflow hidden＋mask-image 漸層；超過時下方置中 `ChevronDown`／`ChevronUp` 白色小按鈕。
- `MessageList.jsx`：user 訊息改用 `<UserMessageContent key={msg.id ?? 'tmp-' + index} content={msg.content} />`；AI 訊息不變。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `node -e "import('./frontend/src/userContent.js').then(m=>console.log(JSON.stringify(m.parseUserContent('a **b**\n```js\nx\n```\nc `d`'))))"` → 依序為 text「a **b**\n」、fence(lang js, code「x\n」)、text「\nc 」、code「d」
3. `git show --stat HEAD` → 只有兩個新檔＋`MessageList.jsx`
4. 瀏覽器（桌面＋手機）：user 訊息多行換行保留、`**粗體**` 原樣顯示；```` ``` ```` 區塊深色高亮、`` `code` `` 行內樣式；超過 10 行摺疊、底部淡出、V 展開／倒 V 收起；≤ 10 行無按鈕；拖分支面板寬度後摺疊判斷會更新；切換對話後恢復摺疊；G8 長按選單、桌面時間旁複製仍正常；AI 訊息不受影響

### G5-B3 規格與驗收（2026-11-02 定稿）

決策見 `docs/20261102_(G5-B3)selection-change-guide.html` 第 6 節。只動 `frontend/src/components/MessageList.jsx`。

- Markdown `components` 只建立一次：依 role 用 `useMemo` 各建一份；`mark` 需要的 `branchById`、`onOpenBranch` 改由 ref 讀最新值。`renderMarkdown` 與 `renderContent` 都改用這兩份固定物件。
- 移除 AI 泡泡的 `onMouseUp`；改在 `document` 監聽 `selectionchange`，防抖 300ms 後執行原本的判斷（選取完全在同一則有 id 的 AI 泡泡內 → `selectionOffsets` → `branchSel`），否則（選取收合／不在 AI 泡泡）隱藏按鈕。
- 按鈕位置：視窗寬 ≥ 768 維持選取上方；< 768 放選取下方（`rect.bottom + MOBILE_BUTTON_OFFSET`，預設 28px）。
- 按鈕加 `onMouseDown` preventDefault（只擋按鈕本身）；移除「點外面就收起」的 mousedown 監聽（改由 selectionchange 處理），保留捲動／縮放收起。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `grep -c "selectionchange" frontend/src/components/MessageList.jsx` → ≥ 2（add＋remove）
3. `grep -n "onMouseUp" frontend/src/components/MessageList.jsx` → 無輸出
4. `grep -n "components={buildMarkdownComponents" frontend/src/components/MessageList.jsx` → 無輸出（不再於 JSX 內每次建立）
5. `git show --stat HEAD` → 只有 `MessageList.jsx`
6. 瀏覽器（桌面）：選取 AI 文字放開滑鼠 → 反白保留、上方出現「建立分支」；shift+方向鍵調整 → 反白跟著變、停手後按鈕移到新位置；按下 → 分支的選取文字是調整後的範圍；高亮點擊仍可開分支；串流中顯示正常；Ctrl+C／右鍵複製選取文字正常
7. 瀏覽器（手機）：長按 AI 文字 → 停手後選取「下方」出現「建立分支」，不被原生工具列擋住；拖控制棒調整 → 按鈕跟著移動；點按鈕 → 開啟分支且文字正確；點空白處取消選取 → 按鈕消失；user 訊息長按仍是 G8 選單

### G8 規格與驗收（2026-11-02 定稿）

決策見 `docs/20261102_(G8)message-actions-guide.html` 第 7 節。

- 新檔 `frontend/src/clipboard.js`：`copyText(text)`，安全環境用 `navigator.clipboard.writeText`，否則或失敗時退回隱藏 textarea＋`execCommand('copy')`；回傳 boolean。
- 新檔 `frontend/src/components/MessageActions.jsx`：`buildMessageActions(msg)`（目前只有 copy，複製 `msg.content`）、`MessageActions`（一排小圖示，複製後圖示變 ✓ 約 2 秒）、`MessageActionMenu`（fixed 浮動選單，點外面／捲動／縮放關閉；複製後該項變「✓ 已複製」約 1 秒後關閉）。
- `MessageList.jsx`：AI 訊息在模型標籤下方放 `MessageActions`（常態）；user 訊息把送出時間那列改成 flex，時間右邊放 `MessageActions`，僅 `md` 以上顯示；手機 user 氣泡長按（`pointerType === 'touch'`，500ms，移動 > 10px 取消）開 `MessageActionMenu`，並加 `max-md:select-none max-md:[-webkit-touch-callout:none]`、`onContextMenu` preventDefault。內容為空時不顯示功能列、不觸發長按。

驗收：
1. `cd frontend && npm run build` → `✓ built`
2. `ls frontend/src/clipboard.js frontend/src/components/MessageActions.jsx` → 兩個檔案都存在
3. `grep -c "execCommand('copy')" frontend/src/clipboard.js` → `1`；`grep -c "isSecureContext" frontend/src/clipboard.js` → ≥ 1
4. `git show --stat HEAD` → 只有上述兩個新檔＋`MessageList.jsx`
5. 瀏覽器（桌面）：AI 訊息模型名稱下方有複製圖示，user 訊息時間右邊有複製圖示；點擊 → 圖示變 ✓ 約 2 秒，貼上得到原始 markdown；分支面板同樣有；Thinking... 中不顯示；桌面 user 訊息仍可滑鼠選字
6. 瀏覽器（手機，`http://區網IP:5173`）：AI 訊息模型名稱下方有複製圖示且可複製（驗證 http 備援）；user 訊息沒有圖示，長按 → 氣泡上方出現選單，點「複製」→ 顯示已複製後關閉，貼上正確；點選單外面會關閉；在 user 氣泡上滑動捲動不會誤開選單；長按 AI 文字仍是選字＋「建立分支」

> BACKLOG 前三項（編輯按鈕手機版、手機收起側邊欄擠壓、分支情境重設計）已討論並轉為上表編號，不另列。第四項 Voyager 式時間軸見上表 T1。

### 互動/UI 規格（定稿）

### 捲動與閱讀位置
- 點選左側對話：**無捲動動畫**，直接定位。
- 閱讀位置：僅「頁面載入期內」記憶（React state，per 對話 id），切換對話可還原；**重新整理後清空**。
- 重新整理後預設：畫面頂部對齊「最後一則 user 訊息」。
- 自動捲底：**僅當用戶仍在底部附近**（未手動捲走）時，新串流才自動捲到底；用戶在別處不干涉。

### 編輯最後一則（重新生成）
- inline 原地編輯，**不回輸入框**。
- 送出 → **原地更新**舊 user 內容並重新生成舊 AI（2026-11-03 改，取代「刪除舊的那輪」），主對話**保持線性**（不長分支）。詳見上方 F9 規格。
- 警語只在該回覆底下有分支時顯示（編輯框下方紅色小字）。
- 串流中編輯**停用**（已確認：等回完才能改）；不做「中斷生成」（模型已算就無意義）。

### 幽靈分支
- 刪除舊一輪時，錨定其上的分支 → **幽靈分支**（不自動刪，標記 orphan）。
- 用戶可決定**重連到哪一則對話**；連上後在該對話底部加「該分支標題」入口。

### 選取與高亮
- 改存 **anchor_start / anchor_end（字元 offset）**；高亮與 md 匯出皆用 offset 對原始 source 做單次替換，**廢除子字串 split**（根因：split 命中所有相同文字＋切碎 markdown）。
- 選取保持**原生反黑** + 浮動按鈕（按鈕 `pointerdown` preventDefault，但不擋 Ctrl+C／右鍵複製）。
- 手機：**長按選取 → 上方浮現按鈕**，參考 Claude 手機網頁版。

### 側邊欄／面板
- 左側：拖寬 **12–30%（百分比）**；標題 `nowrap + overflow hidden`（超出**直接裁切**、不省略）。
- 右側：寬度**改百分比**（20–50%）。
- 拖寬結果**持久化**（localStorage）。

### 手機版
- 左側：**滿版 drawer**，左上 X 關閉。
- 右側：**滿版**，右上 X 關閉；開啟入口＝右上角開關 **或** 對話中高亮處。
- 樹狀圖手機版**暫不改**。

### 模型選單／右上角
- 模型選單移到**輸入框下方**。
- 右上角改成**右側邊欄開關**。

### 上下文開關（互動已定；後端後做）
- 主對話：每條分支一個開關（**預設關**），可對話級「全選／清空」。
- 分支：預設只含**當前分支**；可加開「主對話」或其他分支。
- token 上限警示（UI 先留位置）。

---

## L1 規格與驗收：首頁互動展示（2026-11-13 確認，分支 `feat/landing-guest`）

分兩段：第一段 L1（本節，純前端，使用者驗收後才做第二段）；第二段 S-U3 訪客模式＋BYOK／OpenRouter 授權連線（細節另行確認）。
教學與決策表：`docs/20261113_(L1)landing-demo-guide.html`。使用者讀完說「開始」才動工。

**已確認的決定**
- 未登入的人先看到首頁；已登入直接進聊天（不變）。
- 標語「追問細節，不打斷主線」；副標「選取 AI 回答裡的任何一段，開一條分支繼續問。」
- 「開始使用」第一段先導向現有登入頁；第二段改成進訪客模式。
- 五篇範例文章（使用者提供），每次打開隨機一篇，另有「換一篇」按鈕。
- 展示用真的 `MessageList`／`BranchPanel` 吃假資料，不呼叫任何 API、不呼叫模型；有自動播放，使用者一動手就停。

**行為規格**
- `AuthGate`：`user === null` 時依 `view` 顯示 `LandingPage` 或 `LoginPage`；網址帶 `auth_error` 時直接顯示登入頁；登入頁加「回首頁」連結。
- 首頁版面（整頁高度，不捲動整頁）：頂列（logo、FluentBranch、右側「登入」）之下，桌面是三欄：左側白底標語欄（標語、副標、「開始使用」，視窗寬 34%，上限 600px）／主對話／分支面板（預設視窗寬 28%，首頁不讀寫 localStorage 的面板寬度）；手機的標語區在上方、疊在格線背景上（L1-5、L1-6，2026-11-14 改）。展示區與正式介面用相同的元件與樣式。主對話下方原本輸入框的位置改放說明列：「這是示範。按『開始使用』就能輸入自己的問題。」分支面板底部同理。
- 文章中三個片語先以「虛線底線」提示（還不是分支）。點片語＝程式幫忙選取該片語 → 出現真的「建立分支」按鈕 → 按下後片語變成正式高亮、開啟分支面板、顯示預寫的問題、回答以模擬串流逐字出現。已開過的片語再點＝開啟該分支。
- 自己拖曳選取：選取範圍與某片語重疊 → 視同該片語；不重疊 → 建立一條示範分支，回答固定為「這是示範，回答是預先寫好的。按『開始使用』就能針對任何段落真的追問。」
- 自動播放：載入 1.2 秒後開始，假游標移到第一個片語 → 選取 → 移到「建立分支」→ 按下 → 分支播放；播完停 1.5 秒再點下一個，直到三個片語都點完（L1-7）。手機（< 768）只做到「選取並顯示按鈕」，不自動開滿版分支面板。使用者有任何 pointerdown／keydown／wheel／touchstart 就停止這一輪，按「換一篇」會從頭再播；`prefers-reduced-motion` 時不播放。
- 「換一篇」：換到下一篇，清掉示範分支、關面板、停止所有計時器，並重新開始自動播放（L1-7）。
- 分支面板開啟時由右往左滑入（0.28 秒，`index.css` 的 `animate-panel-slide-in`）；加在共用的 `BranchPanel` 上，正式介面也套用（L1-8）。
- 安全：首頁除了既有的 `GET /auth/me` 不發任何請求；不讀寫使用者資料；不新增外部來源（CSP 不變）。

**任務**（同一個 implementer 依序做，各自 commit；全部留在分支上不 push，使用者驗收後才合併）

| 任務 | 內容 | 檔案 | 驗收 |
|---|---|---|---|
| L1-1 | 範例文章資料與解析（去掉片語標記、算出 offset） | `frontend/src/demo/demoArticles.js` | `cd frontend && node --input-type=module -e "import('./src/demo/demoArticles.js').then(m=>{let n=0;for(const a of m.DEMO_ARTICLES)for(const p of a.phrases){if(a.answer.slice(p.start,p.end)!==p.text)throw new Error(p.text);n++}console.log('articles='+m.DEMO_ARTICLES.length+' phrases='+n+' ok')})"` → `articles=5 phrases=15 ok` |
| L1-2 | 共用元件的可選擴充：`MessageList` 加 `anchorHints`／`onHintClick`（虛線提示）；`BranchPanel` 加 `footer`（取代輸入框）；未傳時行為完全不變 | `frontend/src/components/MessageList.jsx`、`BranchPanel.jsx` | `npm run build` 與 `npm run lint` 通過；`git diff` 確認新 props 皆有預設值、既有呼叫端（`App.jsx`）未改 |
| L1-3 | 首頁、展示狀態、模擬串流、換一篇、`AuthGate` 切換、登入頁「回首頁」 | `frontend/src/components/LandingPage.jsx`、`AuthGate.jsx` | build／lint 通過；`grep -n "apiFetch\|fetch(" frontend/src/components/LandingPage.jsx frontend/src/demo/*` 無輸出；瀏覽器清單 |
| L1-4 | 自動播放（假游標）與停止條件 | `frontend/src/components/LandingPage.jsx`（或 `frontend/src/demo/`） | build／lint 通過；瀏覽器清單 |
| L1-5 | 標語區融進格線背景（使用者回饋：白色橫條像被切一塊） | `LandingPage.jsx` | build 通過；瀏覽器清單 |
| L1-6 | 桌面改三欄：左側白底標語欄 34%、分支面板 28%；`BranchPanel` 加 `defaultWidthPercent`／`persistWidth`（未傳時行為不變） | `LandingPage.jsx`、`BranchPanel.jsx` | build／eslint 通過；`grep -n "DEFAULT_PANEL_PERCENT" frontend/src/components/BranchPanel.jsx` 無輸出；瀏覽器清單 |
| L1-7 | 自動播放點完三個片語；「換一篇」重新播放 | `frontend/src/demo/useDemoAutoplay.js`、`LandingPage.jsx` | build／eslint 通過；瀏覽器清單 |
| L1-8 | 分支面板開啟時由右往左滑入 | `frontend/src/index.css`、`BranchPanel.jsx` | build／eslint 通過；`grep -l "panel-slide-in" frontend/dist/assets/*.css` 有一個檔案；瀏覽器清單 |

**狀態（2026-11-14）**：L1-1 `5cd50e9`、L1-2 `f1bab28`、L1-3 `c41ca25`、L1-4 `5fa71f6`、L1-5 `6e66bd4`、L1-6 `4ccd82f`、L1-7 `23dbe12`、L1-8 `d19604b`，都在 `feat/landing-guest`，未 push、未合併。指令類驗收（build、eslint、grep）已通過；L1-5 到 L1-8 由使用者在瀏覽器看過後同意 commit。下方瀏覽器清單尚未逐項跑完（Claude 沒有做瀏覽器驗證；第 9 項正式介面回歸與手機版待確認）。第二段（S-U3 訪客模式＋BYOK）已確認的決定見文末「G2」一節。

**瀏覽器驗收清單**（桌面 ≥ 768 與手機 < 768 各做一次）
1. 未登入打開網站 → 看到首頁（標語、開始使用、一篇範例），不是登入頁。
2. 不動滑鼠等約 1 秒 → 自動播放：桌面會依序開出三條分支並逐字出現回答（第一條開啟時面板由右滑入）；手機停在「建立分支」按鈕出現。
3. 播放途中點一下畫面 → 假游標消失，不再自動操作。
4. 點另一個虛線片語 → 出現「建立分支」→ 按下 → 片語變高亮、分支面板顯示預寫問答。
5. 再點已高亮的片語 → 開啟同一條分支，不重複建立。
6. 拖曳選取片語以外的文字 → 建立分支 → 看到固定說明文字。
7. 「換一篇」→ 文章更換、分支清空、面板關閉，自動播放從頭再播。
8. 「開始使用」與頂列「登入」→ 登入頁；「回首頁」→ 回到首頁。
9. 登入後 → 直接進聊天；正式介面回歸：點高亮開分支、選取文字建立分支、分支面板輸入框與模型選單、桌面拖曳面板寬度（預設 25%、拖過的寬度有記住），都與之前相同；面板開啟時多了由右滑入。
10. 手機：分支面板滿版、右上 X 可關閉，關閉後回到首頁展示。

---

## G2 第二段：訪客模式（S-U3）＋ OpenRouter 授權連線（BYOK）— 決定紀錄

狀態：規格與教學文件已寫（2026-11-14），**等使用者讀完教學說「開始」才動工**。下表「已確認」的項目是使用者 2026-11-14 逐項回答的；「提案」的項目使用者回覆「ok 請繼續」、未提出修改。分支 `feat/landing-guest`。

**現況事實（使用者 2026-11-14 說明）**：正式站 VM 的環境變數設定為 OpenRouter 免費模型，VM 上已經沒有 Google 金鑰；本機的 Google 金鑰只用來測試串流。設計額度與模型清單時，正式站視為只有 OpenRouter。

| # | 項目 | 決定 | 狀態 |
|---|---|---|---|
| 1 | 入口 | 首頁「開始使用」直接進訪客模式；登入按鈕在側欄左下（類似 ChatGPT） | 已確認（2026-11-13） |
| 2 | 訪客額度 | 每個訪客每天 10 則 | 已確認 |
| 3 | 訪客可用模型 | 所有免費模型（可從免費清單選，不能輸入自訂模型 ID） | 已確認 |
| 4 | IP 上限 | 同一 IP 每天最多 10 個訪客身分、合計 100 則 | 已確認 |
| 5 | 登入後的訪客對話 | 登入時詢問一次是否搬進帳號，選否就刪除 | 已確認 |
| 6 | 訪客資料保留 | 7 天後自動刪除 | 已確認 |
| 7 | 登入用戶的模型來源 | 登入用戶使用自己的 OpenRouter（OAuth 授權連線） | 已確認 |
| 8 | 登入但尚未連結 | 與訪客相同：每天 10 則、只能用免費模型；差別是對話長期保存。用完提示連結 OpenRouter。（取代原本登入用戶每天 20 則） | 已確認 |
| 9 | 連線方式 | 只做 OpenRouter 授權（OAuth PKCE），不做手動貼金鑰 | 已確認 |
| 10 | 已連結者的限制 | 不限則數、可用任何模型 ID；仍保留每分鐘速率限制 | 已確認 |
| 11 | 全站每日上限 | 平台金鑰只服務訪客與未連結者，兩者共用全站上限（現為 900），不另外切一塊給訪客 | 提案（由 #7、#8 推得） |
| 12 | 訪客身分 | 伺服器建立訪客使用者＋httpOnly cookie，沿用 `user_id` 擁有者檢查；IP 只用於限流，以雜湊保存 | 提案（BACKLOG S-U3 的方向） |
| 13 | 使用者金鑰保存 | OAuth 換到的金鑰用 Fernet 加密存資料庫，加密金鑰放 VM `.env`；不回傳前端、不寫 log | 已確認（2026-11-14 討論安全性後） |
| 14 | 使用者金鑰失效 | 顯示錯誤並請使用者重新連結；不悄悄改用平台金鑰 | 提案 |
| 15 | 機器人驗證 | 初版不做（靠額度與 IP 上限），之後視濫用情況再加 | 提案 |
| 16 | 隱私權說明 | 補上訪客資料保留 7 天、IP 雜湊用途、OpenRouter 連線時金鑰的保存方式 | 提案 |
| 17 | 直連 Gemini | 正式站不提供；程式中的直連路徑只留給本機測試 | 提案（依上面的現況事實） |
| 18 | 保留期限從何時算 | 從最後一次送訊息算 7 天（`user.last_active_at`），不是從建立算 | Claude 提案，待使用者看過教學 |
| 19 | 洗額度 | 登入時把訪客當天已用次數併入登入帳號 | Claude 提案，待使用者看過教學 |
| 20 | IP 計數保留 | 雜湊值保留 2 天後刪除 | Claude 提案，待使用者看過教學 |
| 21 | 訪客沒有登出按鈕 | 側欄只有「登入」 | Claude 提案，待使用者看過教學 |
| 22 | 已連結者的模型選單 | 免費清單＋自訂模型 ID 輸入；不做付費模型瀏覽清單 | Claude 提案，待使用者看過教學 |

注意：正式站在 V1-6 之前仍在 Cloudflare Access 後面，訪客模式要等拿掉它才對外有效。

### G2 規格與驗收（2026-11-14 擬定，等使用者讀完教學說「開始」才動工）

教學與決策表：`docs/20261114_(G2)guest-mode-openrouter-connect-guide.html`。提案項目（#11、#12、#14–#17）使用者 2026-11-14 回覆「ok 請繼續」，未提出修改；#13 經討論後確認（加密存資料庫、加密金鑰放 `.env`）。

OpenRouter 授權流程已對照官方文件 `https://openrouter.ai/docs/use-cases/oauth-pkce`（2026-11-14 讀取）：授權頁 `https://openrouter.ai/auth`，參數 `callback_url`、`code_challenge`、`code_challenge_method=S256`、`state`（原樣帶回）、`key_label`；換金鑰 `POST https://openrouter.ai/api/v1/auth/keys`，body `code`、`code_verifier`、`code_challenge_method`，回應 `key`；授權碼 10 分鐘內有效、只能用一次；不需要 client id／secret；`callback_url` 可用任何 port 的 localhost。文件沒有說金鑰是否過期、有沒有 refresh token。

**名詞**
- 訪客：`user.oauth_provider == "guest"` 的使用者列（`oauth_sub` 為隨機值、`email` 為空）。沿用現有 `User`、`AuthSession`、`session` cookie 與 `get_current_user`，所有擁有者檢查不用改。
- 試用者：訪客，或已登入但沒有 `openrouter_credential` 列的使用者。用平台金鑰、受每日額度與全站上限限制、只能用白名單與免費模型。
- 已連結者：已登入且有 `openrouter_credential` 列。用自己的金鑰、不扣每日額度、不計入全站上限、可用任何模型 ID、一律走 OpenRouter（不走直連 Gemini）。

**資料表（Alembic，一支 migration）**
- `user.last_active_at`（timestamp，nullable）：每次成功扣額度或已連結者送出訊息時更新。
- `guest_ip_usage`：主鍵 `(ip_hash, day)`；`guests_created int default 0`、`messages int default 0`。`ip_hash = HMAC-SHA256(key=IP_HASH_SECRET, msg=IP)` 的 hex；不存原始 IP。
- `openrouter_credential`：`user_id` 主鍵＋外鍵 `ON DELETE CASCADE`；`key_encrypted text`；`created_at`。

**環境變數**（`docker-compose.prod.yml` 與 `.env` 範例同步）
- `DAILY_MESSAGE_LIMIT`：預設由 20 改為 10（試用者每日則數）。
- `GUEST_IP_DAILY_GUESTS`（預設 10）、`GUEST_IP_DAILY_MESSAGES`（預設 100）、`GUEST_RETENTION_DAYS`（預設 7）。
- `IP_HASH_SECRET`：未設定時退回 `SESSION_SECRET_KEY`。
- `CREDENTIAL_ENCRYPTION_KEY`：Fernet 金鑰。未設定時 `/auth/openrouter/connect` 回 `openrouter_error=unavailable`，不得用預設值或明碼儲存。
- `SITE_DAILY_MESSAGE_LIMIT` 不變（900），試用者共用。

**後端行為**
1. `POST /auth/guest`（限流：每 IP 每分鐘 5 次）
   - 已帶有效 `session` cookie → 200，不建立新身分。
   - `Origin` 標頭存在且不在 `CORS_ORIGINS` → 403。
   - 該 IP 今日 `guests_created >= GUEST_IP_DAILY_GUESTS` → 429 `{"code":"guest_ip_limit"}`，不建立任何列。計數用單一 `INSERT ... ON CONFLICT DO UPDATE ... WHERE guests_created < :limit RETURNING`（同 `charge_daily_quota` 的寫法，避免併發超發）。
   - 否則建立訪客 `User`＋`AuthSession`，設定 `session` cookie（同現有屬性），回 200。
2. `GET /auth/me` 回 `{email, provider, is_guest, openrouter_connected, guest_claim}`；`guest_claim` 為 `null` 或 `{"chat_count": n}`（見第 5 點）。不回 id、不回金鑰任何片段。
3. 額度（`charge_daily_quota` 擴充，`/chat` 與 `regenerate` 共用）
   - 已連結者：不檢查全站上限、不寫 `daily_usage`，只更新 `last_active_at`。
   - 試用者：先全站上限（不變）→ 訪客另外扣 `guest_ip_usage.messages`（超過 `GUEST_IP_DAILY_MESSAGES` → 429 `guest_ip_limit`）→ 個人每日額度（不變）。任何一步失敗都不留下前面步驟的扣款（同一交易，失敗時 rollback）。
   - 生成一個字都沒產出就失敗時，退個人額度也要退 IP 計數。
4. 模型：試用者維持 `is_model_allowed`（白名單＋免費清單）。已連結者跳過白名單，只檢查長度（現有 `max_length=200`）；`run_generation` 對已連結者一律呼叫 OpenRouter，並帶入該使用者的金鑰。`GET /api/model-options` 多回 `allow_custom: bool`（已連結者為 true）。
5. 登入時的訪客處理（`/auth/{provider}/callback`）
   - 請求帶有有效的訪客 `session` cookie 時：把訪客今日 `daily_usage.count` 加到登入帳號今日的列上（`LEAST(合計, DAILY_MESSAGE_LIMIT)`），避免「試用 10 則再登入又 10 則」；把訪客的原始 token 改放到 httpOnly cookie `guest_session`（`max_age` 1 天，其餘屬性同 `session`），再發登入帳號的 `session` cookie。
   - `guest_claim`：`guest_session` cookie 有效、指向訪客、目前登入者不是訪客、且該訪客至少有一個對話 root 時，`/auth/me` 回 `{"chat_count": n}`；訪客沒有對話時後端直接刪除該訪客並清掉 cookie。
   - `POST /auth/guest-claim`，body `{"action": "merge" | "discard"}`：必須同時有登入帳號的 `session` 與有效的 `guest_session`（兩個 cookie 都由伺服器查表，不接受前端傳任何使用者或對話 id）；登入者是訪客 → 403。`merge`：把訪客的 `message.user_id`、`branch.user_id` 全部改成登入帳號（單一交易）。兩種動作最後都刪除訪客的 `auth_session`、`daily_usage`、`user` 列並清掉 `guest_session` cookie。重複呼叫 → 409 `no_pending_claim`。
6. 保留期限：`lifespan` 啟動一個背景 task，每小時執行一次清理（阻塞的 DB 呼叫用 `asyncio.to_thread`）：`oauth_provider == "guest"` 且 `COALESCE(last_active_at, created_at) < now - GUEST_RETENTION_DAYS` 的訪客，連同其訊息、分支、`auth_session`、`daily_usage` 一併刪除；`guest_ip_usage` 刪除 2 天前的列。清理函式可單獨呼叫（harness 用）。
7. OpenRouter 連結（新檔 `backend/openrouter_connect.py`，router 掛在 `/auth/openrouter`）
   - `GET /auth/openrouter/connect`：訪客 → 導回 `/?openrouter_error=login_required`；未設定 `CREDENTIAL_ENCRYPTION_KEY` → `openrouter_error=unavailable`。產生 `code_verifier`（`secrets.token_urlsafe(64)`）與 `state`（`secrets.token_urlsafe(32)`），連同目前 `user.id` 存進 Starlette session（`SessionMiddleware` 已存在），303 導向 `https://openrouter.ai/auth?callback_url=<本站 callback>&code_challenge=<S256>&code_challenge_method=S256&state=<state>&key_label=FluentBranch`。
   - `GET /auth/openrouter/callback`：必須已登入且非訪客；session 中的 `state` 與查詢參數用 `hmac.compare_digest` 比對，且 session 中的 user id 等於目前登入者；不符 → `openrouter_error=state_mismatch`。session 中的 `state`／`code_verifier` 讀出後立即移除（一次性）。用 `httpx.AsyncClient(timeout=10)` 呼叫換金鑰端點；非 200 或沒有 `key` → `openrouter_error=exchange_failed`。成功 → Fernet 加密後 upsert `openrouter_credential`，303 導回 `/?openrouter=connected`。
   - `DELETE /auth/openrouter`：刪除自己的 `openrouter_credential` 列，回 200；沒有列也回 200。
   - log 規則：任何路徑都不得記錄 `code`、`code_verifier`、`state`、金鑰、OpenRouter 的回應內容；失敗只記例外型別或狀態碼。
8. 使用自己的金鑰生成：`/chat`、`regenerate` 在請求的 DB session 內解密金鑰，以參數傳給背景 task（只存在記憶體）。`openrouter_chat_stream(..., api_key=None)`：有 `api_key` 時用該金鑰建立 client，沒有時用平台 client。
   - `openai.AuthenticationError`（401）→ 刪除該使用者的 `openrouter_credential`，回覆內容為固定文字「⚠️ 你的 OpenRouter 連結已失效，請重新連結」。
   - HTTP 402 → 固定文字「⚠️ 你的 OpenRouter 帳號額度不足」，不刪除連結。
   - 其餘錯誤 → 現有的固定文字。任何情況都不得改用平台金鑰重試。
   - 解密失敗（加密金鑰被更換）→ 視同連結失效：刪除該列、回 409 `{"code":"openrouter_reconnect_required"}`，不建立訊息。

**前端行為**
1. 首頁「開始使用」（三處）→ `POST /auth/guest` → 成功後重新取得 `/auth/me` 進入聊天；429 `guest_ip_limit` → 顯示登入頁並提示「這個網路今天的試用名額已滿，請登入後使用」。首頁頂列「登入」仍進登入頁。
2. `AuthGate`：訪客在聊天中按「登入」→ 顯示登入頁（「← 返回」回到聊天）。`App` 收 `onRequestLogin`。
3. 側欄底部帳號區：訪客顯示「試用中」與「登入」按鈕（不顯示登出）；已登入顯示原本的帳號列，下方多一列 OpenRouter 狀態：未連結 →「連結 OpenRouter」（連到 `${API_URL}/auth/openrouter/connect`）與一行說明「連結後不限則數，可用任何模型，費用由你的 OpenRouter 帳號支付」；已連結 →「已連結 OpenRouter」與「中斷連結」（確認後 `DELETE /auth/openrouter`）。
4. 訪客對話搬移：`user.guest_claim` 非空時顯示一次對話框「要把試用時的 N 個對話移到這個帳號嗎？」，按鈕「移到帳號」／「刪除」（刪除需再確認一次）；完成後重新載入對話列表與 `/auth/me`。對話框不能用點背景關閉。
5. 網址參數 `openrouter=connected` 與 `openrouter_error=<code>`：顯示固定文案後從網址移除（寫法同現有 `auth_error`；不認得的代碼用通用訊息，絕不顯示原始參數）。
6. 模型選單：`allow_custom` 為 false 時不顯示自訂模型輸入。
7. 額度訊息：訪客「今日試用額度已用完。登入並連結 OpenRouter 就能繼續使用」；已登入未連結「今日試用額度已用完。連結 OpenRouter 就能不限則數」；`guest_ip_limit`「這個網路今天的試用額度已滿，請登入後使用」；`openrouter_reconnect_required`「OpenRouter 連結已失效，請重新連結」。
8. `frontend/public/privacy.html`：補上訪客（未登入）資料保留 7 天後自動刪除、IP 只以不可還原的雜湊值保存 2 天用於限制試用次數、連結 OpenRouter 時金鑰加密保存且可隨時中斷連結刪除、訪客用的 cookie；更新日期。

**安全要求（每個任務的驗收都要涵蓋對應項目）**
- 隔離：訪客 A 讀寫不到訪客 B 或任何登入帳號的對話（沿用 `get_owned_*`，harness 要有跨身分案例）。
- 搬移只能把「自己瀏覽器持有 token 的那個訪客」搬到「目前登入的帳號」；沒有 `guest_session` 或 token 不對一律不動任何資料。
- 金鑰：不出現在任何 API 回應、log、例外訊息；資料庫中只有密文（harness 直接查表比對）。金鑰只依 `get_current_user` 的 `user.id` 讀取。
- 連結流程：`state` 一次性、綁定登入者；callback 換到的金鑰只會存到發起連結的那個帳號。
- 訪客不能連結 OpenRouter、不能輸入自訂模型（後端白名單擋，不只前端隱藏）。
- 首頁除 `GET /auth/me` 外仍不發請求；`POST /auth/guest` 只在使用者按下「開始使用」時發。
- CSP 不變（OpenRouter 授權是整頁導向，不是 `connect-src`）。

**任務**（每個任務各自 commit；harness 用臨時資料庫與假 LLM、假 OpenRouter，絕不呼叫真模型或真的 OpenRouter）

| 任務 | 內容 | 檔案 | 驗收 |
|---|---|---|---|
| G2-1 | migration 與 model：`user.last_active_at`、`guest_ip_usage`、`openrouter_credential` | `backend/models.py`、`backend/alembic/versions/*` | `docker compose ps` 確認 chat_db；`cd backend && POSTGRES_DB=g2_tmp uv run alembic upgrade head` 成功；`uv run alembic downgrade -1 && uv run alembic upgrade head` 成功 |
| G2-2 | 訪客身分：`POST /auth/guest`、`/auth/me` 新欄位、IP 雜湊、每 IP 每日訪客數上限 | `backend/auth_routes.py`、`backend/dev/guest_harness.py`（新） | `cd backend && POSTGRES_DB=g2_tmp SQL_ECHO=false uv run python dev/guest_harness.py 2>&1 \| grep -v sqlalchemy \| tail -5` → `ALL PASS`；涵蓋：建立訪客並可送訊息、已有 cookie 不重建、第 11 個訪客 429 且沒有新列、併發 20 個請求只成功剩餘名額、不同 IP 互不影響、資料庫沒有原始 IP、錯誤 `Origin` 403、訪客 A 讀不到訪客 B 與登入帳號的對話 |
| G2-3 | 額度：預設 10、訪客 IP 則數上限、退款含 IP 計數、`last_active_at` | `backend/main.py`、`docker-compose*.yml`、`backend/dev/guest_harness.py`、`backend/dev/quota_harness.py` | `guest_harness` → `ALL PASS`（新增：第 11 則 429、IP 第 101 則 429 `guest_ip_limit` 且個人額度未被扣、生成失敗兩個計數都退、白名單外模型 403 且不扣）；`quota_harness`、`regenerate_harness`、`auth_harness`、`model_options_harness`、`branch_entries_harness` → 都 `ALL PASS` |
| G2-4 | 登入時的訪客處理：額度併入、`guest_session` cookie、`guest_claim`、`POST /auth/guest-claim` | `backend/auth_routes.py`、`backend/dev/guest_harness.py` | `guest_harness` → `ALL PASS`（新增：merge 後對話與分支都屬於登入帳號且訪客列消失、discard 後訪客資料全部消失、訪客用了 7 則後登入當日只剩 3 則、沒有 `guest_session` 或 token 錯誤 → 409 且資料不變、訪客呼叫 → 403、重複呼叫 → 409、登入帳號 B 沒有訪客 A 的 `guest_session` 時搬不走 A 的資料） |
| G2-5 | 保留期限清理（背景 task＋可單獨呼叫的函式） | `backend/main.py`、`backend/dev/guest_harness.py` | `guest_harness` → `ALL PASS`（新增：8 天沒活動的訪客與其訊息、分支被刪；6 天的保留；登入帳號不受影響；`guest_ip_usage` 3 天前的列被刪） |
| G2-6 | 前端訪客模式：開始使用進訪客、側欄「登入」、登入頁返回、額度訊息、`allow_custom` | `frontend/src/components/AuthGate.jsx`、`LandingPage.jsx`、`Sidebar.jsx`、`ModelSelector.jsx`、`frontend/src/App.jsx` | `cd frontend && npm run build` 成功；改到的檔案 `npx eslint <檔案>` 沒有新增錯誤；瀏覽器清單 A |
| G2-7 | 前端搬移對話框 | `frontend/src/App.jsx`（或新元件 `GuestClaimDialog.jsx`） | build／eslint；瀏覽器清單 A |
| G2-8 | OpenRouter 連結：加密模組、connect／callback／disconnect | `backend/openrouter_connect.py`（新）、`backend/crypto_utils.py`（新）、`backend/main.py`、`backend/pyproject.toml`（加 `cryptography`）、`backend/dev/openrouter_connect_harness.py`（新） | `POSTGRES_DB=g2_tmp SQL_ECHO=false uv run python dev/openrouter_connect_harness.py 2>&1 \| grep -v sqlalchemy \| tail -5` → `ALL PASS`；涵蓋（換金鑰端點以假伺服器或 mock 取代）：成功後資料庫只有密文且可解回、`/auth/me` 為已連結且回應不含金鑰、`state` 不符／重放／換了登入者 → `state_mismatch` 且不存、訪客 → `login_required`、未設加密金鑰 → `unavailable`、換金鑰失敗 → `exchange_failed`、disconnect 後列消失、A 的 callback 不會寫到 B、擷取整段 log 輸出不含金鑰與 `code` |
| G2-9 | 用自己的金鑰生成：略過額度與白名單、一律走 OpenRouter、失效處理 | `backend/main.py`、`backend/openrouter_llm.py`、`backend/dev/openrouter_connect_harness.py` | 同一 harness → `ALL PASS`（新增：已連結者送 30 則都成功且 `daily_usage` 沒有列、假 LLM 收到的是該使用者的金鑰而未連結者收到平台金鑰、已連結者用 `gemini-x` 也走 OpenRouter、401 → 連結被刪且回覆為固定文字且沒有改用平台金鑰、402 → 連結保留、解密失敗 → 409 且沒有新訊息、`allow_custom` 正確）；G2-3 列出的其他 harness 仍 `ALL PASS` |
| G2-10 | 前端 OpenRouter 連結介面與提示 | `frontend/src/components/Sidebar.jsx`、`frontend/src/App.jsx`、`AuthGate.jsx` | build／eslint；瀏覽器清單 B |
| G2-11 | 隱私權說明、compose 環境變數、部署說明 | `frontend/public/privacy.html`、`docker-compose.prod.yml`、`CLAUDE.md`（Production deploy 補一行新環境變數與 migration） | `grep -n "CREDENTIAL_ENCRYPTION_KEY\|GUEST_IP_DAILY" docker-compose.prod.yml` 有輸出；build 成功；瀏覽器看隱私權頁 |

**狀態（2026-11-14）**：波次 1 完成，未 push。G2-1 `2d868ee`、G2-2 `d004ab3`、G2-3 `54a2151`、G2-4 `e902726`、G2-5 `19f68e3`。主代理在臨時資料庫 `g2_tmp` 重跑：`guest_harness` `ALL PASS (141)`；`auth`、`quota`、`regenerate`、`branch_entries`、`model_options`、`pool`、`limits` 七支 harness 都 `ALL PASS`。臨時資料庫的建法：`createdb g2_tmp` → `pg_dump -s chat_db | psql g2_tmp` → `POSTGRES_DB=g2_tmp uv run alembic stamp f1a2b3c4d5e6`（baseline migration 無法從空資料庫建表）。本機 `chat_db` 尚未執行這支 migration（仍在 `f1a2b3c4d5e6`）。實作時新增而規格沒寫的：`backend/rate_limit.py`（limiter 單一實例）、`backend/guest.py`（訪客相關純函式）；`GUEST_RETENTION_DAYS < 1` 時不刪任何訪客；`POST /auth/guest-claim` 無待處理訪客時回 409 並清掉 `guest_session` cookie。

**波次**
- 波次 1（後端，G2-1 到 G2-5）：沒有可看的畫面，做完回報後直接進波次 2。
- 波次 2（前端，G2-6、G2-7）：停下來等使用者跑瀏覽器清單 A。
- 波次 3（後端，G2-8、G2-9）：做完回報後直接進波次 4。
- 波次 4（G2-10、G2-11）：停下來等使用者跑瀏覽器清單 B。真的 OpenRouter 授權只能由使用者本人操作。

**瀏覽器清單 A（訪客模式；桌面 ≥ 768 與手機 < 768 各做一次）**
1. 未登入打開網站 → 首頁；按「開始使用」→ 進入聊天畫面，側欄左下是「試用中」與「登入」，沒有登出。
2. 送一則訊息 → 正常回覆；開一條分支 → 正常。模型選單可選免費模型，沒有自訂模型輸入。
3. 重新整理 → 還在聊天畫面，對話還在。
4. 把 `DAILY_MESSAGE_LIMIT` 設成 2 重啟後端，送第 3 則 → 看到「今日試用額度已用完。登入並連結 OpenRouter 就能繼續使用」。
5. 按側欄「登入」→ 登入頁；按「← 返回」→ 回到聊天。
6. 登入 → 出現「要把試用時的 N 個對話移到這個帳號嗎？」；選「移到帳號」→ 對話出現在側欄，分支與高亮都在。
7. 登出 → 回首頁。再用訪客建立對話、登入、選「刪除」→ 試用對話沒有出現，帳號原有對話不受影響。
8. 已登入狀態重新整理 → 直接進聊天，不出現首頁，也不再出現搬移對話框。
9. 無痕視窗打開網站 → 看不到其他視窗的訪客對話。

**瀏覽器清單 B（OpenRouter 連結）**
1. 登入後側欄底部顯示「連結 OpenRouter」與說明；訪客看不到這一列。
2. 按「連結 OpenRouter」→ 跳到 openrouter.ai 的同意頁 → 同意 → 回到本站並顯示已連結。
3. 模型選單出現自訂模型輸入；輸入一個付費模型 ID 送出 → 正常回覆（費用在你的 OpenRouter 帳號）。
4. 連續送超過 10 則 → 不會被每日額度擋下。
5. 到 OpenRouter 的金鑰頁撤銷那把金鑰，回來送一則 → 回覆顯示「你的 OpenRouter 連結已失效，請重新連結」，側欄回到未連結。
6. 重新連結 → 按「中斷連結」→ 回到未連結，自訂模型輸入消失，額度回到每日 10 則。
7. 在資料庫看 `openrouter_credential.key_encrypted` → 不是 `sk-or-` 開頭；`docker compose logs api | grep -c "sk-or-"` → 0。
8. 手機寬度：側欄底部的連結列不被瀏覽器工具列蓋住、文字不被截斷。

**部署注意**
- 新 migration：VM 上 `git pull` 後要 `sudo docker compose up -d --build` 再 `sudo docker compose exec api alembic upgrade head`。
- VM 的 `.env` 要新增 `CREDENTIAL_ENCRYPTION_KEY`（產生方式寫進教學文件）；遺失或更換會讓所有連結失效（使用者重新連結即可，對話不受影響）。
- 現有登入用戶的每日額度會從 20 變 10。
- 正式站在 V1-6 之前仍在 Cloudflare Access 後面。
