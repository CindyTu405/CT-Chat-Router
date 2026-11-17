// 第 7–8 條：分支面板重新生成、編輯最後一則 user 訊息（API 全部由 mockApi 假造）
import { test, expect } from '@playwright/test';
import {
  mockApi,
  expectNoUnhandled,
  rootsOf,
  branchOf,
  CHAT_A_HISTORY,
  CHAT_A_AI_TEXT,
  BRANCH_BR1_HISTORY,
} from './mockApi';
import { messageList, branchMessageList, sidebarChat } from './locators';

// 按最後一則 user 的「編輯」（桌面功能列，常態顯示），把編輯框文字換成 text 後按送出
async function editLastUserMessage(page, text) {
  await messageList(page).getByRole('button', { name: '編輯', exact: true }).click();
  await messageList(page).getByRole('textbox', { name: '編輯訊息' }).fill(text);
  await messageList(page).getByRole('button', { name: '送出', exact: true }).click();
}

test('分支面板重新生成', async ({ page }) => {
  const api = await mockApi(page, {
    'GET /chats/roots': { status: 200, json: rootsOf(CHAT_A_HISTORY) },
    'GET /chats/a-u1/history': { status: 200, json: CHAT_A_HISTORY },
    'GET /chats/a-u1/branches': { status: 200, json: [branchOf({ root_message_id: 'br-u1' })] },
    'GET /chats/br-u1/history': { status: 200, json: BRANCH_BR1_HISTORY },
    'POST /messages/br-ai1/regenerate': { status: 200, body: '分支裡的新回答' },
  });

  await page.goto('/');
  await sidebarChat(page, '甲對話').click();
  await messageList(page).getByTitle('開啟分支：重點片語').click();

  // 分支面板：舊回答已載入
  await expect(branchMessageList(page).getByText('分支裡的舊回答', { exact: true })).toBeVisible();

  // 只按分支面板裡的「重新生成」（主對話最後一則 AI 也有同名按鈕，所以要限定在分支面板）
  await branchMessageList(page).getByRole('button', { name: '重新生成', exact: true }).click();

  await expect(branchMessageList(page).getByText('分支裡的新回答', { exact: true })).toBeVisible();
  await expect(branchMessageList(page).getByText('分支裡的舊回答', { exact: true })).toHaveCount(0);

  // 請求本文只帶 model，不帶 content（沒有編輯）
  const post = api.calls.find((c) => c.key === 'POST /messages/br-ai1/regenerate');
  expect(post.body).toEqual({ model: 'gemini-2.5-flash-lite' });

  // 主對話不受影響
  await expect(messageList(page).getByText(CHAT_A_AI_TEXT, { exact: true })).toBeVisible();

  expectNoUnhandled(api);
});

test('編輯最後一則 user 訊息', async ({ page }) => {
  const api = await mockApi(page, {
    'GET /chats/roots': { status: 200, json: rootsOf(CHAT_A_HISTORY) },
    'GET /chats/a-u1/history': { status: 200, json: CHAT_A_HISTORY },
    'GET /chats/a-u1/branches': { status: 200, json: [] },
    // 第一次被額度擋下（429）；第二次成功串流
    'POST /messages/a-ai1/regenerate': (request, ctx) =>
      ctx.calls.filter((c) => c.key === 'POST /messages/a-ai1/regenerate').length === 1
        ? { status: 429, json: { detail: { code: 'daily_quota_exceeded' } } }
        : { status: 200, body: '編輯後的新回答' },
  });

  // 對話框要在送出前註冊：記下文字並按確定
  const dialogs = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept();
  });

  await page.goto('/');
  await sidebarChat(page, '甲對話').click();
  await expect(messageList(page).getByText('甲對話的問題', { exact: true })).toBeVisible();
  await expect(messageList(page).getByText(CHAT_A_AI_TEXT, { exact: true })).toBeVisible();

  // 第一次：編輯後送出，額度被擋 → 還原
  await editLastUserMessage(page, '改過的問題');

  await expect.poll(() => dialogs).toEqual(['今日試用額度已用完。登入並連結 OpenRouter 就能繼續使用']);
  await expect(messageList(page).getByText('甲對話的問題', { exact: true })).toBeVisible();
  await expect(messageList(page).getByText('改過的問題', { exact: true })).toHaveCount(0);
  await expect(messageList(page).getByText(CHAT_A_AI_TEXT, { exact: true })).toBeVisible();

  // 第二次：再編輯一次送出，成功
  await editLastUserMessage(page, '改過的問題');

  await expect(messageList(page).getByText('改過的問題', { exact: true })).toBeVisible();
  await expect(messageList(page).getByText('編輯後的新回答', { exact: true })).toBeVisible();
  await expect(messageList(page).getByText(CHAT_A_AI_TEXT, { exact: true })).toHaveCount(0);
  expect(dialogs).toHaveLength(1);

  // 兩次請求的本文：第二次才帶上新內容
  const posts = api.calls.filter((c) => c.key === 'POST /messages/a-ai1/regenerate');
  expect(posts).toHaveLength(2);
  expect(posts[1].body).toEqual({ model: 'gemini-2.5-flash-lite', content: '改過的問題' });

  expectNoUnhandled(api);
});
