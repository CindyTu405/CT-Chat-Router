// 統一的 API 呼叫層：自動帶上後端網址與登入 cookie，401 時通知 App 顯示登入頁
export const API_URL = import.meta.env.VITE_API_URL;

export async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, { ...options, credentials: 'include' });
  if (res.status === 401) window.dispatchEvent(new Event('auth:unauthorized'));
  return res;
}
