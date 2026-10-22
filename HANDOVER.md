# HANDOVER.md — 交接文件（2026-10-22）

> 給下一個對話（切到 MiniMax M3）的交接。開始前依序讀：`ct-chat-router` skill → `PLAN_v2.md` → `DESIGN_P3.md` → 本文件。

## 專案

CT-Chat-Router：多模型 AI 聊天（樹狀對話）。repo：`~/0_Sundry/Coding/20251112_AIBox/ai-chat-backend`（git main）。
後端 FastAPI＋SQLModel＋PostgreSQL（`backend/`，deps 用 uv）；前端 React 19＋Vite＋Tailwind（`frontend/src/`，單一入口 App.jsx）。

## 已完成（已 commit＋push）

- Phase 0（OAuth 登入、限流、模型白名單）、Phase 1（Branch 表）、Phase 2（分支功能＋P2-8~P2-15 修正）。
- **Phase 3b（互動/UI）Wave 1＋Wave 1.5**：
  - F1a 捲動只在底部 100px、F1b 閱讀位置＋`scrollToMessage`＋reload 定位最後 user、F2 左欄 % 寬（12–30%）、F3 右欄 % 寬（20–50%）。
  - F1a-fix 貼底自動捲＋捲到底按鈕、F2-fix 移除時間軸＋⋯ 選單。
  - 修正：訊息版面回歸、⋯ 選單 z-index、串流洩漏（AbortController）。

## 設計定稿（`DESIGN_P3.md`，5 主題，都已定稿）

1. 選取 offset：source markdown 基準、rehype position 對映、重疊→降級底部入口、anchor_text 校驗。
2. 幽靈分支：anchor nullable＋`is_orphaned`＋`attach_root_id`、重連 API。
3. 編輯最後一則：單一端點 regenerate（原子交易）、冪等。
4. 上下文開關：`include_main`＋`context_branch_ids`、token 截斷。
5. 入口管理/wiki：一層分支（不做巢狀）、`[[分支標題|顯示文字]]` 語義、兩個右鍵選單、標題只在右側邊欄改。

## 尚未解決的 bug（先修這兩個）

### Bug A：串流中切走再切回 → 卡在 Thinking...
- **現象**：送出訊息後切到別條對話，再切回來，那則 AI 一直顯示 Thinking...；重新整理也沒用。
- **根因**：串流洩漏修正用了 AbortController；切走會 abort fetch → 前端收不到串流文字。後端 `/chat` 在送出時就先 commit user＋空 ai 訊息，abort 後 ai 內容沒被更新 → DB 留空 ai 訊息 → reload 也空。
- **修法方向（擇一）**：
  - (a) 不 abort，改「背景繼續收、按對話 buffering」，切回時顯示完整內容（最佳 UX，較複雜）。
  - (b) abort 時呼叫取消/刪除端點回滾 user＋ai。
  - (c) 切回時 re-fetch，若最後 AI 為空 → 顯示「生成中斷」＋可重試（接主題 3 的 regenerate）。
  - 建議 (a) 或 (c)，需改 `/chat` 串流生命週期，與主題 3 連動。

### Bug B：左側欄標題右端仍有大距離被覆蓋
- **現象**：標題文字右端被裁掉，但右邊還有一大段空白（裁得太早）。
- **根因**：F2 標題用 nowrap＋overflow-hidden，但標題 span 的 flex 寬度被限制太小，沒吃到 ⋯ 按鈕左側的剩餘空間。
- **修法**：標題吃滿可用空間（`flex-1 min-w-0`），只在不夠時才裁。

## 下一步（照順序）

1. 修 Bug A、Bug B。
2. Wave 2：F4 模型選單移到輸入框下方＋右上角改右側欄開關（App.jsx＋ChatHeader＋ChatInput）。
3. Wave 3：F5 手機左右滿版 drawer（驗收要列「375px 手動確認項」）。
4. Wave 4：F6 上下文開關面板（純 UI、假資料，不定死資料結構）。
5. 後端 B1–B4＋前端 F7–F9（照 DESIGN_P3.md）：offset 欄位、刪除端點＋幽靈、重連、/chat context。**實作前先出圖文教學文件**（使用者正在學後端）。

## 工作流慣例

- 每任務一 commit（`feat:/fix:/docs:`＋任務編號 `P3b-x`）。
- 子代理：`delegation.model = deepseek-v4.1-flash`（thinking 已關閉）；只動指定檔、不 push、回報一行摘要＋commit hash。
- 每個 wave 完成 → 停下給使用者手動驗證 → 放行下一 wave。
- PLAN／design 文件變更單獨 commit。
- 派子代理時 goal/context 不可含 `{ }` 或 `< >`（會被拒為「未展開的模板標記」）。
- 驗證不要只信子代理自報：跑 git log/status、grep 關鍵碼、`npm run build`。

## 模型交接

- 父模型從 deepseek-v4-pro（opencode-go）切到 **MiniMax M3**。delegation 子代理維持 deepseek-v4.1-flash。
- 新對話開場：載入 ct-chat-router skill（專案狀態都在那）＋讀 `PLAN_v2.md`／`DESIGN_P3.md`／`HANDOVER.md`。
