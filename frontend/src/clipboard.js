// (G8) 複製文字到剪貼簿。
// 安全環境（https／localhost）用現代 Clipboard API；
// 不是安全環境（例如手機用 http://區網IP 連開發伺服器）時，退回舊的複製指令（隱藏 textarea）。
export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 權限被拒等狀況 → 往下走備援
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', ''); // 手機不跳鍵盤
  ta.style.position = 'fixed';
  ta.style.top = '0'; // 放在視窗左上角：select／focus 不會捲動頁面（捲動會關掉長按選單）
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  // iOS Safari 的 select() 不會選取 readonly textarea，要再設定選取範圍
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

export default copyText;
