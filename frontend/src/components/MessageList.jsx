import { useRef, useEffect } from 'react';
import { Send, Bot, User, Pencil, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// 這裡選用 vscDarkPlus 主題，看起來會很像 VS Code 的深色模式
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { formatShortDateTime } from '../dateUtils';
import { handleEnterKey } from '../keyUtils';

// 中間對話視窗：空狀態提示、訊息氣泡（Markdown／程式碼高亮）、分支編輯框
function MessageList({
  messages,
  isLoading,
  editingIndex,
  setEditingIndex,
  editInput,
  setEditInput,
  setInput,
  onBranch,
}) {
  const messagesEndRef = useRef(null);

  // 自動捲動到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth">
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
                
                {/* 編輯模式判斷 */}
                {editingIndex === index ? (
                  <div className="w-full bg-white p-3 rounded-2xl border border-[#7DB9DE] shadow-md animate-in fade-in zoom-in-95 duration-200">
                    <textarea
                      value={editInput}
                      onChange={(e) => setEditInput(e.target.value)}
                      // P3: 手機端（< 768px）Enter 換行；PC 端 Enter 觸發「分支並發送」、Shift + Enter 換行
                      onKeyDown={(e) => handleEnterKey(e, () => onBranch(index))}
                      className="w-full bg-gray-50 text-gray-800 p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-[#7DB9DE] outline-none resize-none text-sm"
                      rows="3"
                      autoFocus
                    />
                    <div className="flex justify-end gap-2 mt-3">
                      <button 
                        onClick={() => setEditingIndex(null)}
                        className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg transition"
                      >
                        取消
                      </button>
                      <button 
                        onClick={() => onBranch(index)}
                        className="px-3 py-1.5 text-xs text-white bg-[#51A8DD] hover:bg-[#7DB9DE] rounded-lg transition flex items-center gap-1 shadow-sm"
                      >
                        <Send className="w-3 h-3" />
                        分支並發送
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="relative group/bubble">
                    {/* 對話框 */}
                    <div className={`
                      px-5 py-3.5 rounded-2xl leading-relaxed shadow-md border-1
                      ${msg.role === 'user' 
                        ? 'bg-[#51A8DD] text-white rounded-tr-none border-[#51A8DD]' 
                        : 'bg-white text-gray-800 rounded-tl-none border border-[#7B90D2]'}
                    `}>
                      <div className="whitespace-normal break-words text-[15px] overflow-x-auto">
                        {msg.content ? (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
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
                                      msg.role === 'user' 
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
                            }}
                          >
                            {msg.content}
                          </ReactMarkdown>
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

                    {/* 鉛筆按鈕 */}
                    {msg.role === 'user' && !isLoading && (
                      <button
                        onClick={() => {
                          setEditingIndex(index);
                          setEditInput(msg.content);
                        }}
                        className="absolute -left-8 top-2 p-1.5 text-gray-400 hover:text-[#51A8DD] bg-white hover:bg-gray-50 rounded-full opacity-0 group-hover/bubble:opacity-100 transition-all shadow border border-gray-200 cursor-pointer"
                        title="編輯並開啟新分支"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}

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
    </div> 
  );
}

export default MessageList;
