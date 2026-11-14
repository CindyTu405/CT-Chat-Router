import { useCallback, useEffect, useState } from 'react';
import { FcGoogle } from 'react-icons/fc';
import { FaGithub } from 'react-icons/fa';
import App from '../App';
// (L1-3) 未登入的首頁
import LandingPage from './LandingPage';
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

// (G2-6) notice：從首頁試用失敗等情況帶進來的提示（琥珀色框）；backLabel：返回按鈕文字（聊天中的登入頁用「← 返回」）
function LoginPage({ onBack, notice = null, backLabel = '← 回首頁' }) {
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
        <img src="/favicon.svg" alt="" aria-hidden="true" className="w-12 h-12" />
        <h1 className="text-lg font-semibold text-gray-700">登入</h1>
        {errorMessage && (
          <p role="alert" className="w-full text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-center">
            {errorMessage}
          </p>
        )}
        {/* (G2-6) 試用失敗等提示：琥珀色，和紅色的 auth_error 區分開 */}
        {notice && (
          <p role="status" className="w-full text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-center">
            {notice}
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
        {/* (L1-3) 回首頁：回到未登入的首頁展示 */}
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2 cursor-pointer"
        >
          {backLabel}
        </button>
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
  // (L1-3) 未登入時顯示首頁（landing）或登入頁（login）；網址帶 auth_error 時直接進登入頁。
  // 用惰性初始化在 LoginPage 移除參數之前讀取
  const [view, setView] = useState(() =>
    new URLSearchParams(window.location.search).has('auth_error') ? 'login' : 'landing'
  );
  // (G2-6) 「開始使用」進行中（按鈕停用，避免重複發起試用請求）
  const [starting, setStarting] = useState(false);
  // (G2-6) 登入頁上方的提示文字（試用失敗時設定；返回首頁時清掉）
  const [loginNotice, setLoginNotice] = useState(null);

  // (G2-6) 重新讀取 /auth/me：成功＝使用者資料，非 200 或網路錯誤＝視為未登入
  const refreshUser = useCallback(async () => {
    try {
      const res = await apiFetch('/auth/me');
      const data = res.ok ? await res.json() : null;
      setUser(data);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      // (G2-6) 失效後回首頁（不是登入頁）
      setView('landing');
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    refreshUser();

    return () => {
      window.removeEventListener('auth:unauthorized', onUnauthorized);
    };
  }, [refreshUser]);

  // (G2-6) 首頁「開始使用」：按下才發試用請求（首頁本身不發請求）；成功後重新讀取 /auth/me 進入聊天
  const startGuest = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const res = await apiFetch('/auth/guest', { method: 'POST' });
      if (res.ok) {
        await refreshUser();
      } else if (res.status === 429) {
        // 這個網路的訪客名額用完：帶提示進登入頁
        setLoginNotice('這個網路今天的試用名額已滿，請登入後使用。');
        setView('login');
      } else {
        setLoginNotice('目前無法開始試用，請稍後再試，或直接登入。');
        setView('login');
      }
    } catch {
      setLoginNotice('目前無法開始試用，請稍後再試，或直接登入。');
      setView('login');
    } finally {
      setStarting(false);
    }
  };

  if (user === undefined) {
    return <div className="h-screen supports-[height:100dvh]:h-dvh bg-[#E8F1F5]" />;
  }
  if (user === null) {
    return view === 'login' ? (
      <LoginPage
        notice={loginNotice}
        onBack={() => {
          setLoginNotice(null);
          setView('landing');
        }}
      />
    ) : (
      <LandingPage onStart={startGuest} onLogin={() => setView('login')} starting={starting} />
    );
  }
  // (G2-6) 訪客在聊天中按「登入」：登入頁以覆蓋層顯示，App 保持掛載（不遺失目前的對話）
  return (
    <>
      <App user={user} onRequestLogin={() => setView('login')} onUserChanged={refreshUser} />
      {user.is_guest && view === 'login' && (
        <div className="fixed inset-0 z-[100]">
          <LoginPage backLabel="← 返回" onBack={() => setView('landing')} />
        </div>
      )}
    </>
  );
}

export default AuthGate;
