// 第 3–6 條：額度被擋、重新生成、分支送訊息、回覆未到就切換對話（API 全部由 mockApi 假造）
import { test, expect } from '@playwright/test';
import {
  mockApi,
  expectNoUnhandled,
  chatReply,
  rootsOf,
  branchOf,
  CHAT_A_HISTORY,
  CHAT_A_AI_TEXT,
  CHAT_B_HISTORY,
} from './mockApi';
import { mainInput, sendButton, branchInput, branchSendButton, messageList, sidebarChat } from './locators';

test('額度用完時還原輸入', async ({ page }) => {
  const api = await mockApi(page, {
    'POST /chat': { status: 429, json: { detail: { code: 'daily_quota_exceeded' } } },
  });

  // 對話框要在送出前註冊：記下文字並按確定
  const dialogs = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept();
  });

  // 訪客身分（預設 mock 的 /auth/me）
  await page.goto('/');
  await expect(mainInput(page)).toBeVisible();

  await mainInput(page).fill('會被擋下的訊息');
  await sendButton(page).click();

  await expect.poll(() => dialogs).toEqual(['今日試用額度已用完。登入並連結 OpenRouter 就能繼續使用']);
  // 輸入框還原成剛才輸入的文字
  await expect(mainInput(page)).toHaveValue('會被擋下的訊息');
  // 訊息區沒有剛送出的 user 泡泡（先確認訊息區存在，避免空定位器假通過）
  await expect(messageList(page)).toBeVisible();
  await expect(messageList(page).getByText('會被擋下的訊息', { exact: true })).toHaveCount(0);

  expectNoUnhandled(api);
});

test('載入對話並重新生成', async ({ page }) => {
  const api = await mockApi(page, {
    'GET /chats/roots': { status: 200, json: rootsOf(CHAT_A_HISTORY) },
    'GET /chats/a-u1/history': { status: 200, json: CHAT_A_HISTORY },
    'GET /chats/a-u1/branches': { status: 200, json: [] },
    'POST /messages/a-ai1/regenerate': {
      status: 200,
      headers: { 'X-Orphaned-Branch-Ids': '' },
      body: '重新生成後的新回答',
    },
  });

  await page.goto('/');
  await sidebarChat(page, '甲對話').click();

  await expect(messageList(page).getByText('甲對話的問題', { exact: true })).toBeVisible();
  await expect(messageList(page).getByText(CHAT_A_AI_TEXT, { exact: true })).toBeVisible();

  // 只有最後一則 AI 回覆有「重新生成」按鈕（功能列常態顯示，不需先 hover）
  await page.getByRole('button', { name: '重新生成' }).click();

  await expect(messageList(page).getByText('重新生成後的新回答', { exact: true })).toBeVisible();
  await expect(messageList(page).getByText(CHAT_A_AI_TEXT, { exact: true })).toHaveCount(0);

  // 請求本文帶 model，且不帶 content（只有編輯時才會帶）
  const post = api.calls.find((c) => c.key === 'POST /messages/a-ai1/regenerate');
  expect(post.body.model).toBe('gemini-2.5-flash-lite');
  expect(post.body).not.toHaveProperty('content');

  expectNoUnhandled(api);
});

test('在分支面板送訊息', async ({ page }) => {
  const api = await mockApi(page, {
    'GET /chats/roots': { status: 200, json: rootsOf(CHAT_A_HISTORY) },
    'GET /chats/a-u1/history': { status: 200, json: CHAT_A_HISTORY },
    'GET /chats/a-u1/branches': { status: 200, json: [branchOf()] },
    'POST /chat': chatReply({ text: '分支裡的假回覆', messageId: 'br-ai1', userMessageId: 'br-u1' }),
  });

  await page.goto('/');
  await sidebarChat(page, '甲對話').click();

  // 點 AI 回覆裡的錨點高亮（inline mark）。底部入口只給 precise === false 的分支，這條分支沒有，所以用 inline
  await messageList(page).getByTitle('開啟分支：重點片語').click();

  // 分支尚無訊息：輸入框已帶入錨點文字
  await expect(branchInput(page)).toHaveValue('重點片語');
  await branchSendButton(page).click();

  await expect(page.getByText('分支裡的假回覆', { exact: true })).toBeVisible();

  const post = api.calls.filter((c) => c.key === 'POST /chat')[0];
  expect(post.body).toEqual({
    message: '重點片語',
    model: 'gemini-2.5-flash-lite',
    parent_id: 'a-ai1',
    branch_id: 'br-1',
  });

  expectNoUnhandled(api);
});

test('回覆未到就切換對話', async ({ page }) => {
  const api = await mockApi(page, {
    'GET /chats/roots': { status: 200, json: rootsOf(CHAT_A_HISTORY, CHAT_B_HISTORY) },
    'GET /chats/a-u1/history': { status: 200, json: CHAT_A_HISTORY },
    'GET /chats/a-u1/branches': { status: 200, json: [] },
    'GET /chats/b-u1/history': { status: 200, json: CHAT_B_HISTORY },
    'GET /chats/b-u1/branches': { status: 200, json: [] },
    // 回應延遲 1.5 秒，讓切換發生在回應到達之前
    'POST /chat': {
      ...chatReply({ text: '遲到的假回覆', messageId: 'a-ai2', userMessageId: 'a-u2' }),
      delayMs: 1500,
    },
  });

  await page.goto('/');
  await sidebarChat(page, '甲對話').click();
  await expect(messageList(page).getByText(CHAT_A_AI_TEXT, { exact: true })).toBeVisible();

  await mainInput(page).fill('切換前送出的訊息');
  // 先掛好等待，確保不會錯過延遲的回應
  const responsePromise = page.waitForResponse((r) => r.url().endsWith('/__api/chat'));
  await sendButton(page).click();
  await sidebarChat(page, '乙對話').click();

  await expect(messageList(page).getByText('乙對話的回答', { exact: true })).toBeVisible();

  // 等延遲的回應真的送達，再讓 React 把狀態更新刷完
  await responsePromise;
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  await expect(messageList(page).getByText('遲到的假回覆', { exact: true })).toHaveCount(0);
  await expect(messageList(page).getByText('切換前送出的訊息', { exact: true })).toHaveCount(0);
  await expect(messageList(page).getByText('乙對話的回答', { exact: true })).toBeVisible();

  expectNoUnhandled(api);
});
