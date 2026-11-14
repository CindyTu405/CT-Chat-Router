import { useEffect } from 'react';
import { X } from 'lucide-react';

// (G2-10) 連結 OpenRouter 結果的橫幅：固定在畫面上方置中（position: fixed，不佔版面，聊天排版不位移）
// notice：{ tone: 'ok' | 'error', text }；8 秒後自動關閉，也可按 ✕ 關閉
// onClose 必須是穩定的函式（AuthGate 用 useCallback），否則計時器會每次重新計算
const AUTO_HIDE_MS = 8000;

export default function OpenRouterNotice({ notice, onClose }) {
  useEffect(() => {
    const timer = setTimeout(onClose, AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [notice, onClose]);

  // 成功用綠色、錯誤用琥珀色
  const toneClass = notice.tone === 'ok'
    ? 'bg-green-50 border-green-200 text-green-800'
    : 'bg-amber-50 border-amber-200 text-amber-800';

  return (
    // 寬度：手機兩側各留 1rem；桌面最寬 28rem。頂端加上安全區，避免被瀏覽器工具列或瀏海蓋住
    <div className="fixed top-[max(0.75rem,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-[90] w-[calc(100%-2rem)] max-w-md">
      <div
        role="status"
        className={`flex items-start gap-2 pl-4 pr-1 py-1.5 rounded-xl border shadow-md text-sm ${toneClass}`}
      >
        {/* 文字換行顯示，不截斷 */}
        <p className="flex-1 min-w-0 py-1.5 whitespace-normal break-words">{notice.text}</p>
        {/* 觸控目標 44px；負 margin 讓它不會把整條橫幅撐高 */}
        <button
          type="button"
          onClick={onClose}
          aria-label="關閉"
          className="-my-1.5 flex-shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-black/5 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7DB9DE]"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
