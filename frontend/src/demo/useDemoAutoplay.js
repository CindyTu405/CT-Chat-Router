import { useEffect, useRef, useState } from 'react';

// (L1-4) 落地頁自動播放：假游標示範「選取片語 → 建立分支 → 分支播放」。
// 每次掛載只播一次；使用者有任何 pointerdown／keydown／wheel／touchstart 就永久停止（不會因「換一篇」重新開始）。
// 所有計時器與 rAF 都收進 pending，停止時一次取消。

// 時間參數（調速改這裡）
const START_DELAY_MS = 1200; // 載入後等多久才開始
const MOVE_MS = 900; // 游標移到定位後等多久（CSS 移動動畫 800 ms，多留 100 ms）
const POLL_MS = 100; // 等「建立分支」按鈕出現：每隔多久檢查一次
const POLL_TIMEOUT_MS = 2000; // 最多等多久，逾時就停止
const AFTER_CLICK_MS = 300; // 按下「建立分支」後，隱藏游標前等多久
const MOBILE_BREAKPOINT = 768; // 小於這個寬度只做到「選取並顯示按鈕」

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
const HIDDEN = { left: 0, top: 0, visible: false };

// (L1-4) selectHint：由 LandingPage 傳入（與點提示段落相同的函式）；scrollContainerRef：主對話捲動容器的 ref
export default function useDemoAutoplay({ scrollContainerRef, selectHint }) {
  const [cursor, setCursor] = useState(HIDDEN);

  // 用 ref 讀最新的 selectHint（在 effect 裡更新，不在 render 時寫 ref），自動播放 effect 本身只在掛載時跑一次
  const selectHintRef = useRef(selectHint);
  useEffect(() => {
    selectHintRef.current = selectHint;
  });

  useEffect(() => {
    // prefers-reduced-motion：完全不播放
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    // 尚未執行的計時器／rAF 的取消函式
    const pending = new Set();
    let stopped = false;

    const later = (fn, ms) => {
      const id = window.setTimeout(() => {
        pending.delete(cancel);
        fn();
      }, ms);
      const cancel = () => window.clearTimeout(id);
      pending.add(cancel);
    };

    const nextFrame = (fn) => {
      const id = window.requestAnimationFrame(() => {
        pending.delete(cancel);
        fn();
      });
      const cancel = () => window.cancelAnimationFrame(id);
      pending.add(cancel);
    };

    const onInteract = () => cancelAutoplay();
    const removeListeners = () => {
      INTERACTION_EVENTS.forEach((type) => window.removeEventListener(type, onInteract, true));
    };

    // 停止自動播放（使用者互動、播完、逾時、卸載都走這裡）
    function cancelAutoplay() {
      if (stopped) return;
      stopped = true;
      pending.forEach((cancel) => cancel());
      pending.clear();
      setCursor(HIDDEN);
      removeListeners();
    }

    const moveTo = (el) => {
      const r = el.getBoundingClientRect();
      setCursor({ left: r.left + r.width / 2, top: r.top + r.height / 2, visible: true });
    };

    // 步驟 5：手機只停在按鈕；桌面移過去、按下、隱藏游標
    const step5 = (button) => {
      if (window.innerWidth < MOBILE_BREAKPOINT) return cancelAutoplay();
      moveTo(button);
      later(() => {
        if (!button.isConnected) return cancelAutoplay();
        button.click(); // click 不會觸發 pointerdown，不會讓自己取消
        later(cancelAutoplay, AFTER_CLICK_MS);
        return undefined;
      }, MOVE_MS);
      return undefined;
    };

    // 步驟 4：每 POLL_MS 找一次「建立分支」按鈕，最多 POLL_TIMEOUT_MS
    const poll = (startedAt) => {
      const button = document.querySelector('[data-branch-create]');
      if (button) return step5(button);
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) return cancelAutoplay();
      later(() => poll(startedAt), POLL_MS);
      return undefined;
    };

    // 步驟 3：選取該片語，然後等按鈕出現
    const step3 = (target) => {
      selectHintRef.current?.({ id: target.getAttribute('data-branch') });
      poll(Date.now());
    };

    // 步驟 2：游標從主對話中間偏下出現，下一幀移到片語中心
    const step2 = () => {
      const container = scrollContainerRef.current;
      const target = container?.querySelector('mark[data-hint]');
      if (!container || !target) return cancelAutoplay();
      const box = container.getBoundingClientRect();
      setCursor({ left: box.left + box.width / 2, top: box.top + box.height * 0.6, visible: true });
      nextFrame(() => {
        moveTo(target);
        later(() => step3(target), MOVE_MS);
      });
      return undefined;
    };

    INTERACTION_EVENTS.forEach((type) => window.addEventListener(type, onInteract, true));
    later(step2, START_DELAY_MS);

    return () => cancelAutoplay();
  }, [scrollContainerRef]);

  return cursor;
}
