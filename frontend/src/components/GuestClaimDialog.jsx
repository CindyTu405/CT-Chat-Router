import { useState } from 'react';
import { apiFetch } from '../api';

// (G2-7) 訪客對話搬移對話框：登入後若有試用時建立的對話，讓使用者選擇「移到帳號」或「刪除」。
// 不能用點背景或 Escape 關閉，一定要做出選擇。
// 請求只帶 action，不帶任何對話 id（後端依瀏覽器持有的訪客 token 判斷要搬哪些資料）。
export default function GuestClaimDialog({ chatCount, onDone }) {
  // step：'ask' 詢問；'confirmDiscard' 刪除前再確認一次
  const [step, setStep] = useState('ask');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (action) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/auth/guest-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      // 409 no_pending_claim 代表已經沒有待處理的搬移，視同完成
      if (res.ok || res.status === 409) {
        await onDone();
        // 成功後父層會卸載此對話框，這裡直接返回，不再設定狀態
        return;
      }
      setError('處理失敗，請再試一次。');
    } catch {
      setError('處理失敗，請再試一次。');
    } finally {
      setBusy(false);
    }
  };

  const primaryBtn =
    'min-h-[44px] rounded-xl font-semibold px-4 w-full transition disabled:opacity-60 disabled:cursor-default';
  const secondaryBtn =
    'min-h-[44px] rounded-xl font-semibold px-4 w-full border border-gray-300 text-gray-700 hover:bg-gray-50 transition disabled:opacity-60 disabled:cursor-default';

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-claim-title"
        className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6 animate-fade-zoom-in"
      >
        {step === 'ask' ? (
          <>
            <h2 id="guest-claim-title" className="text-lg font-semibold text-gray-800">
              要保留試用時的對話嗎？
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              你在登入前建立了 {chatCount} 個對話。要把它們移到這個帳號嗎？
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
                onClick={() => submit('merge')}
                className={`${primaryBtn} bg-[#51A8DD] hover:bg-[#3d97cf] text-white`}
              >
                移到帳號
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep('confirmDiscard');
                }}
                className={secondaryBtn}
              >
                刪除
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="guest-claim-title" className="text-lg font-semibold text-gray-800">
              確定刪除試用對話？
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              這 {chatCount} 個對話會永久刪除，無法復原。
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
                onClick={() => submit('discard')}
                className={`${primaryBtn} bg-red-600 hover:bg-red-700 text-white`}
              >
                確定刪除
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep('ask');
                }}
                className={secondaryBtn}
              >
                返回
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
