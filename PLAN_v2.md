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

**下一步**：G6-1 → G6-2 → 編輯最後一則 user 訊息（F9 的一部分，改為原地更新，細節待確認） → 後端 B2–B4 + 前端 F9（實作前先出教學文件）→ Phase 4。

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
| B3 | 後端：幽靈分支重連 API | ⏳ | DESIGN_P3 主題 2 |
| B4 | 後端：`/chat` context 組裝（`include_main`／`context_branch_ids`、token 截斷） | ⚠️ 待重新評估 | 依賴已廢棄的 F6，需確認是否仍要做 |
| F9 | 前端：編輯最後一則（inline regenerate）、幽靈分支重連 UI、入口管理右鍵選單 | ⏳ | DESIGN_P3 主題 3、5；範圍待確認 |
| G2 | 分支地圖依錨點位置排序 | ✅ | 1013464（cherry-pick 自 1c574f1，已在瀏覽器確認） |
| G3-1 | 共用組件抽取：`MessageList`／`ChatInput` 加 `variant`；「回到底部」改 absolute | ✅ | be02ad3（已在瀏覽器確認）；教學：`docs/20261101_(G3)shared-chat-pane-guide.html` |
| G3-2 | 分支面板套用共用組件（含 G4 模型標籤） | ✅ | 433effe（使用者瀏覽器驗收 7 項通過；窄面板微調延後） |
| G8 | 訊息功能列（首項：複製）＋ http 剪貼簿備援＋手機 user 長按選單 | ✅ | ff6f733（使用者驗證通過）；教學：`docs/20261102_(G8)message-actions-guide.html`；驗收見下方 |
| G5-B3 | 選取保持反白（G5）＋手機選字出現建立分支按鈕（BUGS B3）：Markdown 元件固定身分、selectionchange＋防抖、手機按鈕在下方 | ✅ | 804d0fd（使用者瀏覽器驗證通過）； 教學：`docs/20261102_(G5-B3)selection-change-guide.html`；驗收見下方 |
| G9 | user 訊息：原樣顯示（只渲染程式碼區塊／行內程式碼）＋畫面超過 10 行摺疊 | ✅ | f6b5f1a（使用者瀏覽器驗證通過）； 教學：`docs/20261103_(G9)user-message-collapse-guide.html`；驗收見下方 |
| G6-1 | 後端：幽靈分支資料欄位 migration、`POST /messages/{id}/regenerate`（原地重新生成＋幽靈化）、`/chats/roots` 過濾、緩衝清除競態修正 | ✅ | 3019e83（migration c6d7e8f9a0b1；假 LLM harness 27 PASS）； 教學：`docs/20261103_(G6)regenerate-guide.html`；驗收見下方 |
| G6-2 | 前端：最後一則 AI 回覆的重傳鈕（主對話＋分支） | ⏳ 待開始 | 依賴 G6-1 | 草稿已於 e051fec revert |
| T1 | 對話頁時間軸，效果參考 Gemini Voyager 插件（BACKLOG 第 4 項） | ⏳ 待辦 | 細節待討論；原 Phase 3 圓點列方案與已移除的左欄時間軸（F2-fix）皆不沿用 |

> B2–B4／F9 的拆分以 HANDOVER 為準，尚未寫驗收指令；開工前先補（可執行指令形式）並出教學文件。

### G2–G9（全部已確認）

細節見 `BACKLOG.md`。G1–G4、G7 已完成。

| 編號 | 需求摘要 | 狀態 |
|---|---|---|
| G2 | 分支地圖依「位置順序」排序，不依建立時間 | ✅ 完成（1013464） |
| G3 | 「跳至底部」按鈕不應出現在分支視窗 → 擴大為主對話／分支共用組件 | ✅ 完成（be02ad3、433effe） |
| G4 | 分支對話顯示模型資訊 | ✅ 完成（併入 G3-2，433effe） |
| G5 | 調整選取範圍時保持反黑（手機控制棒／桌面 shift+方向鍵） | ✅ 完成（G5-B3，804d0fd） |
| G6 | 模型回傳錯誤時的重傳機制 → 最後一則回覆一律可重傳 | ✅ 已確認（G6-1、G6-2） |
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
- 送出 → **刪除舊的那輪**（舊 user + 舊 AI），主對話**保持線性**（不長分支）。
- 輸入框顯示**警語**。
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
