import { useRef, useEffect, useState, useMemo } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// 與 MessageList 的 AI 程式碼區塊相同的深色主題
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { parseUserContent } from '../userContent';

// (G9) 畫面上超過幾行就摺疊（可調；行數含自動折行，以文字行高計算）
const MAX_LINES = 10;
// (G9) 摺疊時漸層開始淡出的位置；數字越小，淡出範圍越大（可調）
const FADE_START = '70%';
const FADE_MASK = `linear-gradient(to bottom, black ${FADE_START}, transparent)`;

// (G9) user 訊息內容：原樣顯示（保留換行），只認 ``` 區塊與 `行內` 程式碼；超過 MAX_LINES 行摺疊
// 注意：展開狀態放在這個元件自己的 state；MessageList 用訊息 id 當 key，切換對話時會重新建立、回到摺疊。
export default function UserMessageContent({ content }) {
  const contentRef = useRef(null);
  const segments = useMemo(() => parseUserContent(content), [content]);

  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [maxHeight, setMaxHeight] = useState(null);

  // (G9) 量測：scrollHeight 是完整內容高度（即使被 max-height 擋住也量得到）
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      let lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      if (Number.isNaN(lineHeight)) lineHeight = 24;
      const maxH = lineHeight * MAX_LINES;
      setMaxHeight(maxH);
      setOverflowing(el.scrollHeight > maxH + 1); // +1 容忍小數誤差
    };

    // 寬度改變（拖曳分支面板、手機轉向）會影響折行數，所以用 ResizeObserver 重新量
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [content]);

  const collapsed = overflowing && !expanded;

  return (
    <>
      <div
        ref={contentRef}
        className="whitespace-pre-wrap break-words"
        style={
          collapsed
            ? {
                maxHeight,
                overflow: 'hidden',
                maskImage: FADE_MASK,
                WebkitMaskImage: FADE_MASK,
              }
            : undefined
        }
      >
        {segments.map((seg, i) => {
          if (seg.type === 'fence') {
            // whitespace-normal：程式碼區塊自己排版，不繼承外層的 pre-wrap
            return (
              <div key={i} className="whitespace-normal">
                <SyntaxHighlighter
                  style={vscDarkPlus}
                  language={seg.lang || 'text'}
                  PreTag="div"
                  className="rounded-xl my-3 shadow-sm text-sm whitespace-pre"
                >
                  {seg.code.replace(/\n$/, '')}
                </SyntaxHighlighter>
              </div>
            );
          }
          if (seg.type === 'code') {
            // 行內程式碼：與 MessageList user 氣泡的行內樣式相同
            return (
              <code
                key={i}
                className="px-1.5 py-0.5 rounded-md font-mono text-[13px] bg-blue-600/50 text-white"
              >
                {seg.text}
              </code>
            );
          }
          // (G9) 程式碼區塊本身已有 my-3 間距，緊貼區塊的那個換行要去掉，否則 pre-wrap 會多出一行空白
          let text = seg.text;
          if (segments[i - 1]?.type === 'fence' && text.startsWith('\n')) text = text.slice(1);
          if (segments[i + 1]?.type === 'fence' && text.endsWith('\n')) text = text.slice(0, -1);
          if (!text) return null;
          return <span key={i}>{text}</span>;
        })}
      </div>

      {/* (G9) 按鈕在被遮罩的內容外面（兄弟元素），不會跟著淡掉 */}
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          // (G9) 按下按鈕不啟動 G8 的長按計時器（長按事件掛在氣泡外層）
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={expanded ? '收起' : '展開'}
          aria-expanded={expanded}
          title={expanded ? '收起' : '展開'}
          className="mx-auto mt-1 flex items-center justify-center p-0.5 rounded-full text-white/90 hover:bg-white/20 transition cursor-pointer"
        >
          {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
        </button>
      )}
    </>
  );
}
