// 假後端：用 page.route 攔截 /__api/** 的所有請求，回傳測試指定的假資料
import { expect } from '@playwright/test';

const API_PREFIX = '/__api';

// 模型選項（與後端 GET /api/model-options 同形狀）
const MODEL_PRESETS = [{ value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' }];
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

// ---------- 資料建構器 ----------

// 訪客使用者（試用中、未連結 OpenRouter、沒有待搬移的對話）
export function guestUser(overrides = {}) {
  return {
    id: 'guest-1',
    email: null,
    name: '訪客',
    provider: null,
    is_guest: true,
    openrouter_connected: false,
    guest_claim: null,
    ...overrides,
  };
}

// 假的串流回覆：整段文字一次送完，X-Message-Id / X-User-Message-Id 與後端相同
export function chatReply({ text, messageId, userMessageId }) {
  return {
    status: 200,
    headers: {
      'X-Message-Id': messageId,
      'X-User-Message-Id': userMessageId,
    },
    body: text,
  };
}

// 模型選項（預設 gemini-2.5-flash-lite，不允許自訂）
export function modelOptions(overrides = {}) {
  return {
    presets: MODEL_PRESETS,
    default_model: DEFAULT_MODEL,
    allow_custom: false,
    ...overrides,
  };
}

// ---------- 攔截器 ----------

// 沒有測試覆寫時使用的預設回應
function defaultHandlers() {
  return {
    'GET /auth/me': { status: 200, json: guestUser() },
    'GET /api/model-options': { status: 200, json: modelOptions() },
    'GET /api/free-models': { status: 200, json: { models: [] } },
    'GET /chats/roots': { status: 200, json: [] },
  };
}

// 依 key 找處理器：完全相符優先，其次最長的 * 前綴
function findHandler(handlers, key) {
  if (Object.prototype.hasOwnProperty.call(handlers, key)) return handlers[key];
  let best = null;
  for (const pattern of Object.keys(handlers)) {
    if (!pattern.endsWith('*')) continue;
    const prefix = pattern.slice(0, -1);
    if (key.startsWith(prefix) && (best === null || prefix.length > best.length - 1)) {
      best = pattern;
    }
  }
  return best === null ? undefined : handlers[best];
}

// 解析請求本文：JSON 優先，否則回傳原始文字，沒有本文則 null
function parseBody(request) {
  const raw = request.postData();
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return request.postDataJSON();
  } catch {
    return raw;
  }
}

// 把處理器的結果轉成 route.fulfill 的參數
function toFulfillOptions(spec) {
  const status = spec.status ?? 200;
  if (spec.json !== undefined) {
    return {
      status,
      headers: spec.headers,
      contentType: 'application/json',
      body: JSON.stringify(spec.json),
    };
  }
  return {
    status,
    headers: spec.headers,
    contentType: 'text/plain; charset=utf-8',
    body: spec.body ?? '',
  };
}

// 註冊唯一的 /__api/** 攔截器。回傳 { calls, unhandled }
export async function mockApi(page, handlers = {}) {
  const merged = { ...defaultHandlers(), ...handlers };
  const calls = [];
  const unhandled = [];

  await page.route('**/__api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.startsWith(API_PREFIX)
      ? url.pathname.slice(API_PREFIX.length)
      : url.pathname;
    const method = request.method();
    const key = `${method} ${path}`;
    const body = parseBody(request);

    calls.push({ method, path, key, body });
    const ctx = { method, path, key, body, calls };

    const handler = findHandler(merged, key);
    if (handler === undefined) {
      unhandled.push(key);
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: `e2e: no handler for ${key}` }),
      });
      return;
    }

    const spec = typeof handler === 'function' ? await handler(request, ctx) : handler;
    if (spec.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
    }
    await route.fulfill(toFulfillOptions(spec));
  });

  return { calls, unhandled };
}

// 測試結束時呼叫：有任何沒被定義的 API 請求就失敗，並列出 key
export function expectNoUnhandled(api) {
  expect(api.unhandled, '有 API 請求沒有對應的假處理器（unhandled）').toEqual([]);
}
