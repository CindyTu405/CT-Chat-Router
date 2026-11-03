import { useEffect, useRef, useState } from 'react';
import { handleEnterKey } from '../keyUtils';

// (F9-2) 編輯框自動長高的上限行數（可調；對齊 G9 摺疊行數）。超過就在框內捲動。
const EDITOR_MAX_LINES = 10;
// (F9-2) 量不到 line-height（值為 normal）時的備用行高（px）
const FALLBACK_LINE_HEIGHT = 24;

// (F9-2) 最後一則 user 訊息的內嵌編輯框：原地取代泡泡，textarea 本身就是框。
// props:
//   original      原文（預填；也是「內容沒改就停用送出」的比對基準）
//   branchCount   這則 user 之後那則 AI 回覆上的分支數（> 0 才顯示紅色警語；含空分支）
//   onSubmit(text)  送出（父層負責關編輯框與呼叫 API）
//   onCancel()      取消（Esc 或按「取消」）
export default function UserMessageEditor({ original, branchCount, onSubmit, onCancel }) {
  const [text, setText] = useState(original);
  const textareaRef = useRef(null);

  // 送出條件：trim 後不是空字串，而且與原文不同（沒改就送出等於重傳，那是 G6 重傳鈕的工作）
  const canSubmit = text.trim() !== '' && text !== original;

  // 開啟時自動聚焦，游標放在文字結尾
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // 自動長高：先設 auto 量 scrollHeight，再設成內容高度；超過上限（10 行＋上下內距）就固定在上限、框內捲動
  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const style = getComputedStyle(el);
    let lineHeight = parseFloat(style.lineHeight);
    if (Number.isNaN(lineHeight)) lineHeight = FALLBACK_LINE_HEIGHT;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const maxH = lineHeight * EDITOR_MAX_LINES + (Number.isNaN(padding) ? 0 : padding);
    const fullH = el.scrollHeight;
    el.style.height = `${Math.min(fullH, maxH)}px`;
    el.style.overflowY = fullH > maxH ? 'auto' : 'hidden';
  };

  // 內容變動時重算；視窗寬度改變會影響折行數，也要重算
  useEffect(() => {
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Esc → 取消；其餘按鍵交給 handleEnterKey（桌面 Enter 送出、Shift+Enter 換行；手機 Enter 換行）
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    handleEnterKey(e, () => {
      if (canSubmit) onSubmit(text);
    });
  };

  return (
    // (F9-2) 整個編輯區撐滿 user 欄（父層已給 w-full）
    <div className="w-full">
      {/* (F9-2) 編輯框：白底、主題藍邊框、右上角直角（與 user 泡泡同一個形狀）。
          顏色與圓角可調：border-[#51A8DD]／rounded-2xl rounded-tr-none／focus:ring-[#51A8DD]/40 */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        aria-label="編輯訊息"
        className="w-full bg-white text-gray-800 text-[15px] leading-relaxed px-5 py-3.5 rounded-2xl rounded-tr-none border border-[#51A8DD] shadow-md focus:outline-none focus:ring-2 focus:ring-[#51A8DD]/40 resize-none"
      />

      {/* (F9-2) 分支警語：只在這則 AI 回覆上有分支時出現；N 由 MessageList 算好傳入 */}
      {branchCount > 0 && (
        <p className="mt-1.5 text-xs text-red-500 text-right">
          此回覆上有 {branchCount} 個分支，重新生成後會變成幽靈分支
        </p>
      )}

      {/* (F9-2) 右對齊的按鈕列：取消（灰色外框）、送出（主題藍；沒改或空白時停用） */}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3.5 py-1.5 rounded-lg text-sm text-gray-600 border border-gray-300 hover:bg-gray-100 transition cursor-pointer"
        >
          取消
        </button>
        {/* (F9-2) 送出顏色可調：bg-[#51A8DD]；停用透明度 disabled:opacity-40 */}
        <button
          type="button"
          onClick={() => canSubmit && onSubmit(text)}
          disabled={!canSubmit}
          className="px-3.5 py-1.5 rounded-lg text-sm font-medium text-white bg-[#51A8DD] hover:bg-[#3D9AD1] transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          送出
        </button>
      </div>
    </div>
  );
}
