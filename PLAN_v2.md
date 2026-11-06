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

**下一步**：S-U1 資料綁定使用者（已確認規格，教學待使用者讀完說「開始」，見第八節「S-U1 規格與驗收」）→ S-U2（待討論）→ E5（暫停中）→ 窄面板微調（G3-2 延後項）→ T1 → Phase 4 → Phase 5。B4 待重新評估。

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
| S-U1-9 | implementer | `user_id` NOT NULL、刪 `session_id` | ⏳ fc3e92d 已 merge 到 main，本機 chat_db 已升級（revision e8f9a0b1c2d3）；臨時資料庫驗收通過（auth 130、regenerate 47、branch_entries 84 PASS）；VM 未部署 |

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
- `DELETE /chats/{root_id}`：刪訊息前，把 `attach_root_id` 落在要刪的訊息 id 內的分支設為 NULL（同一個交易）。
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
