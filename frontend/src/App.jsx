import { useState, useEffect, useCallback } from 'react';
import BranchTreeModal from './BranchTreeModal';
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import BranchPanel from './components/BranchPanel';
import { useModelOptions } from './hooks/useModelOptions';
import { useBranchPanel } from './hooks/useBranchPanel';
import { useMainChat } from './hooks/useMainChat';

import { apiFetch } from './api';


// (G2-6) onRequestLogin：訪客按側欄「登入」時呼叫（AuthGate 顯示登入頁覆蓋層）
// (G2-6) 之後搬移對話與連結 OpenRouter 完成時用來重新讀取 /auth/me（目前尚未使用，見 AuthGate 的 onUserChanged）
// (G2-10) onUserChanged：重新讀取 /auth/me（AuthGate 的 refreshUser，只更新 user，不會重新掛載 App）
function App({ user, onRequestLogin, onUserChanged }) {
  // 清掉舊版的匿名 session id（已改用登入 cookie），只在掛載時執行一次
  useEffect(() => {
    try { localStorage.removeItem('chat_session_id'); } catch { /* 忽略 */ }
  }, []);

  // (G2-10) 是否已連結 OpenRouter（布林值，作為 effect 的依賴）
  const openrouterConnected = user?.openrouter_connected === true;

  // --- 狀態管理 ---
  const [historyList, setHistoryList] = useState([]); // 側邊欄列表
  const { model, setModel, presets, defaultModel, optionsLoading, allowCustom, freeModels, freeModelsLoading, isCustomModel, setIsCustomModel } = useModelOptions(openrouterConnected);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [renamingId, setRenamingId] = useState(null); // 正在改名的對話 ID
  const [renameInput, setRenameInput] = useState(""); // 改名輸入框內容
  const [sortBy, setSortBy] = useState("updated"); // 新增：排序狀態 ('updated' = 最新活躍, 'created' = 建立時間)

  const [isTreeModalOpen, setIsTreeModalOpen] = useState(false); // 控制彈出視窗開關
  const [currentTreeRootId, setCurrentTreeRootId] = useState(null); // 目前正在看哪棵樹
  const [lastViewedNodes, setLastViewedNodes] = useState({}); // 記憶每個對話最後點擊的分支節點

  // 1. 載入側邊欄歷史紀錄 (Roots)
  const fetchHistory = useCallback( async () => {
    try {
      const res = await apiFetch(`/chats/roots?sort_by=${sortBy}`);
      const data = await res.json();
      setHistoryList(data);
    } catch (error) {
      console.error("無法載入歷史紀錄:", error);
    }
  }, [sortBy]); // 依賴 sortBy

  useEffect(() => {
    // (R-6) 這段沒有搬動；App.jsx 變小後 lint 才分析到。fetchHistory 的 setState 在 await 之後，不是同步更新；記在 BUGS B19
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchHistory();
  }, [fetchHistory]); // 當 sortBy 改變時，自動重新載入列表

  // (G2-10) 一次生成結束（送出／重新生成，含分支）：已連結者重新讀取 /auth/me，
  // 金鑰中途被拒時側欄會回到「連結 OpenRouter」。未連結者與訪客不發任何額外請求。
  const refreshAfterGeneration = () => {
    if (openrouterConnected) onUserChanged?.();
  };

  const { branches, activeBranchId, branchPanelOpen, setBranchPanelOpen, branchList, loadBranchList, updateBranch, openBranchFromHighlight, handleCreateBranch, sendBranchMessage, retryBranchMessage, closeBranches, resetBranches } = useBranchPanel({ model, user, fetchHistory, refreshAfterGeneration });
  const { input, setInput, messages, setMessages, isLoading, scrollContainerRef, restoreToken, sendScrollToken, loadChat, startNewChat, handleSend, handleRetry } = useMainChat({ model, user, fetchHistory, refreshAfterGeneration, loadBranchList, closeBranches, setSidebarOpen });

  const openTreeModal = (e, rootId) => {
    e.stopPropagation(); // 防止觸發到父元素的 loadChat
    setCurrentTreeRootId(rootId);
    setIsTreeModalOpen(true);
  };

  // 刪除對話
  const handleDeleteChat = async (e, chatId) => {
    e.stopPropagation(); // 防止觸發 "載入對話"
    
    // 加上簡單的防呆，避免手滑
    if (!confirm("確定要刪除這個對話串嗎？其中的分支也會一起刪除。此動作無法復原。")) return;

    try {
      const res = await apiFetch(`/chats/${chatId}`, { method: 'DELETE' });

      // 401：apiFetch 已通知切換到登入頁，這裡不提示也不改狀態
      if (res.status === 401) return;

      // 404 代表對話已不存在（例如另一個分頁已刪除），視同成功
      if (!res.ok && res.status !== 404) {
        alert("刪除失敗，請稍後再試");
        return;
      }

      // ★★★ 清理後的邏輯 ★★★
      // 如果現在畫面上顯示的對話 (messages[0]) 就是我們剛刪除的那個 (chatId)
      // 那就清空畫面，回到 "New Chat" 狀態，並關閉分支面板、清空分支狀態
      if (messages.length > 0 && messages[0].id === chatId) {
         startNewChat();
         resetBranches();
      }

      // 重新抓取側邊欄列表
      fetchHistory();
    } catch (error) {
      console.error("刪除失敗", error);
      alert("刪除失敗，請稍後再試");
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
        const renameRes = await apiFetch(`/chats/${renamingId}/title`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: renameInput })
        });
        if (renameRes.status === 429) { // (B13)
          alert("操作太頻繁，請稍後再試");
          return;
        }
        
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
    // (B5) 手機 100vh 比可見區高（網址列）→ 支援時改用 100dvh；舊瀏覽器退回 100vh
    // 整體背景改為白色，文字改為深色
    <div className="flex h-screen supports-[height:100dvh]:h-dvh bg-white text-gray-800 font-sans overflow-hidden">
      
      <Sidebar
        user={user}
        onRequestLogin={onRequestLogin}
        onUserChanged={onUserChanged} // (G2-10)
        sidebarOpen={sidebarOpen}
        activeChatId={messages[0]?.id ?? null}
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
        onCloseSidebar={() => setSidebarOpen(false)}
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
          branchPanelOpen={branchPanelOpen}
          setBranchPanelOpen={setBranchPanelOpen}
        />

        <MessageList
          messages={messages}
          isLoading={isLoading}
          setInput={setInput}
          // (R-5) rootId 由 App 傳入：分支 Hook 不讀主對話的 messages
          onCreateBranch={(...args) => handleCreateBranch(messages[0]?.id, ...args)}
          branchList={branchList}
          onOpenBranch={openBranchFromHighlight}
          scrollContainerRef={scrollContainerRef}
          skipAutoScrollToken={restoreToken}
          forceScrollToken={sendScrollToken}
          onRetry={handleRetry}
          // (F9-2) 編輯最後一則 user：把 user、AI 兩則與新內容交給 handleRetry
          onEdit={(userMsg, aiMsg, text) => handleRetry(aiMsg, { userMsg, content: text })}
        />

        <ChatInput
          input={input}
          setInput={setInput}
          isLoading={isLoading}
          onSend={handleSend}
          model={model}
          setModel={setModel}
          isCustomModel={isCustomModel}
          setIsCustomModel={setIsCustomModel}
          freeModels={freeModels}
          freeModelsLoading={freeModelsLoading}
          presets={presets}
          defaultModel={defaultModel}
          optionsLoading={optionsLoading}
          allowCustom={allowCustom}
        />

      </div>

      {/* ★★★ (P2-5) 右側分支面板（與主視窗並排） ★★★ */}
      {branchPanelOpen && (
        <BranchPanel
          branches={branches}
          activeBranchId={activeBranchId}
          model={model}
          setModel={setModel}
          isCustomModel={isCustomModel}
          setIsCustomModel={setIsCustomModel}
          freeModels={freeModels}
          freeModelsLoading={freeModelsLoading}
          presets={presets}
          defaultModel={defaultModel}
          optionsLoading={optionsLoading}
          allowCustom={allowCustom}
          // (E4) 分支列表：目前對話的分支、主對話訊息（排序用）、捲動容器、開啟分支
          branchList={branchList}
          messages={messages}
          scrollContainerRef={scrollContainerRef}
          onOpenBranch={openBranchFromHighlight}
          onInputChange={(branchId, text) => updateBranch(branchId, b => ({ ...b, input: text }))}
          onSend={sendBranchMessage}
          onRetry={retryBranchMessage}
          // (F9-2) 編輯分支最後一則 user：BranchPanel 已補上 branchId
          onEdit={(branchId, userMsg, aiMsg, text) => retryBranchMessage(branchId, aiMsg, { userMsg, content: text })}
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
          // 2. 載入這個節點的對話時間線（(P3b-F1b) 以節點 id 當閱讀位置的 key）
          setCurrentTreeRootId(nodeId);
          loadChat(nodeId, nodeId);
        }}
      />
    </div>
  );
}

export default App;