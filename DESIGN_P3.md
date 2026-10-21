# DESIGN_P3.md — Phase 3b 設計定案

> 狀態：依主題逐一討論定稿，每主題經使用者確認後才進下一個。
> 對應 `PLAN_v2.md` 第八章（Phase 3b）。任務編號 P3b-x。

## 主題 1：選取 offset 演算法（狀態：已定稿）

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
- **程式碼區塊**：允許開分支，但**不做 inline 高亮**；改為「對話底部標題入口」（用主題 2 的 `attach_root_id`）。
- **巢狀／重疊選取**（新選取範圍已含既有分支文字）：允許，這是「分支再分支」（`parent_branch_id` 已支援）。渲染成**巢狀 `<mark>`**（先包外層、再包內層）；內層 `onClick` 用 `stopPropagation()` 防連動；**完全重疊**時不重複建分支，直接開既有那條。

### 1.5 anchor_text 校驗
- 建立時存 `anchor_text = source[start:end]`（快照）。
- 載入／高亮時：若 `source[start:end] !== anchor_text` → 標記該高亮**失效**，fallback 到「底部標題入口」，不拋錯。
- 註：AI 回覆幾乎不會被編輯，故失效**極少發生**；主要情境是訊息內容被改（含變短導致 offset 越界）。「編輯最後一則」刪掉錨點訊息走「幽靈分支」（主題 2），不屬失效。

### 1.6 資料結構（Branch 新增欄位）
```
anchor_start: int | None   # source 字元 offset，含起點
anchor_end:   int | None   # 不含終點（半開區間 [start, end)）
anchor_text:  str | None   # = source[start:end] 快照，校驗＋顯示用
```
- `anchor_start` / `anchor_end` 為 None 代表舊資料或無精確定位 → 退階純文字比對，標 `precise = false`。
- （`attach_root_id`／`is_orphaned` 見主題 2。）

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

# 高亮（AST 層，先外後內）
highlight(content, anchors):
  hast = parseMarkdown(content)          # 帶 position
  for a in anchors sorted by (range desc, start asc):   # 外層先、內層後
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
| 選取與 code block 交集 | 允許，但改「底部標題入口」（不 inline 高亮） |
| 巢狀／重疊既有分支 | 巢狀 mark + stopPropagation；完全重疊 → 開既有分支 |
| 訊息事後被編輯 | anchor_text 校驗失敗 → fallback 底部標題入口 |
| 同一則訊息多個錨點 | 各自 offset，依範圍外→內替換 |
| 空選取／僅空白 | 不開分支 |
| 舊資料無 offset | precise=false，退階純文字比對 |

---

## 主題 2：幽靈分支資料設計與重連 API（狀態：待確認）

### 2.1 情境
「編輯最後一則」會刪除舊一輪（user＋AI）。若該輪上有分支錨定，這些分支的錨點消失 → **幽靈分支**。

### 2.2 資料模型決策
- `anchor_message_id` 改 **nullable**。
- 新增 `is_orphaned: bool = False`。
- 新增 `attach_root_id: UUID | None`（底部入口型分支所屬的對話 root id）。
- 三態：
  - **inline 錨定**：anchor_message_id 非空、attach_root_id 空、is_orphaned False。
  - **底部入口**：anchor_message_id 空、attach_root_id 非空、is_orphaned False。
  - **幽靈**：兩者皆空、is_orphaned True。

### 2.3 刪除一輪 → 幽靈化
- 刪除 user＋AI 前，找出 `anchor_message_id` 落在刪除集合的分支 → 設 `anchor_message_id=NULL`、`is_orphaned=True`。
- 分支自己的訊息**保留**；其 root 訊息的 `parent_id` 斷開（設 NULL）。`get_chat_roots` 需加 `branch_id IS NULL` 過濾，避免孤兒被誤當成新對話。

### 2.4 幽靈分支顯示位置（UI）
- 側邊欄底部「未連結分支」區段，每項顯示標題＋「重連」按鈕。
- 重連：選一個對話（picker）→ 確認。

### 2.5 重連 API
- `POST /branches/{branch_id}/relink`，body `{ root_id: uuid }`。
- 效果：`attach_root_id = root_id`、`is_orphaned = False` → 成為該對話的**底部標題入口**（**不需 offset**）。

### 2.6 Branch 最終欄位（合併主題 1＋2）
```
id: UUID (PK)
title: str | None
parent_branch_id: UUID | None
anchor_message_id: UUID | None      # nullable（inline 錨定用）
anchor_start: int | None            # 主題 1
anchor_end: int | None              # 主題 1
anchor_text: str | None             # 主題 1
attach_root_id: UUID | None         # 底部入口所屬對話（主題 2）
is_orphaned: bool = False           # 主題 2
root_message_id: UUID | None        # 分支首則訊息，送出後回填
created_at: datetime
```

### 2.7 migration 草案
- `alter branch.anchor_message_id drop not null`
- `add branch.anchor_start int null`
- `add branch.anchor_end int null`
- `add branch.attach_root_id uuid null`（FK message.id）
- `add branch.is_orphaned boolean not null default false`
（`anchor_text` 已存在，不動。）

### 2.8 邊界案例
| 情境 | 處理 |
|---|---|
| 刪除一輪，其上有多條分支 | 全部幽靈化 |
| 分支再分支（parent_branch_id） | 父幽靈 → 子跟著幽靈；重連父時子一併歸屬 |
| 幽靈一直不重連 | 留在「未連結分支」列表，不自動刪 |
| 整棵刪除（DELETE /chats/root） | 級聯刪，分支**一起刪**（不等同幽靈） |
| 重連到已有同標題入口的對話 | 允許，底部列出多個標題入口 |
| 幽靈分支尚未送出訊息（root_message_id 空） | 仍可重連；點入口開空分支、預填 anchor_text |

---

## 主題 3：編輯最後一則的刪除交易與端點（待討論）

## 主題 4：上下文開關與 /chat context 組裝（待討論）
