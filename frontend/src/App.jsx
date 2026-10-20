import { useState, useEffect, useCallback } from 'react';
import BranchTreeModal from './BranchTreeModal';
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import BranchPanel from './components/BranchPanel';

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
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [isCustomModel, setIsCustomModel] = useState(false); //即時輸入模型
  const [editingIndex, setEditingIndex] = useState(null); // 哪一則訊息正在被編輯 (index)
  const [editInput, setEditInput] = useState(""); // 編輯框裡的文字
  const [renamingId, setRenamingId] = useState(null); // 正在改名的對話 ID
  const [renameInput, setRenameInput] = useState(""); // 改名輸入框內容
  const [sortBy, setSortBy] = useState("updated"); // 新增：排序狀態 ('updated' = 最新活躍, 'created' = 建立時間)

  const [isTreeModalOpen, setIsTreeModalOpen] = useState(false); // 控制彈出視窗開關
  const [currentTreeRootId, setCurrentTreeRootId] = useState(null); // 目前正在看哪棵樹
  const [lastViewedNodes, setLastViewedNodes] = useState({}); // 記憶每個對話最後點擊的分支節點

  // ★★★ (P2-5) 右側分支面板 ★★★
  // 每條分支各自持有訊息串與輸入框，彼此獨立，不影響主視窗的 messages
  // 形狀：{ id, anchorMessageId, rootMessageId, title, messages, input, isLoading }
  const [branches, setBranches] = useState([]);
  const [activeBranchId, setActiveBranchId] = useState(null);
  const [branchPanelOpen, setBranchPanelOpen] = useState(false);

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

  // ★★★ (P2-5) 分支面板：狀態操作小工具 ★★★
  const updateBranch = useCallback((branchId, updater) => {
    setBranches(prev => prev.map(b => (b.id === branchId ? updater(b) : b)));
  }, []);

  // 取得某條分支的線性訊息 (GET /chats/{root_message_id}/history)
  // 後端是「從子樹裡最新的葉節點往上找祖先」，所以回傳會包含分支起點之前的祖先。
  // 面板只顯示分支自己那一段，因此從 rootMessageId 開始切。
  const loadBranchMessages = useCallback(async (branchId, rootMessageId) => {
    try {
      const res = await fetch(`${API_URL}/chats/${rootMessageId}/history`);
      if (!res.ok) throw new Error("API Error");
      const data = await res.json();
      const startIdx = data.findIndex(m => m.id === rootMessageId);
      const branchMessages = startIdx >= 0 ? data.slice(startIdx) : data;
      setBranches(prev => prev.map(b => {
        if (b.id !== branchId) return b;
        // 剛送出的訊息後端可能還沒寫完，回抓結果比畫面上少時就保留現況，避免訊息被清掉
        if (branchMessages.length < b.messages.length) return b;
        return { ...b, messages: branchMessages };
      }));
    } catch (error) {
      console.error("載入分支訊息失敗:", error);
    }
  }, []);

  // ★★★ (P2-4) 選取 AI 回覆文字 → 建立分支 ★★★
  // (P2-5) 成功後在右側面板開一個新 tab，並載入該分支的訊息
  const handleCreateBranch = async (anchorMessageId, selectedText) => {
    // root_id 一律取目前時間線的第一則訊息 (messages[0])。
    // 剛開始的新對話還沒重新載入歷史，messages[0] 還沒有真正的 id，就沒得建立分支。
    const rootId = messages[0]?.id;
    if (!rootId) {
      alert("請先重新載入對話再建立分支");
      return;
    }

    try {
      const res = await fetch(`${API_URL}/chats/${rootId}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anchor_message_id: anchorMessageId,
          anchor_text: selectedText,
        }),
      });

      if (!res.ok) throw new Error("API Error");

      const data = await res.json();

      // tab 標題：選取文字前 20 字（換行壓成空白）
      const title = selectedText.replace(/\s+/g, " ").trim().slice(0, 20) || "新分支";

      // (P2-10) 分支還不會有任何訊息：選取文字只放進輸入框，等使用者自己送出
      // 同一條分支已經開著就只切換，不重複開 tab
      setBranches(prev => (
        prev.some(b => b.id === data.branch_id)
          ? prev
          : [...prev, {
              id: data.branch_id,
              anchorMessageId: data.anchor_message_id,
              rootMessageId: data.root_message_id, // 後端回 null，等第一則訊息送出後才回填
              title,
              messages: [],
              input: selectedText,
              isLoading: false,
            }]
      ));
      setActiveBranchId(data.branch_id);
      setBranchPanelOpen(true);

      // 更新側邊欄，讓樹狀圖標誌 (has_branch) 出現
      fetchHistory();
    } catch (error) {
      console.error("建立分支失敗:", error);
      alert("建立分支失敗，請檢查後端連線");
    }
  };

  // (P2-5) 在某條分支裡送訊息：parent_id = 該分支最後一則訊息，branch_id = 該分支
  // (P2-10) 分支還沒有任何訊息時，第一則要是 anchor 的子節點
  const sendBranchMessage = async (branchId) => {
    const branch = branches.find(b => b.id === branchId);
    if (!branch || !branch.input.trim() || branch.isLoading) return;

    const content = branch.input;
    const parentId = branch.messages.length > 0
      ? branch.messages[branch.messages.length - 1].id
      : (branch.anchorMessageId || null);

    // 先清空輸入框 + 放上 User 訊息與 AI 佔位符
    updateBranch(branchId, b => ({
      ...b,
      input: "",
      isLoading: true,
      messages: [
        ...b.messages,
        { role: 'user', content },
        { role: 'assistant', content: '', model_used: model },
      ],
    }));

    try {
      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          model: model,
          parent_id: parentId,
          session_id: sessionId,
          branch_id: branchId,
        }),
      });

      if (!response.ok) throw new Error("API Error");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";
      const newMsgId = response.headers.get("X-Message-Id");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        aiResponseText += chunk;

        // 只更新這條分支的最後一則 AI 訊息
        updateBranch(branchId, b => {
          if (b.messages.length === 0) return b;
          const msgs = [...b.messages];
          const lastMsg = msgs[msgs.length - 1];
          if (!lastMsg || lastMsg.role !== 'assistant') return b;
          msgs[msgs.length - 1] = {
            ...lastMsg,
            content: aiResponseText,
            ...(newMsgId ? { id: newMsgId } : {}),
          };
          return { ...b, messages: msgs };
        });
      }
    } catch (error) {
      console.error("分支訊息送出失敗:", error);
      updateBranch(branchId, b => {
        const msgs = [...b.messages];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.content) {
          msgs[msgs.length - 1] = { ...lastMsg, content: "⚠️ 連線錯誤，請檢查後端是否啟動。" };
          return { ...b, messages: msgs };
        }
        return { ...b, messages: [...msgs, { role: 'assistant', content: "⚠️ 連線錯誤，請檢查後端是否啟動。" }] };
      });
    } finally {
      updateBranch(branchId, b => ({ ...b, isLoading: false }));
      // 串流結束後回抓歷史，補上伺服器端的訊息 id（下一則的 parent_id 才會正確）
      // (P2-10) 全新的分支 rootMessageId 還是 null，打 /chats/null/history 只會失敗，直接跳過
      if (branch.rootMessageId) {
        loadBranchMessages(branchId, branch.rootMessageId);
      }
    }
  };

  // (P2-5) 關閉分支 tab；關的是當前分支就切到別支，沒有就回到空狀態
  const closeBranch = (branchId) => {
    const next = branches.filter(b => b.id !== branchId);
    setBranches(next);
    if (activeBranchId === branchId) {
      setActiveBranchId(next.length > 0 ? next[next.length - 1].id : null);
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
          onCreateBranch={handleCreateBranch}
        />

        <ChatInput
          input={input}
          setInput={setInput}
          isLoading={isLoading}
          onSend={handleSend}
        />

      </div>

      {/* ★★★ (P2-5) 右側分支面板（與主視窗並排） ★★★ */}
      {branchPanelOpen && (
        <BranchPanel
          branches={branches}
          activeBranchId={activeBranchId}
          model={model}
          onSelectBranch={setActiveBranchId}
          onCloseBranch={closeBranch}
          onInputChange={(branchId, text) => updateBranch(branchId, b => ({ ...b, input: text }))}
          onSend={sendBranchMessage}
          onToggle={() => setBranchPanelOpen(false)}
        />
      )}

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
