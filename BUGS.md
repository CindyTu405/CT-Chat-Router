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
