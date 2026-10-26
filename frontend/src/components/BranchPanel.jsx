import { useRef, useEffect, useState } from 'react';
import { Send, Bot, User, GitBranch, X, PanelRightClose } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { handleEnterKey } from '../keyUtils';

// (P2-5) 右側分支面板：多 tab 切換、各分支獨立訊息串與獨立輸入框
// props:
//   branches          [{ id, rootMessageId, title, messages, input, isLoading }]
//   activeBranchId    目前選中的分支 id（null = 沒有開啟任何分支）
//   model             當前模型名稱（僅顯示用）
//   onSelectBranch(id)
//   onCloseBranch(id)
//   onInputChange(id, text)
//   onSend(id)
//   onToggle()        收起整個面板
function BranchPanel({
  branches,
  activeBranchId,
  model,
  onSelectBranch,
  onCloseBranch,
  onInputChange,
  onSend,
  onToggle,
}) {
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  // 面板寬度（可拖曳調整）：佔視窗寬度 20% ~ 50%，以百分比儲存並持久化
  const MIN_PANEL_PERCENT = 20;
  const MAX_PANEL_PERCENT = 50;
  const DEFAULT_PANEL_PERCENT = 25;
  const PANEL_WIDTH_STORAGE_KEY = 'ct-chat:branchPanelWidthPercent';

  const clampPanelPercent = (percent) =>
    Math.min(MAX_PANEL_PERCENT, Math.max(MIN_PANEL_PERCENT, percent));

  // 從 localStorage 還原（掛載時讀取一次），無效值則回退預設
  const [panelPercent, setPanelPercent] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
      if (Number.isFinite(stored) && stored > 0) return clampPanelPercent(stored);
    } catch {
      // localStorage 不可用時忽略
    }
    return DEFAULT_PANEL_PERCENT;
  });
  const [isResizing, setIsResizing] = useState(false);
  // P3b-F5：手機（< 768px）不套用 inline 百分比寬度
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 寬度變動時寫回 localStorage
  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(panelPercent));
    } catch {
      // localStorage 不可用時忽略
    }
  }, [panelPercent]);

  const activeBranch = branches.find((b) => b.id === activeBranchId) || null;

  // 拖曳時在 window 上監聽 pointermove / pointerup，並鎖住文字選取
  useEffect(() => {
    if (!isResizing) return undefined;

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    // 面板貼齊視窗右側，寬度換算成視窗寬度的百分比
    const handlePointerMove = (e) => {
      const viewportWidth = window.innerWidth || 1;
      const percent = ((viewportWidth - e.clientX) / viewportWidth) * 100;
      setPanelPercent(clampPanelPercent(percent));
    };
    const handlePointerUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [isResizing]);

  // 視窗大小改變時把百分比拉回可用範圍內
  useEffect(() => {
    const handleWindowResize = () => {
      setPanelPercent((percent) => clampPanelPercent(percent));
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  const handleResizeStart = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsResizing(true);
  };

  // 切換分支或新訊息進來時，自動捲到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeBranchId, activeBranch?.messages]);

  // 輸入框自動高度
  useEffect(() => {
    if (!textareaRef.current) return;
    if (!activeBranch?.input?.trim()) {
      textareaRef.current.style.height = '40px';
      return;
    }
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight + 2, 120)}px`;
  }, [activeBranch?.input, activeBranchId]);

  return (
    // P3b-F5：手機（< 768px）滿版覆蓋（fixed）；桌面（md 以上）維持並排的百分比寬度。
    // 桌面寬度用 inline style；手機不設 inline 寬度，由 w-full 決定。
    <aside
      style={isDesktop ? { width: `${panelPercent}%` } : undefined}
      className="fixed inset-0 z-40 w-full md:z-auto md:inset-auto md:h-full md:w-auto md:relative flex flex-shrink-0 h-full flex-col bg-white/95 border-l border-[#7DB9DE]/60 shadow-[-4px_0_12px_rgba(81,168,221,0.06)]"
    >
      {/* --- 左側拖曳把手：調整面板寬度（僅桌面） --- */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖曳調整分支面板寬度"
        title="拖曳調整寬度"
        onPointerDown={handleResizeStart}
        className={`absolute left-0 top-0 z-10 h-full w-[6px] cursor-col-resize transition-colors hidden md:block ${
          isResizing ? 'bg-[#51A8DD]/60' : 'bg-transparent hover:bg-[#51A8DD]/40'
        }`}
      />

      {/* --- 面板標題 --- */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white/70 backdrop-blur-sm">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-[#7B90D2] flex items-center justify-center flex-shrink-0">
            <GitBranch className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-700 leading-tight">分支對話</p>
            <p className="text-[11px] text-gray-400 font-mono truncate">
              {branches.length > 0 ? `${branches.length} 條分支 · ${model}` : model}
            </p>
          </div>
        </div>
        {onToggle && (
          <button
            onClick={onToggle}
            title="收起分支面板"
            aria-label="收起分支面板"
            className="p-1.5 text-gray-400 hover:text-[#51A8DD] hover:bg-gray-100 rounded-lg transition cursor-pointer flex-shrink-0"
          >
            {/* 手機版用 X（關閉覆蓋層），桌面版用收合圖示 */}
            <X className="w-4 h-4 md:hidden" />
            <PanelRightClose className="w-4 h-4 hidden md:block" />
          </button>
        )}
      </div>

      {/* --- Tab bar --- */}
      {branches.length > 0 && (
        <div className="flex items-stretch gap-1 px-2 py-2 overflow-x-auto border-b border-gray-200 bg-gray-50/70">
          {branches.map((b) => {
            const isActive = b.id === activeBranchId;
            return (
              <div
                key={b.id}
                onClick={() => onSelectBranch(b.id)}
                title={b.title}
                className={`group/tab flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-lg text-xs cursor-pointer border transition flex-shrink-0 max-w-[160px] ${
                  isActive
                    ? 'bg-[#51A8DD] text-white border-[#51A8DD] shadow-sm'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-[#7DB9DE] hover:text-[#3D9AD1]'
                }`}
              >
                {b.isLoading && (
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse flex-shrink-0" />
                )}
                <span className="truncate">{b.title || '未命名分支'}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseBranch(b.id);
                  }}
                  title="關閉這個分支"
                  className={`p-0.5 rounded transition flex-shrink-0 cursor-pointer ${
                    isActive ? 'hover:bg-white/25' : 'hover:bg-gray-200'
                  }`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* --- 訊息區 --- */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-4 scroll-smooth">
        {!activeBranch ? (
          // 空狀態：沒有開啟任何分支
          <div className="h-full flex flex-col items-center justify-center text-center px-6 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-[#7B90D2]/15 flex items-center justify-center">
              <GitBranch className="w-6 h-6 text-[#7B90D2]" />
            </div>
            <p className="text-sm font-medium text-gray-600">尚未開啟分支</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              在主對話中選取一段 AI 回覆，按「建立分支」，
              <br />
              就能在這裡展開一條獨立的對話。
            </p>
          </div>
        ) : activeBranch.messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-gray-400">
            這條分支還沒有訊息
          </div>
        ) : (
          <>
            {activeBranch.messages.map((msg, idx) => (
              <div
                key={msg.id || `tmp-${idx}`}
                className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-white mt-0.5 ${
                    msg.role === 'user' ? 'bg-[#51A8DD]' : 'bg-[#7B90D2]'
                  }`}
                >
                  {msg.role === 'user' ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                </div>

                <div
                  className={`min-w-0 max-w-[85%] px-3 py-2 rounded-xl text-[13px] leading-relaxed shadow-sm border ${
                    msg.role === 'user'
                      ? 'bg-[#51A8DD] text-white border-[#51A8DD] rounded-tr-none'
                      : 'bg-white text-gray-800 border-[#7B90D2]/60 rounded-tl-none'
                  }`}
                >
                  {msg.content ? (
                    <div className="whitespace-normal break-words overflow-x-auto">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code({ inline, className, children, ...props }) {
                            const match = /language-(\w+)/.exec(className || '');
                            return !inline && match ? (
                              <SyntaxHighlighter
                                style={vscDarkPlus}
                                language={match[1]}
                                PreTag="div"
                                className="rounded-lg my-2 text-xs"
                                {...props}
                              >
                                {String(children).replace(/\n$/, '')}
                              </SyntaxHighlighter>
                            ) : (
                              <code
                                className={`px-1 py-0.5 rounded font-mono text-[12px] ${
                                  msg.role === 'user' ? 'bg-blue-600/50 text-white' : 'bg-gray-100 text-[#E83E8C]'
                                }`}
                                {...props}
                              >
                                {children}
                              </code>
                            );
                          },
                          p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
                          ul: ({ children }) => <ul className="list-disc ml-4 mb-2 space-y-0.5">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal ml-4 mb-2 space-y-0.5">{children}</ol>,
                          li: ({ children }) => <li className="pl-0.5">{children}</li>,
                          h1: ({ children }) => <h1 className="text-base font-bold mb-2 mt-3">{children}</h1>,
                          h2: ({ children }) => <h2 className="text-sm font-bold mb-2 mt-3">{children}</h2>,
                          h3: ({ children }) => <h3 className="text-[13px] font-bold mb-1 mt-2">{children}</h3>,
                          a: ({ children, href }) => (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              className="underline underline-offset-2 hover:opacity-80"
                            >
                              {children}
                            </a>
                          ),
                          blockquote: ({ children }) => (
                            <blockquote className="border-l-2 border-gray-300 pl-2 my-2 text-gray-600 bg-gray-50 rounded-r">
                              {children}
                            </blockquote>
                          ),
                          table: ({ children }) => (
                            <div className="overflow-x-auto my-2">
                              <table className="min-w-full text-xs divide-y divide-gray-200 border border-gray-200">
                                {children}
                              </table>
                            </div>
                          ),
                          th: ({ children }) => (
                            <th className="px-2 py-1 bg-gray-50 text-left font-semibold border-b">{children}</th>
                          ),
                          td: ({ children }) => <td className="px-2 py-1 border-b">{children}</td>,
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <span className="animate-pulse text-gray-400">Thinking...</span>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* --- 底部輸入框（只在有分支時出現） --- */}
      {activeBranch && (
        <div className="p-3 border-t border-gray-200 bg-white/80 backdrop-blur-sm">
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={activeBranch.input}
              onChange={(e) => onInputChange(activeBranch.id, e.target.value)}
              onKeyDown={(e) => handleEnterKey(e, () => onSend(activeBranch.id))}
              placeholder={activeBranch.isLoading ? '等待回覆中...' : '在這個分支繼續對話...'}
              rows="1"
              className="w-full bg-white text-gray-800 text-[13px] rounded-xl pl-3 pr-11 py-2.5 focus:outline-none focus:ring-2 focus:ring-[#51A8DD]/40 border border-gray-200 hover:border-[#7DB9DE] transition resize-none shadow-sm max-h-[120px] overflow-y-auto"
              style={{ minHeight: '40px' }}
            />
            <button
              onClick={() => onSend(activeBranch.id)}
              disabled={activeBranch.isLoading || !activeBranch.input.trim()}
              title="送出（Enter）"
              className="absolute right-1.5 bottom-[7px] p-2 bg-[#51A8DD] hover:bg-[#3D9AD1] rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-sm"
            >
              <Send className="w-4 h-4 text-white" />
            </button>
          </div>
          <p className="mt-2 text-[10px] text-gray-400 text-center">
            分支訊息與主對話各自獨立，不會影響原本的時間線
          </p>
        </div>
      )}
    </aside>
  );
}

export default BranchPanel;
