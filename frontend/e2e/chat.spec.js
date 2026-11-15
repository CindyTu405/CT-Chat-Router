// 第 1–2 條：首頁試用進入聊天、送出兩則訊息（API 全部由 mockApi 假造）
import { test, expect } from '@playwright/test';
import { mockApi, expectNoUnhandled, guestUser, chatReply } from './mockApi';
import { mainInput, sendButton } from './locators';

test('首頁按開始使用進入聊天', async ({ page }) => {
  // 試用建立前 /auth/me 回 401（未登入）；呼叫過 POST /auth/guest 後回訪客資料
  const api = await mockApi(page, {
    'GET /auth/me': (request, ctx) =>
      ctx.calls.some((c) => c.key === 'POST /auth/guest')
        ? { status: 200, json: guestUser() }
        : { status: 401, json: { detail: 'unauthorized' } },
    'POST /auth/guest': { status: 200, json: {} },
  });

  await page.goto('/');
  // 首頁上有兩個「開始使用」（主視覺與底部列），點第一個即可
  const startButton = page.getByRole('button', { name: '開始使用' }).first();
  await expect(startButton).toBeVisible();
  await startButton.click();

  await expect(mainInput(page)).toBeVisible();
  expect(api.calls.map((c) => c.key)).toContain('POST /auth/guest');
  expectNoUnhandled(api);
});

test('送出兩則訊息', async ({ page }) => {
  const api = await mockApi(page, {
    'POST /chat': (request, ctx) =>
      ctx.calls.filter((c) => c.key === 'POST /chat').length === 1
        ? chatReply({ text: '這是假的回覆一', messageId: 'ai-1', userMessageId: 'u-1' })
        : chatReply({ text: '這是假的回覆二', messageId: 'ai-2', userMessageId: 'u-2' }),
  });

  // 以訪客身分直接進入聊天（預設 mock 的 /auth/me 就是訪客）
  await page.goto('/');
  await expect(mainInput(page)).toBeVisible();

  // 第一則
  await mainInput(page).fill('你好');
  await sendButton(page).click();
  // 側欄標題也會出現「你好」，訊息泡泡在 DOM 上較後面，取最後一個
  await expect(page.getByText('你好', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('這是假的回覆一', { exact: true })).toBeVisible();
  await expect(mainInput(page)).toHaveValue('');

  const firstPost = api.calls.filter((c) => c.key === 'POST /chat')[0];
  expect(firstPost.body).toEqual({
    message: '你好',
    model: 'gemini-2.5-flash-lite',
    parent_id: null,
  });

  // 第二則：parent_id 應為第一則回覆的 X-Message-Id
  await mainInput(page).fill('第二則');
  await sendButton(page).click();
  await expect(page.getByText('這是假的回覆二', { exact: true })).toBeVisible();

  const secondPost = api.calls.filter((c) => c.key === 'POST /chat')[1];
  expect(secondPost.body.message).toBe('第二則');
  expect(secondPost.body.parent_id).toBe('ai-1');

  expectNoUnhandled(api);
});
