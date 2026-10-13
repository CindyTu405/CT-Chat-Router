import { useCallback, useEffect, useRef, useState } from 'react';

// P5b：側邊欄時間軸導航
// - PC（視窗 >= 768px）：右側獨立導航列，常駐顯示所有群組標籤，點擊捲動到對應群組。
// - 手機（< 768px）：Google 相簿式 scrubber——捲動列表時右側浮出目前群組標籤氣泡，
//   長按或拖曳氣泡展開完整群組清單，拖曳時即時跳轉，放開後延遲淡出。
// 元件只負責導航；列表捲動容器（scrollRef）與群組資料（groups）由 Sidebar 傳入，
// 各群組 section 以 data-timeline-group 屬性標記，作為捲動錨點。

const AUTO_HIDE_MS = 1200; // 手機版停止捲動後，氣泡延遲淡出的時間

// 導航列／scrubber 空間有限，群組標題縮短顯示（「2025 年 8 月」→「2025/8」），
// 其餘（今天／昨天／近 7 天…）本來就短，維持原樣。
function shortLabel(label) {
  return label.replace(/(\d{4}) 年 (\d{1,2}) 月/, '$1/$2');
}

export default function TimelineRail({ groups, scrollRef, isMobile }) {
  const count = groups.length;
  const [activeIndex, setActiveIndex] = useState(0); // 目前捲動位置對應的群組
  const [visible, setVisible] = useState(false);     // 手機版 scrubber 是否顯示（只捲動時出現）
  const [scrubbing, setScrubbing] = useState(false); // 是否處於長按／拖曳快速跳轉模式

  // scroll 事件與 pointer handler 都會更新 activeIndex，兩邊都要讀最新值，故同步存 ref
  const activeRef = useRef(0);
  const scrubbingRef = useRef(false);
  const movedRef = useRef(false);      // 本次拖曳是否移動過（用來吞掉拖曳結束後觸發的 click）
  const hideTimerRef = useRef(null);
  const labelRefs = useRef([]);

  // 取得各群組 section 元素；DOM 順序即 groups 順序
  const getSections = useCallback(() => {
    const container = scrollRef.current;
    return container ? Array.from(container.querySelectorAll('[data-timeline-group]')) : [];
  }, [scrollRef]);

  // 捲動到指定群組：讓 section 頂點對齊列表頂端（sticky 群組標題剛好停在頂部）
  const scrollToGroup = useCallback((index, behavior = 'smooth') => {
    const container = scrollRef.current;
    const sections = getSections();
    if (!container || sections.length === 0) return;
    const clamped = Math.max(0, Math.min(index, sections.length - 1));
    const el = sections[clamped];
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top, behavior });
  }, [scrollRef, getSections]);

  const clearHideTimer = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    // 拖曳中不淡出，放開後才計時
    if (!scrubbingRef.current) {
      hideTimerRef.current = setTimeout(() => setVisible(false), AUTO_HIDE_MS);
    }
  }, []);

  // 捲動偵測：依各 section 頂端到列表頂端的距離判斷目前群組；
  // 手機版同時負責 scrubber 的「捲動時出現、停止後淡出」。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    let frame = 0;
    const update = () => {
      const sections = getSections();
      if (sections.length === 0) return;
      const cRect = container.getBoundingClientRect();
      const scrollTop = container.scrollTop;
      let idx = 0;
      sections.forEach((el, i) => {
        const offset = el.getBoundingClientRect().top - cRect.top + scrollTop;
        if (offset <= scrollTop + 2) idx = i;
      });
      if (idx !== activeRef.current) {
        activeRef.current = idx;
        setActiveIndex(idx);
      }
    };

    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
      }
      if (isMobile) {
        setVisible(true);
        scheduleHide();
      }
    };

    update(); // 掛載／群組或裝置變更時先同步一次
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', update);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, getSections, isMobile, scheduleHide, count]);

  // 卸載時清掉淡出計時器
  useEffect(() => () => clearHideTimer(), []);

  // P5b-fix（B2）：斷點切換（手機↔PC）時重設顯示／拖曳狀態並清除殘留計時器。
  // 側邊欄收起的情境已由父層不再渲染本元件處理（卸載即重置）；此處補上 resize
  // 跨越斷點的情況——若拖曳時 pointerup 未觸發，scrubbing 會卡在 true，
  // 導致所有群組標籤常駐並攔截觸控。
  useEffect(() => {
    scrubbingRef.current = false;
    movedRef.current = false;
    setScrubbing(false);
    setVisible(false);
    clearHideTimer();
  }, [isMobile]);

  // 拖曳時依手指 Y 座標找最近的標籤（用各標籤垂直中心比距離，超出範圍自然貼到首/末群組）
  const pickByPointer = (clientY) => {
    const labels = labelRefs.current.slice(0, count);
    let idx = 0;
    let best = Infinity;
    labels.forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - clientY);
      if (d < best) {
        best = d;
        idx = i;
      }
    });
    if (idx !== activeRef.current) {
      activeRef.current = idx;
      setActiveIndex(idx);
      scrollToGroup(idx, 'auto'); // 拖曳要即時跟隨，不用平滑捲動
    }
  };

  // 以下三個 handler 掛在標籤 button 上；手機版按壓即進入拖曳模式
  // （同時滿足「長按」與「拖曳」兩種手勢，按住不動會展開清單，再移動即可快速跳轉）。
  const handlePointerDown = (e) => {
    if (!isMobile || count < 2) return;
    scrubbingRef.current = true;
    movedRef.current = false;
    setScrubbing(true);
    setVisible(true);
    clearHideTimer();
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!scrubbingRef.current) return;
    movedRef.current = true;
    pickByPointer(e.clientY);
  };

  const handlePointerUp = (e) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    setScrubbing(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    scheduleHide();
  };

  // PC 導航列點擊、手機版輕點氣泡都走這裡；拖曳結束後觸發的 click 要忽略，
  // 否則會被捲動捕獲的原始氣泡把畫面拉回拖曳前的群組。
  const handleClick = (index) => {
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    scrollToGroup(index, 'smooth');
    if (isMobile) {
      setVisible(true);
      scheduleHide();
    }
  };

  if (count === 0) return null;
  if (!isMobile && count < 2) return null; // 只有一個群組時 PC 導航列沒有導覽意義

  const idx = Math.min(activeIndex, count - 1);
  const hideInactive = isMobile && !scrubbing; // 手機收起態：只顯示目前群組氣泡，其餘透明且不攔觸控
  // 只讓「可操作」的標籤攔截事件；nav 容器本身永遠 pointer-events-none，
  // 否則手機版氣泡顯示時，右側直條會擋住列表的捲動手勢。
  const isLabelInteractive = (i) =>
    !isMobile || scrubbing || (i === idx && count >= 2);

  return (
    <nav
      aria-label="對話時間軸"
      className={`pointer-events-none absolute right-1 top-1/2 z-20 flex max-h-[85%] -translate-y-1/2 select-none flex-col items-end gap-1 overflow-hidden transition-opacity duration-200 ${
        isMobile ? (visible ? 'opacity-100' : 'opacity-0') : 'opacity-100'
      }`}
    >
      {groups.map((g, i) => (
        <button
          key={g.key}
          type="button"
          ref={(el) => { labelRefs.current[i] = el; }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={() => handleClick(i)}
          title={g.label}
          aria-label={`跳到「${g.label}」群組`}
          style={{ touchAction: 'none' }}
          className={`cursor-pointer whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] leading-tight transition-all ${
            hideInactive && i !== idx ? 'opacity-0' : 'opacity-100'
          } ${isLabelInteractive(i) ? 'pointer-events-auto' : 'pointer-events-none'} ${
            i === idx
              ? 'bg-[#51A8DD] font-semibold text-white shadow-sm'
              : 'bg-white/85 text-gray-500 hover:text-[#228DCD]'
          }`}
        >
          {shortLabel(g.label)}
        </button>
      ))}
    </nav>
  );
}
