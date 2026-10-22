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
- **重疊選取**（新選取範圍與既有高亮文字重疊）：**一層分支、不做巢狀高亮**。新分支降級為「底部標題入口」，既有高亮保持 inline；**完全重疊**時直接開既有分支（不重複建）。

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

# 高亮（AST 層）
highlight(content, anchors):
  hast = parseMarkdown(content)          # 帶 position
  for a in anchors sorted by start desc:   # 互不重疊，由右到左
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
| 重疊既有高亮 | 新分支降級「底部入口」（不巢狀）；完全重疊 → 開既有分支 |
| 訊息事後被編輯 | anchor_text 校驗失敗 → fallback 底部標題入口 |
| 同一則訊息多個錨點 | 各自 offset，互不重疊，依 start 由大到小替換 |
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
| 幽靈一直不重連 | 留在「未連結分支」列表，不自動刪 |
| 整棵刪除（DELETE /chats/root） | 級聯刪，分支**一起刪**；**刪除前彈警語**（提示會連同 N 條分支刪除） |
| 重連到已有同標題入口的對話 | 允許，底部列出多個標題入口 |
| 幽靈分支尚未送出訊息（root_message_id 空） | 仍可重連；點入口開空分支、預填 anchor_text |

> 註：巢狀分支（分支再分支 `parent_branch_id`）目前 UI 未開放（只從主對話開分支），「父幽靈→子幽靈」留待未來開放巢狀分支時再定義，現階段不處理。

---

## 主題 3：編輯最後一則的刪除交易與端點（狀態：待確認）

### 3.1 決策：單一端點（regenerate），不用「刪除＋/chat」兩步
- 刪舊＋建新必須**原子**（同一交易），否則刪完 /chat 失敗就永久丟了舊一輪。
- 端點：`POST /messages/{message_id}/edit`，body `{ content: str }`。

### 3.2 交易流程
1. 載入目標訊息，驗證 `role == "user"` 且是「最後一則 user 訊息」（其 AI 回覆即舊一輪）。
2. 找出錨定在舊 user＋舊 AI 上的分支 → 幽靈化（主題 2）。
3. 刪舊 AI → 刪舊 user（leaf 先刪，避 FK）。
4. 建新 user 訊息：content=編輯後、parent_id=舊 user 的 parent_id、branch_id=舊 user 的 branch_id。
5. commit（新 user 拿到 id）。
6. 串流 AI 回覆（沿用 /chat 的 generator）。

### 3.3 回傳
- 串流 + headers：`X-Message-Id`（新 AI id）、`X-User-Message-Id`（新 user id）。

### 3.4 失敗情境表
| 情境 | 狀態與處理 |
|---|---|
| 驗證失敗（非最後一則 user） | 400，不變更資料 |
| 交易成功、串流開始前失敗 | 新 user 已存在、無 AI 回覆；前端顯示錯誤、可重試 |
| 串流中途斷線 | 新 user＋空 AI 已存在；前端標連線錯誤；重試需避免重複建 user（冪等） |
| 串流成功 | 正常 |

### 3.5 冪等（重試安全）
- 重試若發現「該 user 已有 AI 子訊息」→ 不重複建，改用既有 AI 重跑串流（或回傳既有內容）。
- 或用 client 送 `request_id` 去重。

## 主題 4：上下文開關與 /chat context 組裝（狀態：待確認）

### 4.1 請求 schema（ChatRequest 擴充）
- `include_main: bool = False`（分支視圖：是否納入主對話）
- `context_branch_ids: list[uuid] = []`（額外納入的分支 id 清單）

### 4.2 組裝方式
- **基礎 history**：沿用現有 `get_conversation_history(parent_id)` 的線性祖先鏈（主對話＝主幹鏈；分支＝該分支鏈＋錨點祖先）。
- **額外線程**：對每個 `context_branch_ids` 取該分支的線性鏈；`include_main` 再取主幹鏈。
- **注入位置與格式**：額外線程用分隔標記包成「額外參考上下文」區塊、標明來源標題，附在基礎 history 之前（作為參考材料）；基礎 history 保持不變。
- **巢狀分支**：納入某分支＝只納入其自身線性鏈；子分支（若未來開放）不自動納入。

### 4.3 token 截斷策略
- 估算：約 `chars / 4`（或接 tokenizer 更準）。
- 優先：**基礎 history 完整保留**；額外線程先截。
- 每個額外線程設上限（保留**尾部**較新的訊息）；總額外量超過剩餘預算 → 依選取順序丟最舊的。
- 預算 = 模型 context window − 輸出保留額。

### 4.4 範例 1：主對話加選分支 A
- 請求：`parent_id`=主幹最後一則、`include_main=false`、`context_branch_ids=[A.id]`
- 組裝：主幹鏈（基礎）＋ A 鏈（標記「額外分支：A.title」）

### 4.5 範例 2：分支加選主對話
- 請求：`branch_id`=B、`parent_id`=B 最後一則、`include_main=true`、`context_branch_ids=[]`
- 組裝：B 鏈＋錨點祖先（基礎）＋主幹鏈（標記「主對話」）

### 4.6 邊界案例
| 情境 | 處理 |
|---|---|
| 選的分支已刪除／幽靈 | 忽略該 id（前端先過濾） |
| 選的分支無訊息 | 略過 |
| 勾選過多爆預算 | 額外線程截斷／丟最舊 |
| 主對話自身很長 | 主幹鏈被納入時也受截斷 |
| 重複勾選同分支 | 去重 |

---

## 主題 5：分支入口管理與 wiki 語義（狀態：已定稿）

### 5.1 一層分支（簡化）
- **只做一層分支**：只在主對話選文字開分支，分支內不再開分支。
- `parent_branch_id` 欄位保留但不設值（未來要再開巢狀時用）。

### 5.2 wiki 連結語義
- inline 高亮就是一個 wiki 連結：`[[分支標題|顯示文字]]`。
- **顯示文字** = 選取的文字（anchor_text），即 UI 上高亮的那段。
- **連結檔案名字** = 分支標題（branch title）＝匯出的檔案名。
- UI 上 inline 高亮只顯示「顯示文字」，不顯示檔案名。
- **標題編輯只在右側邊欄**（分支面板）進行，避免從文章裡的連結改檔名造成混淆。

### 5.3 inline 高亮右鍵選單
| 項目 | 行為 |
|---|---|
| 修改高亮範圍 | 重新選文字 → 更新 anchor_start/end/text |
| 移到底部 | 轉成底部入口（清空 anchor，設 attach_root_id） |
| 複製文字 | 複製 anchor_text |
| 刪除分支串 | 刪除該分支全部訊息 |

### 5.4 底部入口右鍵選單
| 項目 | 行為 |
|---|---|
| 選取文章文字 → 作為新入口 | 選文字升為 inline；**選到已有高亮 → 駁回** |
| 複製文字 | 複製入口文字 |
| 刪除分支串 | 刪除該分支全部訊息 |

### 5.5 對應後端操作
- `PATCH /branches/{id}`：改標題、改錨點範圍、inline↔底部轉換。
- `DELETE /branches/{id}`：刪整條分支串。
