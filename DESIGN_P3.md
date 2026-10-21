# DESIGN_P3.md — Phase 3b 設計定案

> 狀態：依主題逐一討論定稿，每主題經使用者確認後才進下一個。
> 對應 `PLAN_v2.md` 第八章（Phase 3b）。任務編號 P3b-x。

## 主題 1：選取 offset 演算法（狀態：待確認）

### 1.1 offset 基準
**決策：以 source markdown 為基準。**
- 資料庫的 canonical 內容是 `Message.content`（markdown 原始字串），md 匯出也以它為準。
- 渲染後文字是「衍生物」（語法字元被移除、空白／換行被重排），沒有穩定方式反向對映回 source。
- 因此 `anchor_start` / `anchor_end` 一律是 **source 字串的字元 offset（0-based，半開區間 [start, end)）**。

### 1.2 DOM 選取 → source offset 對映
**決策：用 unified/remark 的 position（rehype 外掛把 text node 標上 source offset）。**

原理：
- remark 解析 markdown 時，每個節點（含 inline `text` 節點）都帶 `position.start.offset` / `position.end.offset`。
- 渲染時，用一個自寫的 **rehype 外掛**，把每個 text node 包成帶 `data-s`（start）與 `data-e`（end）的 span（只在「該則訊息有分支錨點」時啟用，避免無謂 DOM 膨脹）。
- 選取時：`window.getSelection()` 拿 Range → `startContainer`／`startOffset` 向上找到帶 `data-s` 的 span → `source_offset = data-s + 節內 offset`。

替代方案（比較後不採用）：
- (b) 自製 renderer 維護 running offset：等於重寫 ReactMarkdown，成本高。
- (c) 對「渲染後純文字」做 index 比對：渲染後文字與 source 有差異（語法移除、空白），脆弱。

### 1.3 高亮與匯出方式
**高亮：走 AST，不走字串 split（之前破版的根因）。**
- parse source → HAST（帶 position）→ 走訪 text node，找出與 [start,end) 重疊者 → 在 text node 內部分割、包 `<mark data-branch="id">` → 渲染。
- 結構（粗體／列表／連結／表格）因此不被切碎。

**匯出 md：直接對 source 字串做「單次、由右到左」替換。**
- 依 start 由大到小排序，替換成 `[[...]]` 或 `==...==`（依匯出開關）；由右到左使後面的替換不影響前面 offset。

### 1.4 跨語法選取
- 因 offset 對 source，跨粗體／列表／連結／多段落都能用同一對 start/end 定位，不需特判。
- **吸附規則**：start/end 若落在「語法字元」上（如 `**`、`[`、`` ` ``），把 start 向後、end 向前收斂到最近的合法文字字元邊界。
- **程式碼區塊**：不允許開分支；選取範圍與 code block 有交集 → 忽略並提示「程式碼區塊無法開分支」。

### 1.5 anchor_text 校驗
- 建立時存 `anchor_text = source[start:end]`（快照）。
- 載入／高亮時：若 `source[start:end] !== anchor_text`（訊息被編輯、或 offset 失效）→ 標記該高亮**失效**（不渲染、或顯示灰掉提示），不拋錯。
- 這也涵蓋「訊息事後被編輯 → 舊 anchor 偏移失效」的情境。

### 1.6 資料結構（Branch 新增欄位）
```
anchor_start: int | None   # source 字元 offset，含起點
anchor_end:   int | None   # 不含終點（半開區間 [start, end)）
anchor_text:  str | None   # = source[start:end] 快照，校驗＋顯示用
```
- `anchor_start` / `anchor_end` 為 None 代表舊資料或無精確定位 → 退階純文字比對，標 `precise = false`。

### 1.7 API 簽名（create_branch 擴充）
- `CreateBranchRequest` 新增 `anchor_start: int | None`、`anchor_end: int | None`（`anchor_text` 已有）。
- `create_branch` 存入 Branch；回傳一併帶回 `anchor_start` / `anchor_end` / `precise`。

### 1.8 偽程式碼（概念層）
```
# 選取 → source range
onMouseUp(e, msg):
  sel = window.getSelection()
  if sel.isCollapsed: return
  r = sel.getRangeAt(0)
  start = sourceOffset(r.startContainer, r.startOffset)   # 找 data-s span
  end   = sourceOffset(r.endContainer,   r.endOffset)
  if start > end: swap(start, end)
  text = msg.content.slice(start, end)
  showFloatingButton({msgId, start, end, text})

# 高亮（AST 層）
highlight(content, anchors):
  hast = parseMarkdown(content)          # 帶 position
  for a in anchors sorted by start desc:
    if content.slice(a.start, a.end) != a.text: mark(a, invalid); continue
    for tn in textNodes(hast):
      if overlap(tn.pos, a):
        splitAndWrap(tn, a, mark with data-branch=a.branchId)
  return render(hast)

# 匯出 md
exportMd(content, anchors):
  out = content
  for a in anchors sorted by start desc:
    out = out[:a.start] + makeLink(a) + out[a.end:]
  return out
```

### 1.9 邊界案例
| 情境 | 處理 |
|---|---|
| 選取跨粗體／連結／列表 | start/end 對 source 定位，正常 |
| 選取含語法字元（`**` 等） | 吸附到最近合法文字邊界 |
| 選取與 code block 交集 | 拒絕＋提示 |
| 訊息事後被編輯 | anchor_text 校驗失敗 → 高亮失效標記 |
| 同一則訊息多個錨點 | 各自 offset，依 start 由大到小替換 |
| 空選取／僅空白 | 不開分支 |
| 舊資料無 offset | precise=false，退階純文字比對 |

---

## 主題 2：幽靈分支資料設計與重連 API（待討論）

## 主題 3：編輯最後一則的刪除交易與端點（待討論）

## 主題 4：上下文開關與 /chat context 組裝（待討論）
