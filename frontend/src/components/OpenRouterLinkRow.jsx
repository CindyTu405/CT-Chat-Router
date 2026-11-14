import { useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch, API_URL } from '../api';

// (G2-10) 側欄帳號區下方的 OpenRouter 列（只給已登入、非訪客使用；訪客不渲染此元件）
// connected：user.openrouter_connected；onUserChanged：重新讀取 /auth/me
export default function OpenRouterLinkRow({ connected, onUserChanged }) {
  // 中斷連結的確認對話框與進行中狀態
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // 中斷連結：DELETE /auth/openrouter，200 才重新讀取 /auth/me；失敗留在對話框內提示
  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/auth/openrouter', { method: 'DELETE' });
      if (res.ok) {
        setConfirming(false);
        await onUserChanged();
        return;
      }
      setError('中斷連結失敗，請再試一次');
    } catch {
      setError('中斷連結失敗，請再試一次');
    } finally {
      setBusy(false);
    }
  };

  const secondaryLinkClass =
    'flex items-center justify-center w-full min-h-[44px] px-3 py-2 text-sm font-semibold text-[#228DCD] bg-white/80 hover:bg-white border border-[#7DB9DE] rounded-xl transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7DB9DE]';

  return (
    <div className="mt-2">
      {connected ? (
        <div className="flex items-center gap-2 min-h-[44px]">
          <span className="flex-1 min-w-0 text-sm text-gray-700">已連結 OpenRouter</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            className="flex-shrink-0 min-h-[44px] px-3 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-white/80 rounded-lg cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7DB9DE]"
          >
            中斷連結
          </button>
        </div>
      ) : (
        <>
          <a href={`${API_URL}/auth/openrouter/connect`} className={secondaryLinkClass}>
            連結 OpenRouter
          </a>
          {/* 說明文字換行顯示，不截斷 */}
          <p className="mt-1 text-xs text-gray-500 whitespace-normal break-words">
            連結後不限則數，可用任何模型，費用由你的 OpenRouter 帳號支付
          </p>
        </>
      )}

      {confirming && createPortal(
        // 用 Portal 掛到 body，避免手機版側欄（fixed 全螢幕、有自己的 z-index）把對話框困在裡面
        <div className="fixed inset-0 z-[105] flex items-center justify-center p-4 bg-black/40">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="openrouter-disconnect-title"
            className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6 animate-fade-zoom-in"
          >
            <h2 id="openrouter-disconnect-title" className="text-lg font-semibold text-gray-800">
              中斷 OpenRouter 連結？
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              中斷後會回到每日 10 則、只能用免費模型。已儲存的金鑰會從本站刪除。
            </p>
            {error && (
              <p role="alert" className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-center">
                {error}
              </p>
            )}
            <div className="mt-6 flex flex-col gap-2">
              <button
                type="button"
                autoFocus
                disabled={busy}
                onClick={disconnect}
                className="min-h-[44px] rounded-xl font-semibold px-4 w-full transition disabled:opacity-60 disabled:cursor-default bg-red-600 hover:bg-red-700 text-white"
              >
                中斷連結
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="min-h-[44px] rounded-xl font-semibold px-4 w-full border border-gray-300 text-gray-700 hover:bg-gray-50 transition disabled:opacity-60 disabled:cursor-default"
              >
                取消
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
