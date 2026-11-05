# 已知問題清單

> 記錄執行過程中發現、但不屬於當前步驟的問題。修正時另開步驟，獨立 commit。
> 既有問題 E1–E12 見 `PLAN_20261012.md` 附錄。

---

## B1：P2 空白輸入框出現滾動條

- **發生於**：P2 commit（`ef2166a`）之後，桌面寬度
- **發現於**：P5b 實作過程
- **重現**：開啟頁面，輸入框為空，右側出現滾動條
- **預期**：單行無滾動條；手機版空白時維持單行高度
- **疑似原因**：空白時強制 `height: 56px`，但 textarea 的 `py-4`（上下各 16px）與 1px 邊框使內容區只剩約 22px，一行文字放不下，`scrollHeight`（約 56px）大於 `clientHeight`（約 54px），`overflow-y-auto` 因此顯示滾動條。原本的 `scrollHeight + 2` 寫法不會有此問題。
- **驗證方法**：空白時於 console 執行 `const t = document.querySelector('textarea'); [t.scrollHeight, t.clientHeight]`，若 `scrollHeight > clientHeight` 即確認原因。
- **狀態**：待修，對應步驟 `P2-fix`（見計畫文件）
- **注意**：修正時須同時確認手機版 P2 原本要解決的問題（空白時框變高）不會回歸。

---

## B2：P5b 驗收失敗：手機版側邊欄收起時，時間軸標籤仍浮現

- **發生於**：P5b 驗收（已載入 T1 測試資料）
- **驗收條件**：（原驗收項目未涵蓋此情境，需新增，見 `PLAN_20261012.md` P5b 驗收第 4 項）
- **寬度/瀏覽器**：手機寬度（< 768px），Chrome（DevTools 手機模擬或實機，待補）
- **重現步驟**（待確認）：
  1. 手機寬度開啟頁面，側邊欄預設為收起。
  2. 點擊左上角 ☰ 展開側邊欄，在列表上捲動。
  3. 再點 ☰ 收起側邊欄。
  4. 觀察主畫面右側：出現「近 7 天」、「近 30 天」等時間軸標籤。
- **預期**：側邊欄收起時，時間軸標籤完全不可見，也不攔截觸控。
- **疑似原因**（待驗證）：
  1. `Sidebar.jsx` 的外層容器在收起時為 `w-0`，但沒有 `overflow-hidden`，而 `TimelineRail` 的 `<nav>` 是 `absolute right-1`，因此標籤會溢出到主畫面。
  2. 若拖曳標籤時 `pointerup` 沒有觸發（例如按住後立即點 ☰），`scrubbingRef` 與 `scrubbing` 會卡在 `true`，導致 `hideInactive` 變為 `false`，所有群組標籤都顯示，且 `visible` 也不會被淡出。
- **驗證方法**：
  - 在 DevTools 中收起側邊欄後檢查 `<nav aria-label="對話時間軸">` 的 `class` 與 `opacity`。
  - 若是 `opacity-100` 或所有標籤都是 `opacity-100`，代表 `visible` 或 `scrubbing` 狀態卡住。
  - 若 `nav` 的位置在主畫面內，代表溢出問題。
- **修正方向**（待確認後執行）：
  - 收起側邊欄時，不渲染 `TimelineRail`，或強制 `visible=false`、`scrubbing=false`。
  - 在外層容器加上 `overflow-hidden`，避免溢出。
- **狀態**：已完成

---

## B3：手機長按選取 AI 文字，不出現「建立分支」按鈕

- **發現於**：G8 驗收（2026-11-02，部署環境，手機）
- **重現**：手機（< 768px，觸控）長按 AI 回覆文字 → 原生選取出現、可拖控制棒調整範圍 → 沒有「建立分支」浮動按鈕
- **預期**：比照 PLAN_v2 第八節「手機：長按選取 → 上方浮現按鈕，參考 Claude 手機網頁版」
- **根因（已查）**：`MessageList.jsx` 只在 AI 泡泡的 `onMouseUp` 判斷選取（P2-4，e751a56 起）。手機觸控選字不會觸發 mouseup，所以從未在手機上運作；不是 G8 造成的回歸。
- **修正方向（待討論）**：改用 `document` 的 `selectionchange` 事件偵測「選取落在 AI 泡泡內」，選取調整時按鈕跟著移動。此做法同時涵蓋 G5（調整選取範圍時保持反黑：手機控制棒、桌面 shift+方向鍵）。新概念，需先出教學文件。
- **狀態**：已完成（G5-B3，804d0fd）

---

## B4：剛送出的 user 訊息沒有 id，鉛筆／長按「編輯」不出現

- **發現於**：F9-2 驗收（2026-11-03，桌面＋手機）
- **重現**：在既有對話（或分支）送出新訊息，等 AI 回完 → 最後一則 user（時間顯示「剛剛發送」）沒有鉛筆，手機長按選單也沒有「編輯」；切換對話再切回才出現
- **預期**：AI 回完後即可編輯（F9 規格：最後一則 user 與其 AI 都有 id 即可編輯）
- **根因（已查）**：送出時 user 訊息是樂觀塞進去的、沒有 id。G1（4034f55）只在 `prev[0]`（新對話第一則）補 `X-User-Message-Id`；既有對話的後續訊息不補。分支的 `sendBranchMessage` 完全沒讀這個 header。F9 的 `canEdit` 要求 user 有 id，所以不顯示。重新載入後訊息從後端來，才有 id。
- **修正方向**：主對話與分支都在讀到 `X-User-Message-Id` 時，補到「最後一則 assistant 前面那則、沒有 id 的 user」（倒數第二則），涵蓋原本 G1 的第一則情況。
- **狀態**：已完成（F9-B4，f5ca79e，使用者瀏覽器驗證通過）

---

## B5：手機版標題列與輸入框部分跑出畫面外

- **發現於**：使用者回報（2026-11-03，手機，部署環境；長期存在）
- **重現**：手機瀏覽器開啟對話頁 → 上方標題列或下方輸入框有一部分在畫面外，要把整頁捲到最頂或最底才看得完整
- **預期**：標題列與輸入框固定在可見範圍內，只有訊息區捲動
- **疑似原因（待驗證）**：`App.jsx` 最外層用 `h-screen`（`height: 100vh`）。手機瀏覽器的 `100vh` 是「網址列收起時」的最大高度，網址列顯示時可見區域比它矮，整頁因此多出一截可以捲動，標題或輸入框被推出畫面。
- **修正**：最外層 `h-screen supports-[height:100dvh]:h-dvh`（支援 dvh 時用動態可見高度，舊瀏覽器退回 100vh）。教學：`docs/20261103_(B5)mobile-viewport-height-guide.html`
- **狀態**：已完成（3300f1f，使用者手機驗證通過）

---

## B6：選取範圍的端點落在既有高亮內 → 新分支沒有 offset，直接變成底部入口

- **發現於**：E3 瀏覽器驗收（2026-11-04，桌面）
- **重現**：建立分支 A → 選一段「結尾落在 A 高亮裡」的文字（或選跟 A 完全相同的文字）→ 建立分支 B → B 直接出現在底部入口，A 仍是高亮
- **預期**：B 成為 inline 高亮，A 降級為底部入口；完全相同的範圍 → 開既有分支 A（E 決策 4）
- **原因（讀程式確認，尚未在瀏覽器量測）**：`rehypeHighlight` 產生的 `<mark>` 節點帶 `data-s／data-e`，但 `MessageList` 的 `mark` 元件渲染 DOM 時沒有把這兩個屬性傳下去。`selectionOffset.js` 從選取端點往上找 `data-s`，落在 mark 裡就找不到 → 回傳 null → 前端送出沒有 offset 的建立請求 → 後端依規則當成底部入口、不做重疊檢查。端點都落在 mark 外（例如選取完整包住 A）時正常，所以看起來「有時正常」。
- **修正**：`mark` 元件（可點與純高亮兩種）把 `node.properties` 的 `data-s`、`data-e`、`data-branch` 轉到 DOM 上。
- **狀態**：已修（873a440），待使用者瀏覽器驗證重疊情境

---

## B7：選取跨 Markdown 粗體時，高亮在粗體邊界斷成兩段

- **發現於**：E3 瀏覽器驗收（2026-11-04，桌面）
- **重現**：選取「最佳造訪季節**： 6–8 月白天」這種跨粗體結尾的文字建立分支 → 高亮看起來是兩段
- **原因**：`rehypeHighlight` 依設計在每個 text node 內各包一個 `<mark>`（不破壞粗體結構），而 `ANCHOR_MARK_CLASS` 每段都有 `rounded-sm px-0.5`，相鄰兩段之間出現圓角與間隙；hover 也是各段各自變色（使用者截圖確認）。
- **修正方向（使用者同意先做出來看效果）**：`rehypeHighlight` 在同一分支的第一段 mark 加 `data-first`、最後一段加 `data-last`；樣式只在 first 左側、last 右側有圓角與留白。滑過任一段 → 同一分支所有段一起變色（在 MessageList 容器用事件委派，對同 `data-branch` 的 mark 設 `data-hover` 屬性，樣式用 `data-[hover]:`，不經 React state，避免整段 Markdown 重新渲染）。
- **狀態**：✅ 已修正 f785aed（使用者瀏覽器確認）

---

## B8：底部入口文字太長時不換行

- **發現於**：E3 瀏覽器驗收（2026-11-04）
- **現象（使用者截圖）**：底部入口與回覆內文都沒換行，AI 泡泡比畫面寬，底部出現水平捲軸。
- **原因（讀程式＋截圖判斷）**：E3 的 `BRANCH_ENTRY_TEXT_CLASS` 用 `truncate`（`white-space: nowrap`）。泡泡寬度依內容決定，最長的入口不換行就把泡泡撐到它的全長，內文也跟著用這個寬度排版，看起來就像內文不換行。
- **修正**：入口改成可換行（`whitespace-normal break-words`），併入 E3。
- **狀態**：已完成（2bbf0af，使用者確認換行正常）

## B9：正式環境的 SQL 日誌可能記下使用者資料

- **發生於**：`backend/database.py` 的 `create_engine(DATABASE_URL, echo=True)`，所有環境
- **發現於**：H3 部署後檢查 `docker compose logs api`（2026-11-05）
- **重現**：`sudo docker compose logs api --tail 5` → 看得到 SQL 與參數，例如 `{'session_id': ...}`
- **預期**：正式環境不記錄 SQL 語句與參數，只在開發需要時打開
- **影響**：SQLAlchemy 的 echo 會連參數一起輸出，寫入訊息時對話內容可能進入容器日誌
- **修正**：預設關閉，只有環境變數 `SQL_ECHO` 為真時才開啟
- **狀態**：已完成（862acf2，已部署，正式環境日誌驗證通過）

## B10：OAuth state 和登入 token 共用 `session` cookie，登入後 token 立刻被刪

- **發生於**：`backend/main.py` 的 `SessionMiddleware`（預設 cookie 名 `session`）與 `backend/auth_routes.py` 的 `SESSION_COOKIE_NAME = "session"`
- **發現於**：S-U1 規劃時讀程式並做 spike（2026-11-05）
- **重現**：spike 用相同設定的假路由，callback 回應依序有 `session=<token>` 與 `session=null; expires=1970`；curl cookie 檔重播後，下一個請求沒有 `session` cookie。尚未用真實瀏覽器與真實 OAuth 重現
- **預期**：callback 後 `session` cookie 保留 token，`GET /auth/me` 回 200
- **原因**：authlib 清掉 state 後暫存內容變空，middleware 在回應最後補上刪除同名 cookie 的標頭
- **注意**：Python cookie jar（`TestClient`／httpx）重播時 token 仍在，會誤判沒問題；測試要用 curl 並檢查 `Set-Cookie` 標頭
- **修正方向**：`SessionMiddleware` 改用 `session_cookie="oauth_state"`（S-U1-1）。教學：`docs/20261105_(S-U1)user-ownership-guide.html`
- **狀態**：已修（6541856），auth_harness 通過（含移除修正後測試會失敗）；待真實瀏覽器驗證（S-U1-8）

## B11：刪除有分支的對話會失敗，前端沒有提示

- **發生於**：`DELETE /chats/{root_id}`（`backend/main.py`）與 `App.jsx` 的刪除流程；早於 S-U1
- **發現於**：S-U1-4 harness（2026-11-05）
- **重現**：對話中有錨定或已有訊息的分支 → 刪除 → 500。在會 rollback 的交易中確認，刪除被引用的訊息會撞上 `fk_branch_anchor_message_id_message`、`fk_branch_root_message_id_message`。尚未在瀏覽器重現
- **預期**：刪除成功，或清楚告知失敗原因
- **原因**：刪除前只清 `attach_root_id`，沒有處理 `anchor_message_id`、`root_message_id`。前端的 `fetch` 沒檢查 `response.ok`，500 也照常刷新列表，對話仍在且沒有錯誤訊息
- **修正方向（待討論）**：刪除對話時，對話內的分支要一起刪，還是變成幽靈？刪除的範圍涉及 X1（刪除前匯出 JSON）
- **狀態**：待討論
