import { useState, useEffect, useCallback } from 'react';
import BranchTreeModal from './BranchTreeModal';
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';

// const API_URL = "http://localhost:8000"; // 本機開發用
// const API_URL = "https://ai-chat-backend-ugmu.onrender.com";
const API_URL = import.meta.env.VITE_API_URL;

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
  const [freeModels, setFreeModels] = useState([]);
  const [freeModelsLoading, setFreeModelsLoading] = useState(true);
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

  // 載入 OpenRouter 免費模型清單
  useEffect(() => {
    fetch(`${API_URL}/api/free-models`)
      .then(res => res.json())
      .then(data => setFreeModels(data.models || []))
      .catch(err => console.error("無法載入免費模型:", err))
      .finally(() => setFreeModelsLoading(false));
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
    // setInput("");
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

    fetchHistory();

    // 先顯示 User 訊息 (用 Date.now() 暫時當 key，等後端回傳真正的 ID 後會更新，但這裡先求簡單)
    setMessages(prev => [
      ...prev, 
      { role: 'user', content: userMessageContent },
      { role: 'assistant', content: '', model_used: model } // 提早顯示 Thinking
    ]);

    fetchHistory();

    try {
      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessageContent,
          model: model,
          parent_id: parentId,
          session_id: sessionId
        })
      });

      if (!response.ok) throw new Error("API Error");
      
      if (messages.length === 0) {
        setTimeout(fetchHistory, 1000);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";
      
      // ★ 修正 1：將 ID 的抓取移到 while 迴圈「之前」，這樣迴圈內才能使用
      const newMsgId = response.headers.get("X-Message-Id");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        aiResponseText += chunk;

        // 即時更新最後一則 (AI)
        setMessages(prev => {
          // 防呆 1：如果畫面已經被清空，直接放棄更新
          if (prev.length === 0) return prev; 
          
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          
          // 防呆 2：確保最後一則訊息存在，且真的是 AI 的回覆
          if (!lastMsg || lastMsg.role !== 'assistant') return prev;

          lastMsg.content = aiResponseText;
          if (newMsgId) lastMsg.id = newMsgId; // 這裡現在可以正常拿到 newMsgId 了
          return newMessages;
        });
      } // ★ 修正 2：補上 while 迴圈的右大括號！

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
    const prevMessages = messages.slice(0, index);
    
    // 2. 算出新的 parent_id
    let parentId = null;
    if (prevMessages.length > 0) {
      parentId = prevMessages[prevMessages.length - 1].id;
    }

    // 3. 更新畫面：切斷舊未來，插入新現在，並立刻放入 AI 佔位符 (合併成一次更新)
    const newUserMsg = { role: 'user', content: editInput };
    setMessages([
      ...prevMessages, 
      newUserMsg,
      { role: 'assistant', content: '', model_used: model } // 一口氣放進去
    ]);

    // 退出編輯模式
    setEditingIndex(null);
    setEditInput("");
    setIsLoading(true);

    try {
      // 4. 發送請求
      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: newUserMsg.content,
          model: model,
          parent_id: parentId,
          session_id: sessionId
        })
      });

      if (!response.ok) throw new Error("API Error");
      
      // 更新側邊欄讓樹狀圖標誌跑出來
      fetchHistory();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";
      const newMsgId = response.headers.get("X-Message-Id");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        aiResponseText += chunk;

        setMessages(prev => {
          // ★ 防呆 1：如果畫面已經被清空，放棄更新
          if (prev.length === 0) return prev; 
          
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          
          // ★ 防呆 2：確保最後一則真的是 AI 的回覆
          if (!lastMsg || lastMsg.role !== 'assistant') return prev;

          lastMsg.content = aiResponseText;
          if (newMsgId) lastMsg.id = newMsgId; 
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
      
      <Sidebar
        sidebarOpen={sidebarOpen}
        historyList={historyList}
        sortBy={sortBy}
        setSortBy={setSortBy}
        renamingId={renamingId}
        setRenamingId={setRenamingId}
        renameInput={renameInput}
        setRenameInput={setRenameInput}
        lastViewedNodes={lastViewedNodes}
        onStartNewChat={startNewChat}
        onLoadChat={loadChat}
        onOpenTreeModal={openTreeModal}
        onDeleteChat={handleDeleteChat}
        onStartRenaming={startRenaming}
        onSubmitRename={submitRename}
      />

      {/* --- 右側主畫面 --- */}
      {/* 加上指定的淺灰色網格背景 */}
      <div className="flex-1 flex flex-col h-full relative min-w-0 bg-[#E8F1F5] bg-[linear-gradient(to_right,#d3e3eb_1px,transparent_1px),linear-gradient(to_bottom,#d3e3eb_1px,transparent_1px)] bg-[size:16px_16px]">
        
        <ChatHeader
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          messages={messages}
          model={model}
          setModel={setModel}
          isCustomModel={isCustomModel}
          setIsCustomModel={setIsCustomModel}
          freeModels={freeModels}
          freeModelsLoading={freeModelsLoading}
        />

        <MessageList
          messages={messages}
          isLoading={isLoading}
          editingIndex={editingIndex}
          setEditingIndex={setEditingIndex}
          editInput={editInput}
          setEditInput={setEditInput}
          setInput={setInput}
          onBranch={handleBranch}
        />

        <ChatInput
          input={input}
          setInput={setInput}
          isLoading={isLoading}
          onSend={handleSend}
        />

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
