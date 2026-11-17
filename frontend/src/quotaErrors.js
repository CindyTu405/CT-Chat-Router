// (R-1) 從 App.jsx 搬出：後端拒絕請求（額度、限流、輸入太長、OpenRouter 連結失效）時的錯誤與文案；純函式，不含 React
// (V1-2) 後端在送出前就拒絕（額度用完／太頻繁）時丟出；後端沒寫入 DB，畫面要還原到送出前的狀態
export class QuotaError extends Error {}

// (B13) 與後端輸入上限一致
export const MAX_MESSAGE_CHARS = 20000;
export const MAX_TITLE_CHARS = 200;
export const MAX_ANCHOR_TEXT_CHARS = 5000;
export const TOO_LONG_MSG = "內容太長，上限 20,000 字";

// 429 / 503 時依 detail.code 轉成 QuotaError；其他回應不做任何事
// (G2-6) user：目前登入者（訪客 is_guest 為 true），用來決定每日額度用完時的文案
export async function throwIfQuotaError(response, user) {
  // (B13) 安全網：後端 pydantic 驗證失敗（detail 為陣列，例如內容超長）→ 走同一條還原路徑
  if (response.status === 422) {
    let detail = null;
    try { detail = (await response.json())?.detail; } catch { /* ignore */ }
    if (Array.isArray(detail)) throw new QuotaError(TOO_LONG_MSG);
    return;
  }
  // (G2-10) 409 只處理 openrouter_reconnect_required，其他 409 維持原本行為（不擋）
  if (response.status !== 429 && response.status !== 503 && response.status !== 409) return;
  let code = null;
  try {
    const body = await response.json();
    code = body?.detail?.code ?? null;
  } catch { /* 忽略解析錯誤（例如 rate limiter 回的是 {"error": ...}） */ }

  // (G2-10) 自己的 OpenRouter 金鑰被拒（已被後端移除連結）：文字放回輸入框；呼叫端會在結束後重新讀取 /auth/me
  if (response.status === 409 && code === 'openrouter_reconnect_required') {
    throw new QuotaError("OpenRouter 連結已失效，請重新連結");
  }
  // (G2-6) 同一 IP 的訪客名額用完：要先於通用 429 判斷
  if (response.status === 429 && code === 'guest_ip_limit') {
    throw new QuotaError("這個網路今天的試用額度已滿，請登入後使用");
  }
  // (G2-6) 訪客每日額度用完：引導登入並連結 OpenRouter
  if (response.status === 429 && code === 'daily_quota_exceeded' && user?.is_guest) {
    throw new QuotaError("今日試用額度已用完。登入並連結 OpenRouter 就能繼續使用");
  }
  // (G2-10) 已登入但未連結 OpenRouter：引導連結即可不限則數
  if (response.status === 429 && code === 'daily_quota_exceeded' && !user?.openrouter_connected) {
    throw new QuotaError("今日試用額度已用完。連結 OpenRouter 就能不限則數");
  }
  if (response.status === 429 && code === 'daily_quota_exceeded') {
    throw new QuotaError("今日額度已用完，將於台灣時間 00:00 重置");
  }
  if (response.status === 429) {
    throw new QuotaError("傳送太頻繁，請稍後再試");
  }
  if (response.status === 503 && code === 'site_quota_exceeded') {
    throw new QuotaError("今日服務額度已滿，請明天再試");
  }
}
