import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, Settings, Menu, Sparkles, Plus, MessageSquare, Pencil,
   X, Trash2, Edit2, Check, ArrowUpDown} from 'lucide-react';
import { TbBinaryTree2 } from 'react-icons/tb';
import BranchTreeModal from './BranchTreeModal';

const API_URL = "http://localhost:8000"; // 本機開發用
// const API_URL = "https://ai-chat-backend-ugmu.onrender.com";

function App() {
  // --- 狀態管理 ---
  const [sessionId] = useState(() => {
    let sid = localStorage.getItem("chat_session_id");
    if (!sid) {
      sid = "sess_" + Math.random().toString(36).substring(2, 15);
      localStorage.setItem("chat_session_id", sid);
    }
    return sid;
  });
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
  const [sortBy, setSortBy] = useState("updated"); // 新增：排序狀態 ('updated' = 最新活躍, 'created' = 建立時間)

  const [isTreeModalOpen, setIsTreeModalOpen] = useState(false); // 控制彈出視窗開關
  const [currentTreeRootId, setCurrentTreeRootId] = useState(null); // 目前正在看哪棵樹
  const [lastViewedNodes, setLastViewedNodes] = useState({}); // 記憶每個對話最後點擊的分支節點

  const messagesEndRef = useRef(null);

  // 自動捲動到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 1. 載入側邊欄歷史紀錄 (Roots)
  const fetchHistory = useCallback( async () => {
    try {
      const res = await fetch(`${API_URL}/chats/roots?session_id=${sessionId}&sort_by=${sortBy}`);
      const data = await res.json();
      setHistoryList(data);
    } catch (error) {
      console.error("無法載入歷史紀錄:", error);
    }
  }, [sessionId, sortBy]); // 依賴 sessionId 和 sortBy

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]); // 當 sortBy 改變時，自動重新載入列表

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

  const openTreeModal = (e, rootId) => {
    e.stopPropagation(); // 防止觸發到父元素的 loadChat
    setCurrentTreeRootId(rootId);
    setIsTreeModalOpen(true);
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
      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessageContent,
          model: model,
          parent_id: parentId, // <--- 把算好的爸爸 ID 傳出去
          session_id: sessionId
        })
      });

      if (!response.ok) throw new Error("API Error");
      
      // 成功發送後，如果是第一則訊息，重新整理側邊欄
      if (messages.length === 0) {
        setTimeout(fetchHistory, 1000);
      }

      fetchHistory();

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
      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: newUserMsg.content,
          model: model,
          parent_id: parentId, // <--- 關鍵！接上正確的父親
          session_id: sessionId
        })
      });

      if (!response.ok) throw new Error("API Error");
      fetchHistory();

      // 抓取新 ID
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
    // 整體背景改為白色，文字改為深色
    <div className="flex h-screen bg-white text-gray-800 font-sans overflow-hidden">
      
      {/* --- 左側側邊欄 --- */}
      {/* 套用指定的更淺灰藍色 #E8F1F5 */}
      <div className={`${sidebarOpen ? 'w-80' : 'w-0'} bg-[#E8F1F5] border-r border-gray-300 transition-all duration-300 flex flex-col flex-shrink-0 relative`}>
        
        {/* New Chat 按鈕 */}
        <div className="p-4">
          <button 
            onClick={startNewChat}
            className="w-full flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50 rounded-xl transition border border-gray-300 hover:border-[#7DB9DE] text-sm font-medium cursor-pointer shadow-sm text-gray-700 group"
          >
            <Plus className="w-5 h-5 text-[#7DB9DE]" />
            New Chat
          </button>
        </div>

        {/* 歷史紀錄標題與排序按鈕 */}
        <div className="px-4 py-2 flex items-center justify-between">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">
            Recent
          </div>
          <button 
            onClick={() => setSortBy(prev => prev === 'updated' ? 'created' : 'updated')}
            className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-[#7DB9DE] transition cursor-pointer"
            title="切換排序方式"
          >
            <ArrowUpDown className="w-3 h-3" />
            {sortBy === 'updated' ? '依最新回覆' : '依建立日期'}
          </button>
        </div>
        
        {/* 列表區域 */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1 scrollbar-thin scrollbar-thumb-gray-300">
          {historyList.map((chat) => (
            <div key={chat.id} className="group relative">
          {/* 判斷：如果是正在改名的狀態，顯示輸入框 */}
          {renamingId === chat.id ? (
            <div className="p-2 mx-2 bg-white border border-[#7DB9DE] rounded-lg flex items-center gap-2 shadow-sm">
              <input
                className="flex-1 bg-transparent text-sm text-gray-800 outline-none min-w-0"
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename(e);
                    if (e.key === 'Escape') setRenamingId(null);
                }}
              />
              <button onClick={submitRename} className="text-green-500 hover:text-green-600">
                <Check className="w-4 h-4" />
              </button>
              <button onClick={() => setRenamingId(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            // 一般狀態：顯示按鈕
            <button 
              onClick={() => loadChat(lastViewedNodes[chat.id] || chat.id)}
              className="w-full text-left p-3 rounded-lg hover:bg-white/60 group cursor-pointer transition flex items-center gap-3 relative"
            >
              {/* ★★★ 修改這裡：判斷是否有分支來決定圖示 ★★★ */}
              {chat.has_branch ? (
                <div 
                  onClick={(e) => openTreeModal(e, chat.id)}
                  className="p-0.5 hover:bg-[#D8E6F0] rounded-md transition z-10 relative"
                  title="查看對話分支圖"
                >
                <TbBinaryTree2 
                  className="w-4 h-4 text-[#228DCD] hover:text-[#7DB9DE] transition flex-shrink-0" 
                  title="這是一個有分支的對話"
                /></div>
              ) : (
                <MessageSquare className="w-5 h-5 text-gray-500 group-hover:text-[#7DB9DE] transition flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0 pr-6"> {/* pr-6 留空間給 hover 按鈕 */}
                  {/* ★★★ 優先顯示 Title，沒有才顯示 Content ★★★ */}
                <div className="text-sm text-gray-700 group-hover:text-gray-900 truncate transition font-medium">
                  {chat.title || chat.content}
                </div>
                <div className="text-xs text-gray-500 truncate mt-0.5">
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
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 rounded-md p-1 shadow-sm border border-gray-200">
                <div 
                  onClick={(e) => startRenaming(e, chat)}
                  className="p-1.5 text-gray-500 hover:text-[#7DB9DE] hover:bg-gray-100 rounded cursor-pointer"
                  title="重新命名"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </div>
                <div 
                  onClick={(e) => handleDeleteChat(e, chat.id)}
                  className="p-1.5 text-gray-500 hover:text-red-500 hover:bg-gray-100 rounded cursor-pointer"
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
        <div className="p-4 border-t border-gray-300 bg-[#E8F1F5]">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-[#7DB9DE] to-[#7B90D2] flex items-center justify-center font-bold text-xs text-white shadow-sm">
              ME
            </div>
            <div className="text-sm font-medium text-gray-700" >User</div>
              <div title="只是一個齒輪" className="ml-auto">
              <Settings className="w-4 h-4 text-gray-500 hover:text-[#7DB9DE]"/>
              </div>
          </div>
        </div>
      </div>

      {/* --- 右側主畫面 --- */}
      {/* 加上指定的淺灰色網格背景 */}
      <div className="flex-1 flex flex-col h-full relative min-w-0 bg-white bg-[linear-gradient(to_right,#f0f0f0_1px,transparent_1px),linear-gradient(to_bottom,#f0f0f0_1px,transparent_1px)] bg-[size:16px_16px]">
        
        {/* 頂部導航列 */}
        <div className="h-14 border-b border-gray-200 flex items-center justify-between px-4 bg-white/80 backdrop-blur-sm z-10 sticky top-0 shadow-sm">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 text-gray-500 hover:text-[#7DB9DE] hover:bg-gray-100 rounded-lg transition cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            {/* 標題顯示區域 */}
            <span className="font-medium text-gray-800 truncate max-w-[150px] md:max-w-md">
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
                  className="bg-white border border-gray-300 text-gray-700 text-xs md:text-sm rounded-lg focus:ring-[#7DB9DE] focus:border-[#7DB9DE] block w-40 md:w-56 pl-8 p-2 appearance-none cursor-pointer hover:bg-gray-50 transition shadow-sm"
                >
                  <optgroup label="Google (原生 API)">
                    <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                  </optgroup>
                  <optgroup label="OpenRouter (需儲值/免費)">
                    <option value="arcee-ai/trinity-large-preview:free">arcee-ai/trinity-large-preview:free</option>
                    <option value="nvidia/nemotron-3-nano-30b-a3b:free">nvidia/nemotron-3-nano-30b-a3b:free</option>
                    <option value="z-ai/glm-4.5-air:free">z-ai/glm-4.5-air:free</option>
                    <option value="openai/gpt-oss-120b:free">openai/gpt-oss-120b:free</option>
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
                    className="bg-white border border-[#7DB9DE] text-gray-800 text-xs md:text-sm rounded-lg focus:ring-2 focus:ring-[#7DB9DE] block w-40 md:w-56 pl-8 p-2 transition outline-none shadow-sm"
                    autoFocus // 切換過來時自動聚焦
                  />
                  <button
                    onClick={() => {
                      setIsCustomModel(false);
                      setModel("gemini-2.5-flash-lite"); // 取消時切回預設模型
                    }}
                    className="text-gray-500 hover:text-gray-800 text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded transition cursor-pointer"
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
              <div className="w-16 h-16 bg-[#E8F1F5] rounded-2xl flex items-center justify-center mb-2 shadow-sm border border-[#D8E6F0]">
                <Bot className="w-8 h-8 text-[#7DB9DE]" />
              </div>
              <p className="text-xl font-medium text-gray-700">今天想聊些什麼？</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-lg px-4">
                {['解釋一下 Docker 是什麼', '寫一個 Python 爬蟲範例', '給我一個健身計畫', '講個笑話'].map(suggestion => (
                  <button 
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="p-3 bg-white border border-gray-200 hover:bg-[#F4F8FA] hover:border-[#7DB9DE] rounded-xl text-sm text-left transition cursor-pointer shadow-md text-gray-600"
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
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white shadow-sm ${msg.role === 'user' ? 'bg-[#51A8DD]' : 'bg-[#7B90D2]'}`}>
                    {msg.role === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
                  </div>

                  {/* 訊息內容區塊 */}
                  <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} max-w-[85%] md:max-w-[75%]`}>
                    
                    {/* 編輯模式判斷 */}
                    {editingIndex === index ? (
                      <div className="w-full bg-white p-3 rounded-2xl border border-[#7DB9DE] shadow-md animate-in fade-in zoom-in-95 duration-200">
                        <textarea
                          value={editInput}
                          onChange={(e) => setEditInput(e.target.value)}
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
                            onClick={() => handleBranch(index)}
                            className="px-3 py-1.5 text-xs text-white bg-[#51A8DD] hover:bg-[#7DB9DE] rounded-lg transition flex items-center gap-1 shadow-sm"
                          >
                            <Send className="w-3 h-3" />
                            分支並發送
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="relative group/bubble">
                        <div className={`
                          px-5 py-3.5 rounded-2xl leading-relaxed shadow-md border
                          ${msg.role === 'user' 
                            ? 'bg-[#228DCD] text-white rounded-tr-none border-[#228DCD]' 
                            : 'bg-white text-gray-800 rounded-tl-none border-gray-200'}
                        `}>
                          <div className="whitespace-pre-wrap break-words text-[15px]">
                            {msg.content || <span className="animate-pulse text-gray-400">Thinking...</span>}
                          </div>
                        </div>

                        {/* ★★★ 新增：發送時間 (只有 User 顯示) ★★★ */}
                        {msg.role === 'user' && (
                          <div className="text-[11px] text-gray-400 mt-1.5 mr-1 select-none">
                            {msg.created_at ? new Date(msg.created_at + (msg.created_at.endsWith("Z") ? "" : "Z")).toLocaleString('zh-TW', {
                              month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
                            }) : '剛剛發送'}
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

        {/* 輸入框區塊 - 這裡將背景改為透明，融入網格 */}
        <div className="p-4 bg-white/60 backdrop-blur-sm border-t border-gray-200">
          <div className="max-w-3xl mx-auto relative group">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="輸入訊息..."
              rows="1"
              className="w-full bg-white text-gray-800 rounded-2xl pl-5 pr-14 py-4 focus:outline-none focus:ring-2 focus:ring-[#7DB9DE]/50 border border-gray-300 group-hover:border-[#7DB9DE] transition resize-none shadow-md"
              style={{ minHeight: '56px' }}
            />
            <button 
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="absolute right-2 bottom-[15px] p-2.5 bg-[#51A8DD] hover:bg-[#7DB9DE] rounded-xl transition disabled:opacity-80 disabled:cursor-not-allowed cursor-pointer shadow-md"
            >
              <Send className="w-5 h-5 text-white" />
            </button>
          </div>
          <div className="text-center mt-3 text-xs text-gray-400 font-medium">
            Powered by Gemini 2.5 & FastAPI
          </div>
        </div>

      </div>
      {/* ★★★ 放入樹狀圖彈出視窗 ★★★ */}
      <BranchTreeModal 
        isOpen={isTreeModalOpen}
        onClose={() => setIsTreeModalOpen(false)}
        rootId={currentTreeRootId}
        onSelectNode={(nodeId) => {
          // 當使用者在樹狀圖上點擊某個節點時：
          // 1. 記憶這個選擇 (把 currentTreeRootId 對應到被選的 nodeId)
          setLastViewedNodes(prev => ({ ...prev, [currentTreeRootId]: nodeId }));
          // 2. 載入這個節點的對話時間線
          loadChat(nodeId);
        }}
      />
    </div>
  );
}

export default App;