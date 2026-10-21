// (P3b-F1b) 共用捲動工具：把指定訊息捲到視窗頂端
// messageId 對應 MessageList 每則訊息上的 data-message-id 屬性。
// 預設 'auto'（瞬間定位，不做平滑動畫），找不到元素就回傳 false。
export function scrollToMessage(messageId, behavior = 'auto') {
  if (!messageId) return false;

  const el = document.querySelector(
    `[data-message-id="${String(messageId).replace(/["\\]/g, '\\$&')}"]`
  );
  if (!el) return false;

  el.scrollIntoView({ block: 'start', behavior });
  return true;
}

export default scrollToMessage;
