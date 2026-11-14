import { useEffect, useRef, useState } from 'react';

// (L1-4) 落地頁自動播放：假游標示範「選取片語 → 建立分支 → 分支播放」。
// (L1-7) 會依序把文章裡所有虛線片語都點開成分支，每條分支播完後再點下一個；
// 按「換一篇」（restartKey 改變）會取消目前這一輪，從頭再播。
// 使用者有任何 pointerdown／keydown／wheel／touchstart 就停止「這一輪」，直到下一次「換一篇」才會再開始。
// 所有計時器與 rAF 都收進 pending，停止時一次取消。

// 時間參數（調速改這裡）
const START_DELAY_MS = 1200; // 載入後等多久才開始
const MOVE_MS = 900; // 游標移到定位後等多久（CSS 移動動畫 800 ms，多留 100 ms）
const POLL_MS = 100; // 等「建立分支」按鈕出現：每隔多久檢查一次
const POLL_TIMEOUT_MS = 2000; // 最多等多久，逾時就停止
const AFTER_CLICK_MS = 300; // 按下「建立分支」後，隱藏游標前等多久
const MOBILE_BREAKPOINT = 768; // 小於這個寬度只做到「選取並顯示按鈕」
const BETWEEN_MS = 1500; // (L1-7) 一條分支播完後，停多久再去點下一個片語
const BUSY_POLL_TIMEOUT_MS = 30000; // (L1-7) 等分支回答播完最多等多久，逾時就停止
const SCROLL_MS = 500; // (L1-7) 把下一個片語捲進畫面後等多久

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
const HIDDEN = { left: 0, top: 0, visible: false };

// (L1-4) selectHint：由 LandingPage 傳入（與點提示段落相同的函式）；scrollContainerRef：主對話捲動容器的 ref
// (L1-7) isBusy：有分支回答還在串流時為 true；restartKey：每次改變就取消目前這一輪並從頭開始（「換一篇」）
export default function useDemoAutoplay({ scrollContainerRef, selectHint, isBusy, restartKey }) {
  const [cursor, setCursor] = useState(HIDDEN);

  // 用 ref 讀最新的 selectHint（在 effect 裡更新，不在 render 時寫 ref），自動播放 effect 本身只在掛載時跑一次
  const selectHintRef = useRef(selectHint);
  // (L1-7) isBusy 同樣用 ref 讀最新值
  const isBusyRef = useRef(isBusy);
  useEffect(() => {
    selectHintRef.current = selectHint;
    isBusyRef.current = isBusy;
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

    // 停止自動播放（使用者互動、播完、逾時、卸載、換一篇都走這裡）
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

    // 步驟 5：手機只停在按鈕；桌面移過去、按下，然後等分支播完再點下一個（L1-7）
    const step5 = (button) => {
      if (window.innerWidth < MOBILE_BREAKPOINT) return cancelAutoplay();
      moveTo(button);
      later(() => {
        if (!button.isConnected) return cancelAutoplay();
        button.click(); // click 不會觸發 pointerdown，不會讓自己取消
        later(() => waitIdle(Date.now()), AFTER_CLICK_MS); // (L1-7) 原本是 later(cancelAutoplay, AFTER_CLICK_MS)
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
      if (!target.isConnected) return cancelAutoplay(); // (L1-7)
      selectHintRef.current?.({ id: target.getAttribute('data-branch') });
      poll(Date.now());
      return undefined;
    };

    // (L1-7) 游標移到片語上，然後進入步驟 3
    const move = (target) => {
      if (!target.isConnected) return cancelAutoplay();
      moveTo(target);
      later(() => step3(target), MOVE_MS);
      return undefined;
    };

    // (L1-7) 片語不完整落在捲動容器可視範圍內時先捲動（置中），捲完再移動；否則直接移動
    const approach = (target) => {
      const container = scrollContainerRef.current;
      if (!container || !target.isConnected) return cancelAutoplay();
      const box = container.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      const fullyInside = t.top >= box.top && t.bottom <= box.bottom;
      if (fullyInside) return move(target);
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      later(() => move(target), SCROLL_MS);
      return undefined;
    };

    // (L1-7) 找下一個尚未開啟的片語（第一個剩下的 mark[data-hint]）；找不到就是全部播完，停止
    // isFirst：第一個片語要先把游標放到主對話中間偏下，下一幀再開始移動；之後游標留在原地
    const startNext = (isFirst) => {
      const container = scrollContainerRef.current;
      const target = container?.querySelector('mark[data-hint]');
      if (!container || !target) return cancelAutoplay();
      if (isFirst) {
        const box = container.getBoundingClientRect();
        setCursor({ left: box.left + box.width / 2, top: box.top + box.height * 0.6, visible: true });
        nextFrame(() => approach(target));
        return undefined;
      }
      return approach(target);
    };

    // (L1-7) 等目前這條分支的回答播完：播完後停 BETWEEN_MS 再點下一個；超過 BUSY_POLL_TIMEOUT_MS 就停止
    const waitIdle = (startedAt) => {
      if (!isBusyRef.current) return later(() => startNext(false), BETWEEN_MS);
      if (Date.now() - startedAt >= BUSY_POLL_TIMEOUT_MS) return cancelAutoplay();
      later(() => waitIdle(startedAt), POLL_MS);
      return undefined;
    };

    INTERACTION_EVENTS.forEach((type) => window.addEventListener(type, onInteract, true));
    later(() => startNext(true), START_DELAY_MS);

    return () => cancelAutoplay();
    // (L1-7) restartKey 不在 effect 內讀取，但改變時要重新開始一輪
  }, [scrollContainerRef, restartKey]);

  return cursor;
}
