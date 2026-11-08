import { useEffect, useState } from 'react';
import { FcGoogle } from 'react-icons/fc';
import { FaGithub } from 'react-icons/fa';
import App from '../App';
import { API_URL, apiFetch } from '../api';

// 後端導回時帶的 auth_error 代碼 → 固定文案；不認得的一律用通用訊息，絕不顯示原始參數
const AUTH_ERROR_MESSAGES = {
  login_failed: '登入失敗，請再試一次。',
  provider_unavailable: '這個登入方式目前無法使用，請改用另一個。',
};
const AUTH_ERROR_FALLBACK = '登入時發生問題，請再試一次。';

function readAuthError() {
  const code = new URLSearchParams(window.location.search).get('auth_error');
  if (code === null) return null;
  return Object.prototype.hasOwnProperty.call(AUTH_ERROR_MESSAGES, code)
    ? AUTH_ERROR_MESSAGES[code]
    : AUTH_ERROR_FALLBACK;
}

function LoginPage() {
  // 只在掛載時讀一次，讀完立刻把參數從網址移除（重新整理不會再出現）
  const [errorMessage] = useState(readAuthError);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('auth_error')) {
      params.delete('auth_error');
      const qs = params.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
      );
    }
  }, []);

  const buttonClass =
    'w-full min-h-[44px] flex items-center justify-center gap-3 px-4 py-2.5 bg-white border border-gray-300 hover:border-[#7DB9DE] hover:bg-[#E8F1F5] rounded-xl text-sm font-semibold text-gray-700 transition cursor-pointer shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7DB9DE]';

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh bg-[#E8F1F5] text-gray-800 font-sans flex items-center justify-center p-4">
      <div className="w-full max-w-[320px] flex flex-col items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-[#7DB9DE] to-[#7B90D2] shadow-sm" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-gray-700">登入</h1>
        {errorMessage && (
          <p role="alert" className="w-full text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-center">
            {errorMessage}
          </p>
        )}
        <a href={`${API_URL}/auth/google/login`} className={buttonClass}>
          <FcGoogle className="w-5 h-5" aria-hidden="true" />
          使用 Google 繼續
        </a>
        <a href={`${API_URL}/auth/github/login`} className={buttonClass}>
          <FaGithub className="w-5 h-5" aria-hidden="true" />
          使用 GitHub 繼續
        </a>
        <a
          href="/privacy.html"
          target="_blank"
          rel="noopener"
          className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2"
        >
          隱私權說明
        </a>
      </div>
    </div>
  );
}

// user：undefined = 檢查中、null = 未登入、object = 已登入
function AuthGate() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    const onUnauthorized = () => {
      if (!cancelled) setUser(null);
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);

    (async () => {
      try {
        const res = await apiFetch('/auth/me');
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setUser(data);
      } catch {
        if (!cancelled) setUser(null);
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    };
  }, []);

  if (user === undefined) {
    return <div className="h-screen supports-[height:100dvh]:h-dvh bg-[#E8F1F5]" />;
  }
  if (user === null) return <LoginPage />;
  return <App user={user} />;
}

export default AuthGate;
