import { X } from 'lucide-react';

// (E4) 分支列表：覆蓋整個分支面板（absolute inset-0，含面板標題列）的滿版清單。
// 內容 = 目前主對話的分支（inline 與底部入口依位置排序）；E5 會在下方加「幽靈分支」區（結構已預留：區塊都在同一個捲動容器內，依序 append）。
// props:
//   branches   目前對話的分支清單（GET /chats/{root}/branches 的原始資料）
//   messages   主對話的訊息陣列（用來決定分支錨點在第幾則，排序用）
//   onSelect(branch)  點一項：由父層關閉清單、開啟分支、捲動主對話
//   onClose()         左上角 X 關閉清單

// 覆蓋層背景：不透明白底，蓋住面板內容
const OVERLAY_BG_CLASS = 'bg-white';
// 覆蓋層標題列：與面板標題列同高同色，讓切換時視覺連續
const OVERLAY_HEADER_CLASS = 'flex items-center gap-2 px-4 py-3 border-b border-gray-200 bg-white/70 backdrop-blur-sm';
// 清單項目：內距（px-4 左右、py-2.5 上下）、分隔線、hover 底色
const OVERLAY_ITEM_CLASS = 'block w-full min-w-0 text-left px-4 py-2.5 border-b border-gray-100 hover:bg-[#51A8DD]/10 transition cursor-pointer';
// 項目標題：單行截斷
const ITEM_TITLE_CLASS = 'block truncate text-sm font-medium text-gray-700';
// 項目副標（所選文字前一小段）：灰色小字、單行截斷、與標題的間距
const ITEM_SNIPPET_CLASS = 'block truncate text-xs text-gray-400 mt-0.5';
// 空狀態文字
const EMPTY_TEXT_CLASS = 'px-4 py-6 text-center text-xs text-gray-400';
// 副標取前幾個字
const SNIPPET_LENGTH = 40;

// (E4) 排序鍵 (訊息在主對話的 index, precise ? 0 : 1, precise ? anchor_start : created_at)。
// 錨點不在目前 messages 裡（或沒有錨點）→ 視為排在最後。純函式，回傳新陣列，不改動輸入。
export function sortBranchesByPosition(branches, messages) {
  const list = messages || [];
  const indexById = new Map(list.map((m, i) => [m.id, i]));
  const messageIndex = (b) => (indexById.has(b.anchor_message_id) ? indexById.get(b.anchor_message_id) : list.length);

  return [...(branches || [])].sort((a, b) => {
    const ia = messageIndex(a);
    const ib = messageIndex(b);
    if (ia !== ib) return ia - ib;

    const pa = a.precise ? 0 : 1;
    const pb = b.precise ? 0 : 1;
    if (pa !== pb) return pa - pb;

    if (a.precise) return (a.anchor_start ?? 0) - (b.anchor_start ?? 0);
    // 底部入口：created_at 為 ISO 字串，字串比較即時間順序（與 MessageList 的入口排序一致）
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    return 0;
  });
}

function snippetOf(text) {
  if (!text) return '';
  const chars = Array.from(text);
  return chars.length > SNIPPET_LENGTH ? `${chars.slice(0, SNIPPET_LENGTH).join('')}…` : text;
}

function BranchListOverlay({ branches, messages, onSelect, onClose }) {
  const sorted = sortBranchesByPosition(branches, messages);

  return (
    <div role="dialog" aria-label="分支列表" className={`absolute inset-0 z-20 flex flex-col ${OVERLAY_BG_CLASS}`}>
      {/* --- 標題列：左上角 X 關閉 --- */}
      <div className={OVERLAY_HEADER_CLASS}>
        <button
          type="button"
          onClick={onClose}
          title="關閉分支列表"
          aria-label="關閉分支列表"
          className="p-1.5 text-gray-400 hover:text-[#51A8DD] hover:bg-gray-100 rounded-lg transition cursor-pointer flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
        <p className="text-sm font-semibold text-gray-700 leading-tight">分支列表</p>
      </div>

      {/* --- 清單本體（可捲動） --- */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {sorted.length === 0 && <p className={EMPTY_TEXT_CLASS}>目前對話還沒有分支</p>}
        {sorted.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onSelect(b)}
            className={OVERLAY_ITEM_CLASS}
          >
            <span className={ITEM_TITLE_CLASS}>{b.title || '新分支'}</span>
            {b.anchor_text && <span className={ITEM_SNIPPET_CLASS}>{snippetOf(b.anchor_text)}</span>}
          </button>
        ))}
        {/* E5：幽靈分支區接在這裡（同一個捲動容器內，依序 append） */}
      </div>
    </div>
  );
}

export default BranchListOverlay;
