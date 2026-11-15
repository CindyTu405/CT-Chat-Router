// 多個 spec 檔共用的定位器：改版時只改這裡

// 主對話的輸入框（ChatInput 預設 placeholder）
export const mainInput = (page) => page.getByPlaceholder('輸入訊息...');
// 送出按鈕：輸入框與按鈕共用同一個父層 div，用 role + 名稱在該父層內找
// （分支面板也有 ChatInput，所以不能用頁面層級的 getByRole 單獨找）
export const sendButton = (page) =>
  mainInput(page).locator('xpath=..').getByRole('button', { name: '送出' });

// 分支面板的輸入框（ChatInput 的 branch 變體，placeholder 固定）與送出按鈕
export const branchInput = (page) => page.getByPlaceholder('在這個分支繼續對話...');
export const branchSendButton = (page) =>
  branchInput(page).locator('xpath=..').getByRole('button', { name: '送出' });

// 主對話的訊息區（MessageList 的捲動容器，data-testid="message-list"）。
// 分支面板也用同一個組件，但主對話在 DOM 上較前面，所以取第一個。
export const messageList = (page) => page.getByTestId('message-list').first();

// 側欄的對話列按鈕：無障礙名稱以對話標題開頭（⋯ 按鈕的 aria-label 以「 開頭，不會誤中）
export const sidebarChat = (page, title) => page.getByRole('button', { name: new RegExp(`^${title}`) });
