// 多個 spec 檔共用的定位器：改版時只改這裡

// 主對話的輸入框（ChatInput 預設 placeholder）
export const mainInput = (page) => page.getByPlaceholder('輸入訊息...');
// 送出按鈕：ChatInput 的按鈕沒有文字與 aria-label，緊接在輸入框後面，用相鄰關係找
const sendButtonOf = (input) => input.locator('xpath=following-sibling::button[1]');
export const sendButton = (page) => sendButtonOf(mainInput(page));

// 分支面板的輸入框（ChatInput 的 branch 變體，placeholder 固定）與送出按鈕
export const branchInput = (page) => page.getByPlaceholder('在這個分支繼續對話...');
export const branchSendButton = (page) => sendButtonOf(branchInput(page));

// 主對話的訊息區（MessageList 的捲動容器）。沒有 data-testid，只能用 class 找；
// 分支面板也用同一個組件，但主對話在 DOM 上較前面，所以取第一個。
export const messageList = (page) => page.locator('div.overflow-y-auto.p-4').first();

// 側欄的對話列按鈕：無障礙名稱以對話標題開頭（⋯ 按鈕的 aria-label 以「 開頭，不會誤中）
export const sidebarChat = (page, title) => page.getByRole('button', { name: new RegExp(`^${title}`) });
