import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Settings, Menu, Sparkles } from 'lucide-react';

function App() {
  // --- 狀態管理 (State) ---
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [model, setModel] = useState("gemini-2.5-flash-lite"); // 預設模型
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true); // 控制側邊欄開關

  // 用來自動捲動到底部
  const messagesEndRef = useRef(null);

  // 當訊息更新時，自動捲動到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // --- 發送訊息邏輯 (包含串流處理) ---
  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    // 1. 先把使用者的訊息顯示在畫面上
    const userMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput(""); // 清空輸入框
    setIsLoading(true);

    try {
      // 2. 發送請求給後端
      const response = await fetch('http://localhost:8000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage.content,
          model: model,
          // 這裡暫時設為 null，之後做歷史紀錄側邊欄時再補上
          parent_id: null 
        })
      });

      if (!response.ok) throw new Error("API Error");

      // 3. 準備接收串流 (Streaming)
      // 先放一個空的 AI 訊息佔位
      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 解碼收到的片段
        const chunk = decoder.decode(value, { stream: true });
        aiResponseText += chunk;

        // 4. 即時更新最後一則訊息 (AI 的回答)
        setMessages(prev => {
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          // 確保我們更新的是 assistant 的訊息
          if (lastMsg.role === 'assistant') {
            lastMsg.content = aiResponseText;
          }
          return newMessages;
        });
      }

    } catch (error) {
      console.error("Error:", error);
      setMessages(prev => [...prev, { role: 'assistant', content: "⚠️ 發生錯誤，請稍後再試。" }]);
    } finally {
      setIsLoading(false);
    }
  };

  // 支援按下 Enter 發送
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-screen bg-gray-900 text-gray-100 font-sans overflow-hidden">
      
      {/* --- 左側側邊欄 (Sidebar) --- */}
      {/* 透過 sidebarOpen 控制顯示/隱藏，在手機版也可以用 */}
      <div className={`${sidebarOpen ? 'w-64' : 'w-0'} bg-gray-950 border-r border-gray-800 transition-all duration-300 flex flex-col overflow-hidden`}>
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="font-bold text-lg flex items-center gap-2">
            <Bot className="w-6 h-6 text-blue-500" />
            AI Chat
          </h2>
          {/* 未來這裡可以放「新增對話」按鈕 */}
        </div>
        
        {/* 歷史紀錄列表 (暫位符) */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          <div className="p-3 rounded-lg bg-gray-900/50 hover:bg-gray-800 cursor-pointer text-sm text-gray-400 border border-gray-800/50 transition">
            📅 昨天的對話紀錄 (Demo)
          </div>
          <div className="p-3 rounded-lg hover:bg-gray-800 cursor-pointer text-sm text-gray-400 transition">
            🐍 Python 學習筆記
          </div>
        </div>

        {/* 底部設定區 */}
        <div className="p-4 border-t border-gray-800">
          <button className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition cursor-pointer">
            <Settings className="w-4 h-4" />
            設定
          </button>
        </div>
      </div>

      {/* --- 右側主畫面 (Main Chat) --- */}
      <div className="flex-1 flex flex-col h-full relative">
        
        {/* 頂部導航列 (Top Bar) */}
        <div className="h-16 border-b border-gray-800 flex items-center justify-between px-4 bg-gray-900/95 backdrop-blur z-10">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-gray-800 rounded-lg transition cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <span className="font-medium text-gray-300">New Chat</span>
          </div>

          {/* 模型選擇下拉選單 */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Sparkles className="h-4 w-4 text-yellow-500" />
            </div>
            <select 
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full pl-10 p-2.5 appearance-none cursor-pointer hover:bg-gray-750 transition"
            >
              <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (Fast)</option>
              <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
              <option value="gpt-3.5-turbo">GPT-3.5 Turbo (Mock)</option>
            </select>
          </div>
        </div>

        {/* 中間對話視窗 (Scrollable Area) */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 scroll-smooth">
          {messages.length === 0 ? (
            // 空狀態歡迎畫面
            <div className="h-full flex flex-col items-center justify-center text-gray-500 opacity-60">
              <Bot className="w-16 h-16 mb-4" />
              <p className="text-xl font-medium">今天想聊些什麼？</p>
            </div>
          ) : (
            messages.map((msg, index) => (
              <div 
                key={index} 
                className={`flex gap-4 max-w-3xl mx-auto ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                {/* 頭像 Avatar */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-blue-600' : 'bg-green-600'}`}>
                  {msg.role === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
                </div>

                {/* 訊息框 Bubble */}
                <div className={`
                  px-4 py-3 rounded-2xl max-w-[80%] leading-relaxed shadow-md
                  ${msg.role === 'user' 
                    ? 'bg-blue-600 text-white rounded-tr-none' 
                    : 'bg-gray-800 text-gray-100 rounded-tl-none border border-gray-700'}
                `}>
                  {/* 使用 whitespace-pre-wrap 讓換行符號正常顯示 */}
                  <div className="whitespace-pre-wrap break-words text-sm md:text-base">
                    {msg.content || <span className="animate-pulse">Thinking...</span>}
                  </div>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 底部輸入框區域 (Input Area) */}
        <div className="p-4 border-t border-gray-800 bg-gray-900">
          <div className="max-w-3xl mx-auto relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="輸入訊息..."
              rows="1"
              className="w-full bg-gray-800 text-white rounded-xl pl-4 pr-12 py-3.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50 border border-gray-700 resize-none overflow-hidden"
              style={{ minHeight: '52px' }}
            />
            <button 
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="absolute right-2 bottom-2 p-2 bg-blue-600 hover:bg-blue-500 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <Send className="w-5 h-5 text-white" />
            </button>
          </div>
          <div className="text-center mt-2 text-xs text-gray-500">
            AI 可能會產生不準確的資訊，請核實重要內容。
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;