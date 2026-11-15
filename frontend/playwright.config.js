// Playwright 端對端測試設定：Playwright 自己啟動 Vite，API 全部由測試用 page.route 攔截（見 e2e/mockApi.js）
import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // CI 上禁止 test.only 留在程式碼裡
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    // VITE_API_URL 指向同源的 /__api，讓 page.route 攔得到，也不會有 CORS
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60000,
    env: { VITE_API_URL: `${BASE_URL}/__api` },
  },
});
