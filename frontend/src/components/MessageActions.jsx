import { useEffect, useRef, useState } from 'react';
import { Copy, Check, RefreshCw, Pencil } from 'lucide-react';
import { copyText } from '../clipboard';

// (G8) 訊息功能清單：每個功能一筆資料。功能列（MessageActions）與手機長按選單（MessageActionMenu）共用這張清單，
// 加功能只改這裡，兩邊同時出現。
// (G6-2) 第二參數 onRetry：只有傳入時才會多出「重新生成」功能（放在複製的右邊）。
//        run() 回傳 false → 不顯示 ✓ 回饋（重新生成是開始串流，不是完成動作）。
// (F9-2) 第二參數 onEdit：只有傳入時才會多出「編輯」功能（複製的右邊、重新生成的左邊）。
//        run() 呼叫 onEdit(msg) 後回傳 false → 不顯示 ✓ 回饋（編輯是開啟編輯框，不是完成動作）；
//        手機選單看到 false 會關閉選單，正好符合「點編輯 → 關選單、開編輯框」。
const buildMessageActions = (msg, { onRetry, onEdit } = {}) => [
  { id: 'copy', label: '複製', icon: Copy, run: () => copyText(msg.content) }, // 複製原始 markdown
  // (F9-2) 編輯：只有最後一則 user 訊息會傳入 onEdit（判斷在 MessageList 的 canEdit）
  ...(onEdit ? [{ id: 'edit', label: '編輯', icon: Pencil, run: () => { onEdit(msg); return false; } }] : []),
  // (G6-2) 重新生成：原地重打這則 AI 回覆（只有最後一則 AI 回覆會傳入 onRetry）
  ...(onRetry ? [{ id: 'retry', label: '重新生成', icon: RefreshCw, run: () => { onRetry(msg); return false; } }] : []),
];

// (G8) 一排小圖示按鈕。複製成功後該圖示變 ✓ 約 2 秒。
// className 會接在基本排列 class 之後；預設 'flex'。傳入 className 會取代預設值，所以要顯示時請自行帶上 flex（例如 hidden md:flex）。
// (G6-2) onRetry 可選：傳入才顯示「重新生成」按鈕（見 buildMessageActions）。
// (F9-2) onEdit 可選：傳入才顯示「編輯」按鈕，呼叫 onEdit(msg)（見 buildMessageActions）。
export function MessageActions({ msg, className = 'flex', onRetry, onEdit }) {
  const actions = buildMessageActions(msg, { onRetry, onEdit });
  const [doneId, setDoneId] = useState(null); // 剛成功執行的功能 id
  const timerRef = useRef(null);

  // 卸載時清掉計時器，避免對已卸載的元件 setState
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleClick = async (action) => {
    const ok = await action.run(); // (G6-2) run 可能回傳非 Promise 的 false，await 一樣能正確取值
    if (!ok) return;
    setDoneId(action.id);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDoneId(null), 2000);
  };

  return (
    <div className={`items-center gap-1 ${className}`}>
      {actions.map((action) => {
        const Icon = doneId === action.id ? Check : action.icon;
        return (
          <button
            key={action.id}
            type="button"
            title={action.label}
            aria-label={action.label}
            onClick={() => handleClick(action)}
            className="p-1 rounded-md text-gray-400 hover:text-[#51A8DD] hover:bg-gray-100 transition cursor-pointer"
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}
    </div>
  );
}

const MENU_WIDTH = 176; // 對應 w-44
const MENU_ITEM_HEIGHT = 42; // 單列高度估計值（py-2.5 + text-sm），用來判斷上方放不放得下
const EDGE = 8; // 離視窗邊緣至少 8px

// (G8) 手機 user 氣泡長按後跳出的浮動選單：位於氣泡上方（放不下時放在下方），右緣對齊氣泡右緣。
// 點選單外面、捲動、縮放視窗時關閉；點「複製」後該列變 ✓ 已複製，約 1 秒後關閉。
// (F9-2) onEdit 可選：傳入才多出「編輯」列；點了 → 關閉選單（run 回傳 false），並由父層開啟編輯框。
export function MessageActionMenu({ msg, anchorRect, onEdit, onClose }) {
  const menuRef = useRef(null);
  const [copiedId, setCopiedId] = useState(null);
  const closeTimerRef = useRef(null);
  const actions = buildMessageActions(msg, { onEdit });

  // 點外面 / 捲動 / 視窗縮放 → 關閉
  useEffect(() => {
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target)) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // 卸載時清掉 1 秒關閉計時器
  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  const handleItem = async (action) => {
    if (copiedId) return;
    const ok = await action.run();
    if (!ok) {
      onClose();
      return;
    }
    setCopiedId(action.id);
    closeTimerRef.current = setTimeout(onClose, 1000);
  };

  // 水平：右緣對齊氣泡右緣，但限制在視窗內（左右至少 8px）
  const right = Math.min(
    Math.max(window.innerWidth - anchorRect.right, EDGE),
    window.innerWidth - MENU_WIDTH - EDGE
  );
  // 垂直：優先放在氣泡上方（底邊距氣泡頂端 8px）；上方放不下就放在氣泡下方
  const menuHeight = actions.length * MENU_ITEM_HEIGHT + 8;
  const placeAbove = anchorRect.top - EDGE - menuHeight >= EDGE;
  const style = placeAbove
    ? { right, bottom: window.innerHeight - anchorRect.top + EDGE }
    : { right, top: anchorRect.bottom + EDGE };

  return (
    <div
      ref={menuRef}
      style={style}
      className="fixed z-50 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1"
    >
      {actions.map((action) => {
        const Icon = action.icon;
        const done = copiedId === action.id;
        return (
          <button
            key={action.id}
            type="button"
            onClick={() => handleItem(action)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 active:bg-gray-100 cursor-pointer"
          >
            {done ? (
              <>
                <Check className="w-4 h-4 text-[#51A8DD]" />
                <span>已複製</span>
              </>
            ) : (
              <>
                <Icon className="w-4 h-4" />
                <span>{action.label}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
