// (R-4) 讀取後端的文字串流：五處（主對話送出／重新生成／續讀、分支送出／重新生成）共用。
// shouldStop：選填，回傳 true 就停止讀取並取消串流（主對話用來判斷「使用者已切到別的對話」；分支不傳）。
//   讀之前、讀之後各檢查一次（讀取是非同步的，回來時畫面可能已經切換）。
// onText：每收到一段就以「目前累積的全文」呼叫一次。
// 回傳 { finished, text }：finished 為 true 代表串流完整讀完（沒有被 shouldStop 中斷）。
// 讀取中發生的錯誤照樣往外丟，由呼叫端的 catch 處理。
export async function readTextStream(response, { shouldStop, onText } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const stop = async () => {
    try { await reader.cancel(); } catch { /* ignore */ }
    return { finished: false, text };
  };
  while (true) {
    if (shouldStop?.()) return stop();
    const { done, value } = await reader.read();
    if (done) return { finished: true, text };
    if (shouldStop?.()) return stop();
    text += decoder.decode(value, { stream: true });
    onText?.(text);
  }
}
