import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Settings, Menu, Sparkles, Plus, MessageSquare, Pencil,
   X, Trash2, Edit2, Check} from 'lucide-react';

// const API_URL = "http://localhost:8000"; // 本機開發用
const API_URL = "https://ai-chat-backend-ugmu.onrender.com";

function App() {
  // --- 狀態管理 ---
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [historyList, setHistoryList] = useState([]); // 側邊欄列表
  const [model, setModel] = useState("gemini-2.5-flash-lite");
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isCustomModel, setIsCustomModel] = useState(false); //即時輸入模型
  const [editingIndex, setEditingIndex] = useState(null); // 哪一則訊息正在被編輯 (index)
  const [editInput, setEditInput] = useState(""); // 編輯框裡的文字
  const [renamingId, setRenamingId] = useState(null); // 正在改名的對話 ID
  const [renameInput, setRenameInput] = useState(""); // 改名輸入框內容

  const messagesEndRef = useRef(null);

  // 自動捲動到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 1. 載入側邊欄歷史紀錄 (Roots)
  const fetchHistory = async () => {
    try {
      const res = await fetch('${API_URL}/chats/roots');
      const data = await res.json();
      setHistoryList(data);
    } catch (error) {
      console.error("無法載入歷史紀錄:", error);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  // 2. 載入特定對話 (點擊側邊欄觸發)
  const loadChat = async (rootId) => {
    try {
      setIsLoading(true);
      const res = await fetch(`${API_URL}/chats/${rootId}/history`);
      const data = await res.json();
      setMessages(data); // 把舊對話填入畫面
      
      // 在手機版點擊後自動收起側邊欄 (優化體驗)
      if (window.innerWidth < 768) setSidebarOpen(false);
    } catch (error) {
      console.error("載入對話失敗:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // 3. 開啟新對話
  const startNewChat = () => {
    setMessages([]); // 清空畫面
    setInput("");
    // 在手機版自動收起側邊欄
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  // 4. 發送訊息 (核心邏輯)
  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessageContent = input;
    setInput(""); // 馬上清空輸入框，提升體驗
    setIsLoading(true);

    // ★★★ 關鍵邏輯：計算 parent_id ★★★
    // 如果畫面上有訊息，最後一則就是爸爸
    // 如果畫面是空的，爸爸就是 null (代表這是新對話的開頭)
    let parentId = null;
    if (messages.length > 0) {
      parentId = messages[messages.length - 1].id;
    }

    // 先顯示 User 訊息 (用 Date.now() 暫時當 key，等後端回傳真正的 ID 後會更新，但這裡先求簡單)
    setMessages(prev => [...prev, { role: 'user', content: userMessageContent }]);

    try {
      const response = await fetch('${API_URL}/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessageContent,
          model: model,
          parent_id: parentId // <--- 把算好的爸爸 ID 傳出去
        })
      });

      if (!response.ok) throw new Error("API Error");
      
      // 成功發送後，如果是第一則訊息，重新整理側邊欄
      if (messages.length === 0) {
        setTimeout(fetchHistory, 1000);
      }

      // 準備接收串流
      setMessages(prev => [...prev, { role: 'assistant', content: '', model_used: model}]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";
      
      // 讀取 Header 中的 ID (如果有的話，這可以讓我們更精確更新狀態，這邊先略過，用 index 更新)
      // const msgId = response.headers.get("X-Message-Id");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        aiResponseText += chunk;

        // 即時更新最後一則 (AI)
        setMessages(prev => {
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          if (lastMsg.role === 'assistant') {
            lastMsg.content = aiResponseText;
            // 這裡其實應該也要更新 lastMsg.id，但因為我們下次發送是看 UI 上的最後一則，
            // 只要後端有存對，這裡沒 ID 暫時沒關係。
            // 為了嚴謹，若要連續對話不重新整理，後端回傳 ID 還是最好的。
            // 但目前的 MVP 邏輯：我們是「盲接」，只要有內容就好。
            // 真正要拿到 ID，需要像上次教的，從 Header 抓 X-Message-Id 並寫入這裡。
            // 為了不讓程式碼太複雜，我們先假設「使用者不會在 0.1 秒內連續發話」。
            // (進階做法：把後端回傳的 ID 補進這個 Object)
          }
          return newMessages;
        });
      }
      
      // 串流結束後，為了確保 parent_id 正確 (因為剛剛只有 content 沒有 id)
      // 我們可以偷偷重新載入一次這串對話 (Optional，但最保險)
      // 不過為了流暢度，我們先不做 reload，
      // 等使用者發下一則時，我們還是缺 ID... 啊！這就是問題所在！
      
      // ★★★ 補強：我們必須拿到 AI 回傳的 ID，不然下一句會斷掉！ ★★★
      // 我們上次在 backend 有加 `expose_headers=["X-Message-Id"]` 記得嗎？
      // 現在派上用場了！
      const newMsgId = response.headers.get("X-Message-Id");
      if (newMsgId) {
        setMessages(prev => {
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          lastMsg.id = newMsgId; // <--- 把 ID 補上去！
          return newMessages;
        });
      }

    } catch (error) {
      console.error("Error:", error);
      setMessages(prev => [...prev, { role: 'assistant', content: "⚠️ 連線錯誤，請檢查後端是否啟動。" }]);
    } finally {
      setIsLoading(false);
    }
  };

  // ★★★ 核心功能：從中途分支 (Branching) ★★★
  const handleBranch = async (index) => {
    if (!editInput.trim() || isLoading) return;

    // 1. 準備新的歷史紀錄 (Time Travel)
    // 我們只保留 index 之前的訊息 (0 ~ index-1)
    // 例如在 index=2 (Q2) 分支，我們保留 index 0, 1 (Q1, A1)
    const prevMessages = messages.slice(0, index);
    
    // 2. 算出新的 parent_id
    // 如果 prevMessages 是空的，代表我們改的是第一則訊息，所以 parent_id = null
    // 否則，parent_id 就是上一則訊息 (A1) 的 ID
    let parentId = null;
    if (prevMessages.length > 0) {
      parentId = prevMessages[prevMessages.length - 1].id;
    }

    // 3. 更新畫面：切斷舊未來，插入新現在
    const newUserMsg = { role: 'user', content: editInput };
    setMessages([...prevMessages, newUserMsg]);
    
    // 退出編輯模式
    setEditingIndex(null);
    setEditInput("");
    setIsLoading(true);

    try {
      // 4. 發送請求 (跟 handleSend 邏輯幾乎一樣)
      const response = await fetch('${API_URL}/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: newUserMsg.content,
          model: model,
          parent_id: parentId // <--- 關鍵！接上正確的父親
        })
      });

      if (!response.ok) throw new Error("API Error");

      // 準備接收串流
      setMessages(prev => [...prev, { role: 'assistant', content: '', model_used: model }]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";
      const newMsgId = response.headers.get("X-Message-Id"); // 抓取新 ID

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        aiResponseText += chunk;

        setMessages(prev => {
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          lastMsg.content = aiResponseText;
          if (newMsgId) lastMsg.id = newMsgId; // 補上 ID
          return newMessages;
        });
      }

    } catch (error) {
      console.error("Error:", error);
      setMessages(prev => [...prev, { role: 'assistant', content: "⚠️ 分支建立失敗" }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 刪除對話
const handleDeleteChat = async (e, chatId) => {
    e.stopPropagation(); // 防止觸發 "載入對話"
    
    // 加上簡單的防呆，避免手滑
    if (!confirm("確定要刪除這個對話串嗎？此動作無法復原。")) return;

    try {
      await fetch(`${API_URL}/chats/${chatId}`, { method: 'DELETE' });
      
      // ★★★ 清理後的邏輯 ★★★
      // 如果現在畫面上顯示的對話 (messages[0]) 就是我們剛刪除的那個 (chatId)
      // 那就清空畫面，回到 "New Chat" 狀態
      if (messages.length > 0 && messages[0].id === chatId) {
         startNewChat();
      }
      
      // 重新抓取側邊欄列表
      fetchHistory();
    } catch (error) {
      console.error("刪除失敗", error);
      alert("刪除失敗，請檢查後端連線");
    }
  };

// 開始重新命名
const startRenaming = (e, chat) => {
  e.stopPropagation();
  setRenamingId(chat.id);
  setRenameInput(chat.title || chat.content); // 預設帶入標題或內容
};

// 提交重新命名
const submitRename = async (e) => {
  e.stopPropagation(); // 防止觸發 click
  if (!renameInput.trim()) return;

  try {
        await fetch(`${API_URL}/chats/${renamingId}/title`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: renameInput })
        });
        
        // ★★★ 新增這段：如果改名的剛好是當前正在看的對話，同步更新畫面上方的標題 ★★★
        if (messages.length > 0 && messages[0].id === renamingId) {
            setMessages(prev => {
                const newMsgs = [...prev];
                newMsgs[0] = { ...newMsgs[0], title: renameInput };
                return newMsgs;
            });
        }
        
        setRenamingId(null);
        fetchHistory();
      } catch (error) {
        console.error("改名失敗", error);
      }
    };

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 font-sans overflow-hidden">
      
      {/* --- 左側側邊欄 --- */}
      <div className={`${sidebarOpen ? 'w-80' : 'w-0'} bg-gray-900 border-r border-gray-800 transition-all duration-300 flex flex-col flex-shrink-0 relative`}>
        
        {/* New Chat 按鈕 */}
        <div className="p-4">
          <button 
            onClick={startNewChat}
            className="w-full flex items-center gap-3 px-4 py-3 bg-gray-800 hover:bg-gray-700 rounded-xl transition border border-gray-700 hover:border-gray-600 text-sm font-medium cursor-pointer"
          >
            <Plus className="w-5 h-5 text-blue-400" />
            New Chat
          </button>
        </div>

        {/* 歷史紀錄標題 */}
        <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Recent
        </div>
        
        {/* 列表區域 */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1 scrollbar-thin scrollbar-thumb-gray-800">
          {historyList.map((chat) => (
            <div key={chat.id} className="group relative">
          {/* 判斷：如果是正在改名的狀態，顯示輸入框 */}
          {renamingId === chat.id ? (
            <div className="p-2 mx-2 bg-gray-800 border border-blue-500 rounded-lg flex items-center gap-2">
              <input
                className="flex-1 bg-transparent text-sm text-white outline-none min-w-0"
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename(e);
                    if (e.key === 'Escape') setRenamingId(null);
                }}
              />
              <button onClick={submitRename} className="text-green-400 hover:text-green-300">
                <Check className="w-4 h-4" />
              </button>
              <button onClick={() => setRenamingId(null)} className="text-gray-400 hover:text-gray-300">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            // 一般狀態：顯示按鈕
            <button 
              onClick={() => loadChat(chat.id)}
              className="w-full text-left p-3 rounded-lg hover:bg-gray-800 group cursor-pointer transition flex items-center gap-3 relative"
            >
              <MessageSquare className="w-4 h-4 text-gray-500 group-hover:text-blue-400 transition flex-shrink-0" />
              <div className="flex-1 min-w-0 pr-6"> {/* pr-6 留空間給 hover 按鈕 */}
                <div className="text-sm text-gray-300 group-hover:text-white truncate transition font-medium">
                  {/* ★★★ 優先顯示 Title，沒有才顯示 Content ★★★ */}
                  {chat.title || chat.content}
                </div>
                <div className="text-xs text-gray-600 truncate mt-0.5">
                   {new Date(chat.created_at + (chat.created_at.endsWith("Z") ? "" : "Z")).toLocaleString('zh-TW', {
                    timeZone: 'Asia/Taipei',
                    hour12: false, // 24小時制
                    year: 'numeric',
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  })}
                </div>
              </div>

              {/* ★★★ 懸停操作按鈕 (Group Hover Actions) ★★★ */}
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-gray-800/90 rounded-md p-1 shadow-md">
                <div 
                  onClick={(e) => startRenaming(e, chat)}
                  className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded cursor-pointer"
                  title="重新命名"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </div>
                <div 
                  onClick={(e) => handleDeleteChat(e, chat.id)}
                  className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded cursor-pointer"
                  title="刪除對話"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </div>
              </div>
            </button>
          )}
        </div>
      ))}
        </div>

        {/* 底部設定區 */}
        <div className="p-4 border-t border-gray-800 bg-gray-900/50">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 flex items-center justify-center font-bold text-xs">
              ME
            </div>
            <div className="text-sm font-medium">User</div>
            <Settings className="w-4 h-4 ml-auto text-gray-500 cursor-pointer hover:text-white" />
          </div>
        </div>
      </div>

      {/* --- 右側主畫面 --- */}
      <div className="flex-1 flex flex-col h-full relative min-w-0 bg-gray-950">
        
        {/* 頂部導航列 */}
        <div className="h-14 border-b border-gray-800 flex items-center justify-between px-4 bg-gray-950/80 backdrop-blur z-10 sticky top-0">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            {/* 標題顯示區域 */}
            <span className="font-medium text-gray-200 truncate max-w-[150px] md:max-w-md">
              {messages.length > 0 ? (
                // 有對話時：優先顯示 title，沒有則顯示內容摘要
                messages[0].title || messages[0].content.slice(0, 20) + (messages[0].content.length > 20 ? "..." : "")
              ) : (
                // 沒對話時 (New Chat)
                "AI Chat"
              )}
            </span>
          </div>

          <div className="relative">
              {/* --- 模型選擇區 (支援下拉與手動輸入) --- */}
            <div className="relative flex items-center gap-2">
              
              {/* 裝飾用的小星星 Icon */}
              <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none z-10">
                <Sparkles className="h-3.5 w-3.5 text-yellow-500" />
              </div>

              {!isCustomModel ? (
                // 模式 A：下拉選單
                <select 
                  value={model}
                  onChange={(e) => {
                    if (e.target.value === "custom") {
                      setIsCustomModel(true);
                      setModel(""); // 清空，讓使用者準備輸入
                    } else {
                      setModel(e.target.value);
                    }
                  }}
                  className="bg-gray-800 border border-gray-700 text-gray-200 text-xs md:text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-40 md:w-56 pl-8 p-2 appearance-none cursor-pointer hover:bg-gray-750 transition"
                >
                  <optgroup label="Google (原生 API)">
                    <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                  </optgroup>
                  <optgroup label="OpenRouter (需儲值/免費)">
                    <option value="arcee-ai/trinity-large-preview:free">arcee-ai/trinity-large-preview:free</option>
                    <option value="nvidia/nemotron-3-nano-30b-a3b:free">nvidia/nemotron-3-nano-30b-a3b:free</option>
                    <option value="stepfun/step-3.5-flash:free">stepfun/step-3.5-flash:free</option>
                    <option value="deepseek/deepseek-r1-0528:free">deepseek/deepseek-r1-0528:free</option>
                    <option value="openai/gpt-4o-mini">GPT-4o Mini</option>
                    <option value="anthropic/claude-opus-4.6">claude-opus-4.6</option>
                  </optgroup>
                  <optgroup label="進階功能">
                    {/* 這個選項是切換到輸入框的鑰匙 */}
                    <option value="custom">✨ 自訂輸入 (貼上模型 ID)...</option>
                  </optgroup>
                </select>
              ) : (
                // 模式 B：手動輸入框
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="例如: qwen/qwen-2.5-72b..."
                    className="bg-gray-900 border border-blue-500/50 text-gray-100 text-xs md:text-sm rounded-lg focus:ring-2 focus:ring-blue-500 block w-40 md:w-56 pl-8 p-2 transition outline-none shadow-inner"
                    autoFocus // 切換過來時自動聚焦
                  />
                  <button
                    onClick={() => {
                      setIsCustomModel(false);
                      setModel("gemini-2.5-flash-lite"); // 取消時切回預設模型
                    }}
                    className="text-gray-400 hover:text-white text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded transition cursor-pointer"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 對話視窗 */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth">
          {messages.length === 0 ? (
            // --- 空狀態 (Empty State) ---
            <div className="h-full flex flex-col items-center justify-center text-gray-500 space-y-4">
              <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center mb-2">
                <Bot className="w-8 h-8 text-blue-400" />
              </div>
              <p className="text-xl font-medium text-gray-300">今天想聊些什麼？</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-lg px-4">
                {['解釋一下 Docker 是什麼', '寫一個 Python 爬蟲範例', '給我一個健身計畫', '講個笑話'].map(suggestion => (
                  <button 
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="p-3 bg-gray-900 border border-gray-800 hover:bg-gray-800 rounded-xl text-sm text-left transition cursor-pointer"
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
                  className={`flex gap-4 max-w-3xl mx-auto group ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                >
                  {/* 頭像 */}
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-blue-600' : 'bg-emerald-600'}`}>
                    {msg.role === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
                  </div>

                  {/* 訊息內容區塊 */}
                  <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} max-w-[85%] md:max-w-[75%]`}>
                    
                    {/* 編輯模式判斷 */}
                    {editingIndex === index ? (
                      <div className="w-full bg-gray-800 p-3 rounded-2xl border border-blue-500/50 shadow-lg animate-in fade-in zoom-in-95 duration-200">
                        <textarea
                          value={editInput}
                          onChange={(e) => setEditInput(e.target.value)}
                          className="w-full bg-gray-900 text-white p-3 rounded-xl border border-gray-700 focus:ring-2 focus:ring-blue-500 outline-none resize-none text-sm"
                          rows="3"
                          autoFocus
                        />
                        <div className="flex justify-end gap-2 mt-3">
                          <button 
                            onClick={() => setEditingIndex(null)}
                            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded-lg transition"
                          >
                            取消
                          </button>
                          <button 
                            onClick={() => handleBranch(index)}
                            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition flex items-center gap-1"
                          >
                            <Send className="w-3 h-3" />
                            分支並發送
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="relative group/bubble">
                        <div className={`
                          px-5 py-3.5 rounded-2xl leading-relaxed shadow-sm
                          ${msg.role === 'user' 
                            ? 'bg-blue-600 text-white rounded-tr-none' 
                            : 'bg-gray-800 text-gray-100 rounded-tl-none border border-gray-700'}
                        `}>
                          <div className="whitespace-pre-wrap break-words text-[15px]">
                            {msg.content || <span className="animate-pulse text-gray-400">Thinking...</span>}
                          </div>
                        </div>

                        {/* 鉛筆按鈕 */}
                        {msg.role === 'user' && !isLoading && (
                          <button
                            onClick={() => {
                              setEditingIndex(index);
                              setEditInput(msg.content);
                            }}
                            className="absolute -left-8 top-2 p-1.5 text-gray-500 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-full opacity-0 group-hover/bubble:opacity-100 transition-all shadow-sm border border-gray-700 cursor-pointer"
                            title="編輯並開啟新分支"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}

                    {/* 模型標籤 */}
                    {msg.role === 'assistant' && msg.model_used && (
                      <div className="mt-1.5 ml-1 text-[11px] text-gray-500 flex items-center gap-1 font-mono">
                        <Sparkles className="w-3 h-3 text-gray-600" />
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
        </div> {/* 修正重點 2: 這裡才是 overflow-y-auto 的結束標籤 */}

        {/* 輸入框 */}
        <div className="p-4 border-t border-gray-800 bg-gray-950">
          <div className="max-w-3xl mx-auto relative group">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="輸入訊息..."
              rows="1"
              className="w-full bg-gray-900 text-gray-100 rounded-2xl pl-5 pr-14 py-4 focus:outline-none focus:ring-1 focus:ring-blue-500/50 border border-gray-800 group-hover:border-gray-700 transition resize-none shadow-lg"
              style={{ minHeight: '56px' }}
            />
            <button 
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="absolute right-2 bottom-2 p-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-md"
            >
              <Send className="w-5 h-5 text-white" />
            </button>
          </div>
          <div className="text-center mt-3 text-xs text-gray-600">
            Powered by Gemini 2.5 & FastAPI
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;