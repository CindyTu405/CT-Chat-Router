import { useEffect, useMemo, useRef, useState } from 'react';
import { MousePointer2, RefreshCw } from 'lucide-react';
import MessageList from './MessageList';
import BranchPanel from './BranchPanel';
import { DEMO_ARTICLES, DEMO_GENERIC_ANSWER } from '../demo/demoArticles';
// (L1-4) 自動播放（假游標）
import useDemoAutoplay from '../demo/useDemoAutoplay';

// (L1-3) 未登入的首頁：標語、一篇示範對話，以及真的 MessageList／BranchPanel 吃假資料。
// 不呼叫任何 API、不呼叫模型；所有計時器都收進 timersRef，換一篇／卸載時一次清掉。

// (L1-3) 模擬串流：開始前等 STREAM_START_DELAY_MS，之後每 STREAM_TICK_MS 追加 STREAM_CHARS_PER_TICK 個字。調速改這三個常數。
const STREAM_START_DELAY_MS = 500;
const STREAM_TICK_MS = 30;
const STREAM_CHARS_PER_TICK = 2;

// (L1-3) 片語對應的分支 id（與正式資料的 id 格式無關，只在示範內使用）
const branchIdOfPhrase = (phrase) => `b-${phrase.id}`;

// (L1-3) 取前 n 個字元（以 code point 計），超過就補「…」
const takeChars = (text, n) => {
  const chars = [...text];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : text;
};

// (L1-3) 收集節點底下所有非空文字節點（依文件順序）
const textNodesIn = (el) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    if (walker.currentNode.length > 0) nodes.push(walker.currentNode);
  }
  return nodes;
};

// (L1-3) 清掉一組計時器 id。timeout 與 interval 共用同一個 id 空間，兩個都呼叫是安全的。
const clearTimerSet = (timers) => {
  timers.forEach((id) => {
    window.clearTimeout(id);
    window.clearInterval(id);
  });
  timers.clear();
};

export default function LandingPage({ onStart }) {
  // (L1-3) 每次打開隨機一篇；「換一篇」往後移一篇
  const [articleIndex, setArticleIndex] = useState(() => Math.floor(Math.random() * DEMO_ARTICLES.length));
  const article = DEMO_ARTICLES[articleIndex];

  // (L1-3) branches：已開過的示範分支（形狀同正式介面的 branches）；branchList：同 GET /chats/{root}/branches 的列資料
  const [branches, setBranches] = useState([]);
  const [branchList, setBranchList] = useState([]);
  const [activeBranchId, setActiveBranchId] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // (L1-7) 每按一次「換一篇」加一，讓自動播放從頭再播
  const [autoplayKey, setAutoplayKey] = useState(0);

  const scrollContainerRef = useRef(null);
  const timersRef = useRef(new Set());
  const freeCounterRef = useRef(0);

  const clearAllTimers = () => clearTimerSet(timersRef.current);

  // (L1-3) 卸載時清掉所有計時器（StrictMode 的第二次掛載不受影響：這裡沒有東西要重啟）
  useEffect(() => {
    const timers = timersRef.current;
    return () => clearTimerSet(timers);
  }, []);

  // (L1-3) 主對話：一問一答，固定來自目前這篇文章
  const messages = useMemo(
    () => [
      { id: `${article.id}-u`, role: 'user', content: article.question },
      { id: `${article.id}-a`, role: 'assistant', content: article.answer },
    ],
    [article]
  );

  // (L1-3) 尚未建立分支的片語才顯示虛線提示
  const anchorHints = article.phrases
    .filter((phrase) => !branchList.some((b) => b.id === branchIdOfPhrase(phrase)))
    .map((phrase) => ({
      id: phrase.id,
      message_id: `${article.id}-a`,
      start: phrase.start,
      end: phrase.end,
    }));

  // (L1-3) 點提示＝程式幫忙選取該片語（之後 MessageList 會出現真的「建立分支」按鈕）。
  // 選取範圍：第一個 mark 的第一個文字節點開頭 → 最後一個 mark 的最後一個文字節點結尾。
  // (L1-4) 自動播放也呼叫這個函式，請保持它只依賴 DOM，不依賴其他 state。
  const selectHint = (hint) => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const marks = Array.from(root.querySelectorAll('mark[data-hint]')).filter(
      (m) => m.getAttribute('data-branch') === String(hint.id)
    );
    if (marks.length === 0) return;
    const firstText = textNodesIn(marks[0])[0];
    const lastNodes = textNodesIn(marks[marks.length - 1]);
    const lastText = lastNodes[lastNodes.length - 1];
    if (!firstText || !lastText) return;
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(lastText, lastText.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // (L1-4) 自動播放：游標位置與是否顯示由 hook 決定。
  // (L1-7) 自動播放會把所有虛線片語依序點完；使用者互動即停止這一輪，按「換一篇」會重新開始。
  const cursor = useDemoAutoplay({
    scrollContainerRef,
    selectHint,
    isBusy: branches.some((b) => b.isLoading),
    restartKey: autoplayKey,
  });

  const openBranch = (branch) => {
    setActiveBranchId(branch.id);
    setPanelOpen(true);
  };

  // (L1-3) 模擬串流：500 ms 後每 30 ms 追加 2 個字，全部送完才把 isLoading 設回 false
  const streamReply = (branchId, messageId, answer) => {
    const delayId = window.setTimeout(() => {
      timersRef.current.delete(delayId);
      let pos = 0;
      const intervalId = window.setInterval(() => {
        pos = Math.min(pos + STREAM_CHARS_PER_TICK, answer.length);
        const done = pos >= answer.length;
        const shown = answer.slice(0, pos);
        setBranches((prev) =>
          prev.map((b) =>
            b.id !== branchId
              ? b
              : {
                  ...b,
                  isLoading: done ? false : b.isLoading,
                  messages: b.messages.map((m) => (m.id === messageId ? { ...m, content: shown } : m)),
                }
          )
        );
        if (done) {
          window.clearInterval(intervalId);
          timersRef.current.delete(intervalId);
        }
      }, STREAM_TICK_MS);
      timersRef.current.add(intervalId);
    }, STREAM_START_DELAY_MS);
    timersRef.current.add(delayId);
  };

  // (L1-3) MessageList 按「建立分支」時呼叫
  const handleCreateBranch = (messageId, text, start, end) => {
    const hasOffsets = Number.isInteger(start) && Number.isInteger(end);
    const phrase = hasOffsets
      ? article.phrases.find((p) => start < p.end && end > p.start)
      : null;

    if (phrase) {
      const id = branchIdOfPhrase(phrase);
      // 已經建過的片語：只開啟，不重複建立
      if (branchList.some((b) => b.id === id)) {
        openBranch({ id });
        return;
      }
      // 錨點吸附到片語範圍，不是訪客的選取範圍
      setBranchList((prev) => [
        ...prev,
        {
          id,
          title: phrase.question,
          anchor_text: phrase.text,
          anchor_message_id: messageId,
          anchor_start: phrase.start,
          anchor_end: phrase.end,
          precise: true,
          root_message_id: `${id}-u`,
          created_at: new Date().toISOString(),
        },
      ]);
      setBranches((prev) => [
        ...prev,
        {
          id,
          anchorMessageId: messageId,
          rootMessageId: `${id}-u`,
          title: phrase.question,
          messages: [
            { id: `${id}-u`, role: 'user', content: phrase.question },
            { id: `${id}-a`, role: 'assistant', content: '' },
          ],
          input: '',
          isLoading: true,
        },
      ]);
      setActiveBranchId(id);
      setPanelOpen(true);
      streamReply(id, `${id}-a`, phrase.answer);
      return;
    }

    // 沒有對上片語：建立一條通用示範分支
    const trimmed = text.trim();
    freeCounterRef.current += 1;
    const id = `b-free-${freeCounterRef.current}`;
    setBranchList((prev) => [
      ...prev,
      {
        id,
        title: [...trimmed].slice(0, 20).join(''),
        anchor_text: trimmed,
        anchor_message_id: messageId,
        anchor_start: hasOffsets ? start : null,
        anchor_end: hasOffsets ? end : null,
        precise: hasOffsets,
        root_message_id: `${id}-u`,
        created_at: new Date().toISOString(),
      },
    ]);
    setBranches((prev) => [
      ...prev,
      {
        id,
        anchorMessageId: messageId,
        rootMessageId: `${id}-u`,
        title: [...trimmed].slice(0, 20).join(''),
        messages: [
          { id: `${id}-u`, role: 'user', content: `請說明「${takeChars(trimmed, 30)}」` },
          { id: `${id}-a`, role: 'assistant', content: '' },
        ],
        input: '',
        isLoading: true,
      },
    ]);
    setActiveBranchId(id);
    setPanelOpen(true);
    streamReply(id, `${id}-a`, DEMO_GENERIC_ANSWER);
  };

  // (L1-3) 換一篇：停止所有計時器，清掉示範分支與選取，關面板
  const nextArticle = () => {
    clearAllTimers();
    window.getSelection()?.removeAllRanges();
    setArticleIndex((i) => (i + 1) % DEMO_ARTICLES.length);
    setAutoplayKey((k) => k + 1); // (L1-7) 讓自動播放從頭再播
    setBranches([]);
    setBranchList([]);
    setActiveBranchId(null);
    setPanelOpen(false);
  };

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col bg-white text-gray-800 font-sans overflow-hidden">
      {/* (L1-3) 頂列：logo、名稱、隱私權說明、登入 */}
      <header className="flex items-center justify-between px-4 md:px-6 py-2.5 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" aria-hidden="true" className="w-7 h-7" />
          <span className="font-semibold text-gray-800">FluentBranch</span>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="/privacy.html"
            target="_blank"
            rel="noopener"
            className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2"
          >
            隱私權說明
          </a>
          <button
            type="button"
            onClick={onStart}
            className="min-h-[36px] px-3 text-sm font-semibold text-[#51A8DD] hover:bg-[#E8F1F5] rounded-lg cursor-pointer"
          >
            登入
          </button>
        </div>
      </header>

      {/* (L1-3) 展示區：主對話＋右側分支面板；格線背景放在這一層 */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row bg-[#E8F1F5] bg-[linear-gradient(to_right,#d3e3eb_1px,transparent_1px),linear-gradient(to_bottom,#d3e3eb_1px,transparent_1px)] bg-[size:16px_16px]">
        {/* (L1-6) 標語區：桌面（md 以上）是左側白底欄；手機維持在上方、透明疊在格線上。桌面三欄比例（視窗寬度）：標語 34%（md:w-[30%] lg:w-[34%]，上限 md:max-w-[600px]）／主對話吃剩下的／分支面板 28%（BranchPanel 的 defaultWidthPercent）。標語字級：md:text-4xl lg:text-5xl；欄內左右留白：md:px-10 lg:px-14。 */}
        <section className="flex-shrink-0 px-4 pt-5 pb-2 text-center md:w-[30%] lg:w-[34%] md:max-w-[600px] md:px-10 lg:px-14 md:py-0 md:flex md:flex-col md:justify-center md:items-start md:text-left md:bg-white md:border-r md:border-gray-200">
          <h1 className="text-xl md:text-4xl lg:text-5xl md:leading-[1.15] font-semibold tracking-tight text-gray-800">
            追問細節，<br className="hidden md:block" />不打斷主線
          </h1>
          <p className="mt-1 md:mt-5 text-sm md:text-base lg:text-lg md:leading-relaxed md:max-w-[20em] text-gray-500">選取 AI 回答裡的任何一段，開一條分支繼續問。</p>
          <button
            type="button"
            onClick={onStart}
            className="mt-3 md:mt-8 min-h-[44px] px-6 md:px-8 rounded-xl bg-[#51A8DD] hover:bg-[#3d97cf] text-white font-semibold shadow-sm cursor-pointer transition-colors"
          >
            開始使用
          </button>
        </section>

        <div className="flex-1 min-h-0 min-w-0 flex flex-col relative">
          {/* (L1-3) 示範列：位於標語區下方，透明疊在格線上 */}
          <div className="flex items-center justify-between gap-3 px-4 md:px-6 pt-2 pb-1 text-xs text-gray-500 flex-shrink-0">
            <span className="min-w-0 truncate">示範對話 · {article.topic}{'\u3000'}點虛線文字，或選取任何一段，試試開分支</span>
            <button
              type="button"
              onClick={nextArticle}
              className="flex items-center gap-1.5 flex-shrink-0 min-h-[32px] px-2.5 rounded-lg border border-[#7DB9DE] bg-white hover:bg-[#E8F1F5] text-gray-600 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              換一篇
            </button>
          </div>

          <MessageList
            messages={messages}
            isLoading={false}
            setInput={() => {}}
            onCreateBranch={handleCreateBranch}
            branchList={branchList}
            onOpenBranch={openBranch}
            scrollContainerRef={scrollContainerRef}
            anchorHints={anchorHints}
            onHintClick={selectHint}
          />

          {/* (L1-3) 主對話底部：取代原本輸入框的說明列 */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-gray-200 bg-white/80 text-sm text-gray-500 flex-shrink-0">
            <span>這是示範。按「開始使用」就能輸入自己的問題。</span>
            <button
              type="button"
              onClick={onStart}
              className="flex-shrink-0 min-h-[36px] px-4 rounded-lg bg-[#51A8DD] hover:bg-[#3d97cf] text-white text-sm font-semibold cursor-pointer"
            >
              開始使用
            </button>
          </div>
        </div>

        {panelOpen && (
          <BranchPanel
            branches={branches}
            activeBranchId={activeBranchId}
            model=""
            setModel={() => {}}
            isCustomModel={false}
            setIsCustomModel={() => {}}
            freeModels={[]}
            freeModelsLoading={false}
            presets={[]}
            defaultModel=""
            optionsLoading={false}
            branchList={branchList}
            messages={messages}
            scrollContainerRef={scrollContainerRef}
            onOpenBranch={openBranch}
            onInputChange={() => {}}
            onSend={() => {}}
            onToggle={() => setPanelOpen(false)}
            defaultWidthPercent={20}
            persistWidth={false}
            footer={
              <div className="px-4 py-3 border-t border-gray-200 bg-white/80 text-xs text-gray-500 leading-relaxed">
                示範分支不能輸入。開始使用後，每條分支都能繼續追問。
              </div>
            }
          />
        )}
      </div>

      {/* (L1-4) 假游標：只在自動播放期間渲染；pointer-events-none 不擋使用者操作 */}
      {cursor.visible && (
        <div
          aria-hidden="true"
          className="fixed z-[60] pointer-events-none"
          style={{
            left: cursor.left,
            top: cursor.top,
            opacity: 1,
            transition: 'left 800ms ease, top 800ms ease, opacity 300ms ease',
          }}
        >
          <MousePointer2 className="w-6 h-6 text-gray-800 fill-white drop-shadow" />
        </div>
      )}
    </div>
  );
}
