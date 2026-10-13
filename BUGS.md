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
- **狀態**：待修，需新增步驟 `P5b-fix`
