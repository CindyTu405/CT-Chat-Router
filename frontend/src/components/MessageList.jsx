import { useRef, useEffect, useState, useMemo } from 'react';
import { Bot, User, Sparkles, GitBranch, ArrowDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// 這裡選用 vscDarkPlus 主題，看起來會很像 VS Code 的深色模式
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { formatShortDateTime } from '../dateUtils';

// Markdown 樣式覆寫（程式碼區塊、表格、連結…），依氣泡角色決定行內程式碼配色。
// 抽成函式，讓「單段渲染」與「錨點切段渲染」共用同一套樣式。
const buildMarkdownComponents = (role) => ({
  // 處理多行程式碼區塊 (Code Blocks)
  code({ inline, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    return !inline && match ? (
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={match[1]}
        PreTag="div"
        className="rounded-xl my-3 shadow-sm text-sm"
        {...props}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    ) : (
      // 處理單行行內程式碼 (Inline Code)
      <code
        className={`px-1.5 py-0.5 rounded-md font-mono text-[13px] ${
          role === 'user'
            ? 'bg-blue-600/50 text-white' // 使用者泡泡內的行內程式碼樣式
            : 'bg-gray-100 text-[#E83E8C]' // AI 泡泡內的行內程式碼樣式
        }`}
        {...props}
      >
        {children}
      </code>
    );
  },
  // 自定義 Markdown 標籤的 Tailwind 樣式，讓排版更好看
  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc ml-5 mb-3 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal ml-5 mb-3 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  h1: ({ children }) => <h1 className="text-2xl font-bold mb-3 mt-4">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xl font-bold mb-3 mt-4">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-bold mb-2 mt-3">{children}</h3>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-600 underline underline-offset-2 transition-colors">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-gray-300 pl-4 py-1 my-3 text-gray-600 bg-gray-50 rounded-r-lg">
      {children}
    </blockquote>
  ),
  table: ({ children }) => <div className="overflow-x-auto my-4"><table className="min-w-full divide-y divide-gray-200 border border-gray-200 rounded-lg">{children}</table></div>,
  th: ({ children }) => <th className="px-4 py-2 bg-gray-50 text-left text-sm font-semibold text-gray-700 border-b">{children}</th>,
  td: ({ children }) => <td className="px-4 py-2 text-sm text-gray-600 border-b">{children}</td>,
});

// (P2-12) 把訊息內容依錨點文字切成「純文字片段 / 錨點片段」交錯的陣列。
// 錨點文字在內容裡找不到就忽略，不會壞掉。
const buildAnchorSegments = (content, anchors) => {
  let segments = [{ type: 'text', text: content }];

  (anchors || []).forEach((branch) => {
    const needle = branch?.anchor_text;
    if (!needle) return;

    const next = [];
    segments.forEach((seg) => {
      if (seg.type !== 'text' || !seg.text.includes(needle)) {
        next.push(seg);
        return;
      }
      seg.text.split(needle).forEach((piece, i) => {
        if (i > 0) next.push({ type: 'anchor', text: needle, branch });
        if (piece) next.push({ type: 'text', text: piece });
      });
    });
    segments = next;
  });

  return segments;
};

// 中間對話視窗：空狀態提示、訊息氣泡（Markdown／程式碼高亮）、選取文字建立分支
function MessageList({
  messages,
  isLoading,
  setInput,
  onCreateBranch,
  branchList = [],
  onOpenBranch = () => {},
  // (P3b-F1b) 捲動容器 ref 由 App 持有，載入對話時才能在父層還原閱讀位置
  scrollContainerRef,
  skipAutoScrollToken = null,
  forceScrollToken=0,
}) {
  const messagesEndRef = useRef(null);
  const internalContainerRef = useRef(null);
  // (P3b-F1a-fix) 使用者是否「貼在底部」：由 onScroll 維護，而不是每次內容變動後才量一次
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);

  // (P2-4) 選取 AI 回覆後的浮動「建立分支」按鈕狀態
  const [branchSel, setBranchSel] = useState(null); // { messageId, text, x, y } | null
  const branchBtnRef = useRef(null);

  // (P2-12) message id → 掛在這則訊息上的分支（只收有 anchor_text 的）
  const anchorsByMessageId = useMemo(() => {
    const map = new Map();
    (branchList || []).forEach((branch) => {
      if (!branch?.anchor_text || !branch?.anchor_message_id) return;
      const list = map.get(branch.anchor_message_id);
      if (list) list.push(branch);
      else map.set(branch.anchor_message_id, [branch]);
    });
    return map;
  }, [branchList]);

  // 點擊按鈕以外的地方 / 捲動 / 視窗縮放時，收起浮動按鈕
  useEffect(() => {
    if (!branchSel) return;
    const handleDocMouseDown = (e) => {
      if (branchBtnRef.current?.contains(e.target)) return; // 點按鈕本身時保留（交給 onClick）
      setBranchSel(null);
    };
    const close = () => setBranchSel(null);
    document.addEventListener('mousedown', handleDocMouseDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [branchSel]);

  // (P2-4) 在 AI 泡泡內放開滑鼠：若選取了文字，就在選取處上方顯示「建立分支」按鈕
  const handleAssistantMouseUp = (e, msg) => {
    if (!onCreateBranch) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setBranchSel(null);
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      setBranchSel(null);
      return;
    }

    // 選取必須完全落在這個 AI 泡泡內
    if (
      !e.currentTarget.contains(selection.anchorNode) ||
      !e.currentTarget.contains(selection.focusNode)
    ) {
      return;
    }

    // 串流中的訊息還沒有真正的 id，不能當 anchor
    if (!msg.id) return;

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const halfButton = 60; // 粗略半寬，避免按鈕被視窗邊界切掉
    setBranchSel({
      messageId: msg.id,
      text,
      x: Math.min(Math.max(rect.left + rect.width / 2, halfButton), window.innerWidth - halfButton),
      y: Math.max(rect.top - 8, 48),
    });
  };

  const createBranchFromSelection = () => {
    if (!branchSel) return;
    onCreateBranch(branchSel.messageId, branchSel.text);
    window.getSelection()?.removeAllRanges();
    setBranchSel(null);
  };

  // 單段 Markdown 渲染（沿用同一套 components）
  const renderMarkdown = (content, role, key) => (
    <ReactMarkdown
      key={key}
      remarkPlugins={[remarkGfm]}
      components={buildMarkdownComponents(role)}
    >
      {content}
    </ReactMarkdown>
  );

  // (P2-12) 有錨點就切段渲染：文字段落照舊走 Markdown，中間插可點擊的高亮
  const renderContent = (msg) => {
    const anchors = anchorsByMessageId.get(msg.id) || [];
    const segments = buildAnchorSegments(msg.content, anchors);
    const hasAnchor = segments.some((seg) => seg.type === 'anchor');

    if (!hasAnchor) {
      return renderMarkdown(msg.content, msg.role);
    }

    return (
      <div>
        {segments.map((seg, i) =>
          seg.type === 'anchor' ? (
            <mark
              key={`a-${i}`}
              onClick={() => onOpenBranch(seg.branch)}
              title={`開啟分支：${seg.branch.title || '新分支'}`}
              className="bg-amber-200/80 text-inherit rounded-sm px-0.5 underline decoration-amber-500/70 decoration-2 underline-offset-2 cursor-pointer transition-colors hover:bg-amber-300"
            >
              {seg.text}
            </mark>
          ) : (
            renderMarkdown(seg.text, msg.role, `t-${i}`)
          )
        )}
      </div>
    );
  };

  // 自動捲動到底部（只有在使用者已經接近底部時才捲，避免打斷往上讀歷史訊息）
  // (P3b-F1a-fix) 「是否在底部」改由 onScroll 持續維護（isAtBottom），
  //   並且一律「瞬間」貼底，避免 smooth 動畫在快速串流時永遠追不上。
  // (P3b-F1b) 若 App 已經標記要還原閱讀位置／對齊最後一則 user 訊息（restoreToken 遞增），
  // 就先跳過一次，避免載入對話的瞬間被拉回底部。
  const lastAutoScrollSkipToken = useRef(0);

  const getContainer = () => scrollContainerRef?.current || internalContainerRef?.current;

  // 瞬間捲到底（不觸發 smooth），並同步狀態
  const scrollToBottomNow = () => {
    const container = getContainer();
    if (container) container.scrollTop = container.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  };

  const handleScroll = () => {
    const container = getContainer();
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom <= 100;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  };

  useEffect(() => {
    if (skipAutoScrollToken != null && skipAutoScrollToken !== lastAutoScrollSkipToken.current) {
      lastAutoScrollSkipToken.current = skipAutoScrollToken;
      return;
    }
    if (!isAtBottomRef.current) return;
    scrollToBottomNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, skipAutoScrollToken, scrollContainerRef]);

  // 使用者自己送出訊息:不管目前在哪裡,都強制捲到底,
  // 並把「貼底」狀態設為 true,之後串流會繼續跟著捲
  const lastForceTokenRef = useRef(forceScrollToken);

  useEffect(() => {
    if (forceScrollToken === lastForceTokenRef.current) return; // 擋掉初次掛載
    lastForceTokenRef.current = forceScrollToken;

    isAtBottomRef.current = true; // 先標記貼底,讓原本的 effect 之後也會跟著串流捲
    scrollToBottomNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceScrollToken]);

  return (
    <div
      ref={(node) => {
        internalContainerRef.current = node;
        if (typeof scrollContainerRef === 'function') scrollContainerRef(node);
        else if (scrollContainerRef) scrollContainerRef.current = node;
      }}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6"
    >
      {messages.length === 0 ? (
        // --- 空狀態 (Empty State) ---
        <div className="h-full flex flex-col items-center justify-center text-gray-500 space-y-5">
          <div className="w-16 h-16 bg-[#51A8DD] rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-[#51A8DD]/30">
            <Bot className="w-8 h-8 text-white" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-2xl font-semibold text-gray-700 tracking-tight">今天想聊些什麼？</p>
            <p className="text-sm text-gray-400">選一個提示，或直接開始輸入</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-lg px-4">
            {['隨機介紹一個景點', '推薦一道食譜', '分享一本書給我', '講個笑話'].map(suggestion => (
              <button 
                key={suggestion}
                onClick={() => setInput(suggestion)}
                className="p-4 bg-white/80 border border-[#7DB9DE] hover:bg-gray-100 hover:border-[#7DB9DE] hover:shadow-md rounded-2xl text-sm text-left transition-all cursor-pointer text-gray-600 font-medium"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : (
        // --- 對話列表 (Chat List) ---
        // 修正重點 1: 使用 Fragment (<>...</>) 包裹多個元素
        <>
          {messages.map((msg, index) => (
            <div 
              key={index} 
              // (P3b-F1b) scrollToMessage 靠這個屬性定位訊息；樂觀訊息還沒有 id 就不掛
              {...(msg.id ? { 'data-message-id': msg.id } : {})}
              className={`flex gap-4 max-w-4xl mx-auto group ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
            >
              {/* 頭像 */}
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white shadow-sm ${msg.role === 'user' ? 'bg-[#51A8DD]' : 'bg-[#7B90D2]'}`}>
                {msg.role === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
              </div>

              {/* 訊息內容區塊 */}
              <div className={`flex flex-col ${
                msg.role === 'user' 
                  ? 'items-end max-w-[85%] md:max-w-[75%]' // User 保持原本的泡泡寬度限制
                  : 'items-start flex-1 min-w-0 mr-12' // AI 使用 flex-1 填滿右側所有剩餘空間，min-w-0 防止文字溢出破版
              }`}>
                
                <div className="relative group/bubble">
                  {/* 對話框 */}
                  <div className={`
                    px-5 py-3.5 rounded-2xl leading-relaxed shadow-md border-1
                    ${msg.role === 'user' 
                      ? 'bg-[#51A8DD] text-white rounded-tr-none border-[#51A8DD]' 
                      : 'bg-white text-gray-800 rounded-tl-none border border-[#7B90D2]'}
                  `}>
                    {/* (P2-4) 只有 AI 回覆可以「選取文字 → 建立分支」 */}
                    <div
                      className="whitespace-normal break-words text-[15px] overflow-x-auto"
                      onMouseUp={msg.role === 'assistant' ? (e) => handleAssistantMouseUp(e, msg) : undefined}
                    >
                      {msg.content ? (
                        renderContent(msg)
                      ) : (
                        <span className="animate-pulse text-gray-400">Thinking...</span>
                      )}
                    </div>
                  </div>

                  {/* ★★★ 新增：發送時間 (只有 User 顯示) ★★★ */}
                  {msg.role === 'user' && (
                    <div className="text-[11px] text-gray-400 mt-1.5 mr-1 select-none">
                      {formatShortDateTime(msg.created_at) || '剛剛發送'}
                    </div>
                  )}
                </div>

                {/* 模型標籤 */}
                {msg.role === 'assistant' && msg.model_used && (
                  <div className="mt-1.5 ml-1 text-[11px] text-gray-400 flex items-center gap-1 font-mono">
                    <Sparkles className="w-3 h-3 text-gray-400" />
                    {msg.model_used}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* 自動捲動定位點 */}
          <div ref={messagesEndRef} />
        </>
      )}

      {/* ★★★ (P3b-F1a-fix) 懸浮「回到底部」按鈕：只有不在底部且有訊息時才出現 ★★★ */}
      {!isAtBottom && messages.length > 0 && (
        <button
          onClick={scrollToBottomNow}
          title="回到底部"
          aria-label="回到底部"
          className="fixed bottom-24 right-8 z-30 flex items-center justify-center w-10 h-10 text-[#51A8DD] bg-white border border-[#7DB9DE] hover:bg-[#51A8DD] hover:text-white rounded-full shadow-lg transition-colors cursor-pointer"
        >
          <ArrowDown className="w-5 h-5" />
        </button>
      )}

      {/* ★★★ (P2-4) 選取 AI 文字後的浮動「建立分支」按鈕 ★★★ */}
      {/* 注意：不要在這裡攔截 mousedown（例如 e.preventDefault()），否則會吃掉滑鼠預設行為、妨礙選取與複製。
          選取的文字在按鈕出現時已存進 branchSel state，因此 onClick 不需要靠 mousedown 保住選取。 */}
      {branchSel && (
        <button
          ref={branchBtnRef}
          onClick={createBranchFromSelection}
          style={{ left: branchSel.x, top: branchSel.y }}
          className="fixed -translate-x-1/2 -translate-y-full z-50 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#7B90D2] hover:bg-[#51A8DD] rounded-full shadow-lg border border-white/50 transition-colors cursor-pointer"
          title="用選取的文字建立新分支"
        >
          <GitBranch className="w-3.5 h-3.5" />
          建立分支
        </button>
      )}
    </div> 
  );
}

export default MessageList;
