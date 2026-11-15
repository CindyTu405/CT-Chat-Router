import { useState, useEffect, useCallback, useRef } from 'react';
import BranchTreeModal from './BranchTreeModal';
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import BranchPanel from './components/BranchPanel';
import { scrollToMessage } from './scrollUtils';
import { useModelOptions } from './hooks/useModelOptions';
import { useBranchPanel } from './hooks/useBranchPanel';
import { readTextStream } from './readTextStream';

import { apiFetch } from './api';
import { QuotaError, throwIfQuotaError, MAX_MESSAGE_CHARS, TOO_LONG_MSG } from './quotaErrors';


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
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [historyList, setHistoryList] = useState([]); // 側邊欄列表
  const { model, setModel, presets, defaultModel, optionsLoading, allowCustom, freeModels, freeModelsLoading, isCustomModel, setIsCustomModel } = useModelOptions(openrouterConnected);
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [renamingId, setRenamingId] = useState(null); // 正在改名的對話 ID
  const [renameInput, setRenameInput] = useState(""); // 改名輸入框內容
  const [sortBy, setSortBy] = useState("updated"); // 新增：排序狀態 ('updated' = 最新活躍, 'created' = 建立時間)

  const [isTreeModalOpen, setIsTreeModalOpen] = useState(false); // 控制彈出視窗開關
  const [currentTreeRootId, setCurrentTreeRootId] = useState(null); // 目前正在看哪棵樹
  const [lastViewedNodes, setLastViewedNodes] = useState({}); // 記憶每個對話最後點擊的分支節點

  // ★★★ (P3b-F1b) 每個對話的閱讀位置（conversation id → scrollTop）★★★
  // 只放 React state，重新整理頁面就清空；切換對話前存、載入後還原。
  const [readingPositions, setReadingPositions] = useState({});
  // 捲動容器的 ref 由 App 持有，MessageList 用同一個 ref 掛在容器的 div 上
  const scrollContainerRef = useRef(null);
  // 載入對話後要做一次「還原／對齊錨點」，pendingRestore 描述要捲到哪裡；
  // restoreToken 每次載入遞增，讓 MessageList 知道要跳過一次自動捲到底部。
  const [pendingRestore, setPendingRestore] = useState(null); // { convId, scrollTop|null, anchorId|null }
  const [restoreToken, setRestoreToken] = useState(0);
  // ★★★ (P3b) 目前畫面上是哪一串對話（root id），null 代表全新對話 ★★★
  // 串流回來時要比對這個值，避免把上一個對話的回覆寫進剛切換過來的對話。
  const activeRootIdRef = useRef(null);
  // 目前進行中的串流，切換對話時直接中止
  const streamAbortRef = useRef(null);
  // 送出訊息時自動捲動至底部
  const [sendScrollToken, setSendScrollToken] = useState(0);

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
    fetchHistory();
  }, [fetchHistory]); // 當 sortBy 改變時，自動重新載入列表

  // (G2-10) 一次生成結束（送出／重新生成，含分支）：已連結者重新讀取 /auth/me，
  // 金鑰中途被拒時側欄會回到「連結 OpenRouter」。未連結者與訪客不發任何額外請求。
  const refreshAfterGeneration = () => {
    if (openrouterConnected) onUserChanged?.();
  };

  const { branches, activeBranchId, branchPanelOpen, setBranchPanelOpen, branchList, loadBranchList, updateBranch, openBranchFromHighlight, handleCreateBranch, sendBranchMessage, retryBranchMessage, closeBranches, resetBranches } = useBranchPanel({ model, user, fetchHistory, refreshAfterGeneration });

  // 2. 載入特定對話 (點擊側邊欄觸發)

  const loadChat = async (rootId, positionKey = rootId) => {
    // (P3b-F1b) 切換對話前，先把目前對話的捲動位置記下來（key 用這串對話的 root id）
    const currentConvId = messages[0]?.id;
    const container = scrollContainerRef.current;
    if (currentConvId && container && currentConvId !== rootId) {
      const currentTop = container.scrollTop;
      setReadingPositions(prev => ({ ...prev, [currentConvId]: currentTop }));
    }

    try {
      setIsLoading(true);
      // (P3b) 立刻把「目前顯示的對話」切到新的 root id，並中止正在跑的串流，
      // 讓舊對話的後續 chunk 不會再被寫進畫面。
      activeRootIdRef.current = rootId;
      // (P3b-A3) 不再 abort 串流：後端生成在背景 task 裡跑，切走不影響它。
      // 舊的讀取迴圈會因為 activeRootIdRef 已改變而自行停止讀取。
      // 這裡只放掉 ref，讓新對話的送出流程不被舊串流綁住。
      streamAbortRef.current = null;
      setIsLoading(false);
      const res = await apiFetch(`/chats/${rootId}/history`);
      const data = await res.json();

      // (P3b-F1b) 決定載入後要捲到哪：有存過的閱讀位置就還原，
      // 沒有的話（新開的對話 / 重新整理頁面後第一次載入）對齊最後一則 user 訊息
      const list = Array.isArray(data) ? data : [];
      const savedTop = readingPositions[positionKey];
      const lastUserId = [...list].reverse().find(m => m.role === 'user')?.id || null;
      setPendingRestore({
        convId: positionKey,
        scrollTop: typeof savedTop === 'number' ? savedTop : null,
        anchorId: typeof savedTop === 'number' ? null : lastUserId,
      });
      setRestoreToken(t => t + 1);

      setMessages(data); // 把舊對話填入畫面

      // (P2-12) 順便載入分支清單，讓已存在的錨點文字立刻亮起來
      loadBranchList(data?.[0]?.id);
      
      // 在手機版點擊後自動收起側邊欄 (優化體驗)
      if (window.innerWidth < 768) setSidebarOpen(false);

      // (P3b-A3) 最後一則是 AI 且內容還是空的 → 可能還在背景生成，改用續讀接回
      const last = list[list.length - 1];
      if (last && last.role === 'assistant' && !last.content && last.id) {
        resumeGeneration(rootId, last.id);
      }
    } catch (error) {
      console.error("載入對話失敗:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // (P3b-A3) 續讀一則 AI 回覆：從 /messages/{id}/stream 讀取，逐段寫進畫面。
  // 只在「這串對話仍是目前顯示的對話」時寫入，切走就停止寫入。
  const resumeGeneration = async (rootId, messageId) => {
    try {
      const res = await apiFetch(`/messages/${messageId}/stream?offset=0`);
      if (!res.ok || !res.body) return;
      // 切走（activeRootIdRef 不再等於 rootId）就停止讀取與寫入
      await readTextStream(res, {
        shouldStop: () => activeRootIdRef.current !== rootId,
        onText: (text) => setMessages(prev => {
          if (activeRootIdRef.current !== rootId) return prev;
          const next = [...prev];
          const lastMsg = next[next.length - 1];
          if (!lastMsg || lastMsg.id !== messageId) return prev;
          next[next.length - 1] = { ...lastMsg, content: text };
          return next;
        }),
      });
    } catch (error) {
      console.error("續讀失敗:", error);
    }
  };

  // (P3b-F1b) 訊息渲染完成後才做還原／對齊，全部用瞬間定位（不做平滑動畫）。
  // 用 requestAnimationFrame 等版面穩定（Markdown、程式碼高亮會撐高高度）。
  useEffect(() => {
    if (!pendingRestore) return;
    const target = pendingRestore;
    let frame2 = null;
    const frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (target.scrollTop != null) {
          if (container) container.scrollTop = target.scrollTop;
        } else if (target.anchorId) {
          scrollToMessage(target.anchorId, 'auto');
        } else if (container) {
          container.scrollTop = 0;
        }
        setPendingRestore(null);
      });
    });
    return () => {
      cancelAnimationFrame(frame1);
      if (frame2) cancelAnimationFrame(frame2);
    };
  }, [pendingRestore]);

  // 3. 開啟新對話
  const startNewChat = () => {
    // (P3b) 新對話沒有 root id，同時中止上一個對話還在跑的串流
    activeRootIdRef.current = null;
    // (P3b-A3) 不 abort：舊串流在背景繼續生成，切回去時用續讀接回
    streamAbortRef.current = null;
    setIsLoading(false);
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
    if (!input.trim() || isLoading || !model) return;

    if (input.length > MAX_MESSAGE_CHARS) { alert(TOO_LONG_MSG); return; } // (B13)
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
    setSendScrollToken(t => t + 1); // ← 新增:只有自己送出才會遞增

    fetchHistory();

    // ★★★ (P3b) 記下這則訊息是發給哪一串對話的 ★★★
    // 新對話（畫面空）→ null；現有對話 → 用第一則訊息的 id 當 root id。
    // 串流期間使用者若切換對話，activeRootIdRef 會變，這裡的快照就不會再相符。
    const sendConvId = messages[0]?.id ?? null;
    activeRootIdRef.current = sendConvId;
    if (streamAbortRef.current) {
      try { streamAbortRef.current.abort(); } catch { /* ignore */ }
    }
    const abortController = new AbortController();
    streamAbortRef.current = abortController;

    try {
      const response = await apiFetch(`/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          message: userMessageContent,
          model: model,
          parent_id: parentId
        })
      });

      await throwIfQuotaError(response, user);
      if (!response.ok) throw new Error("API Error");
      
      if (messages.length === 0) {
        setTimeout(fetchHistory, 1000);
      }

      
      // ★ 修正 1：將 ID 的抓取移到 while 迴圈「之前」，這樣迴圈內才能使用
      const newMsgId = response.headers.get("X-Message-Id");
      // (G1)(F9-B4) 樂觀塞進來的 user 訊息沒有 id，後端把真正的 id 放在這個 header。
      // 補到「最後一則 assistant 前面、沒有 id 的 user」（倒數第二則），
      // 新對話時就是 index 0，涵蓋原本 G1 的情況；既有對話的後續訊息也能補上。
      const newUserMsgId = response.headers.get("X-User-Message-Id");
      if (newUserMsgId && activeRootIdRef.current === sendConvId) {
        setMessages(prev => {
          if (activeRootIdRef.current !== sendConvId) return prev;
          const len = prev.length;
          if (len < 2) return prev;
          const last = prev[len - 1];
          const userMsg = prev[len - 2];
          if (last?.role !== 'assistant') return prev;
          if (!userMsg || userMsg.role !== 'user' || userMsg.id) return prev;
          const next = [...prev];
          next[len - 2] = { ...userMsg, id: newUserMsgId };
          return next;
        });
      }

      // ★★★ (P3b) 使用者已切換到別的對話 → 停止套用，別把內容寫進別人的對話 ★★★
      // 讀取是非同步的，readTextStream 讀前、讀後各檢查一次
      await readTextStream(response, {
        shouldStop: () => activeRootIdRef.current !== sendConvId,
        onText: (aiResponseText) => setMessages(prev => {
          // 防呆 0：(P3b) 對話已被切換就走人，避免污染新對話
          if (activeRootIdRef.current !== sendConvId) return prev;
          // 防呆 1：如果畫面已經被清空，直接放棄更新
          if (prev.length === 0) return prev; 
          
          const newMessages = [...prev];
          const lastMsg = newMessages[newMessages.length - 1];
          
          // 防呆 2：確保最後一則訊息存在，且真的是 AI 的回覆
          if (!lastMsg || lastMsg.role !== 'assistant') return prev;

          lastMsg.content = aiResponseText;
          if (newMsgId) lastMsg.id = newMsgId; // 這裡現在可以正常拿到 newMsgId 了
          return newMessages;
        }),
      });

    } catch (error) {
      // (P3b) 切換對話造成的 abort 不是錯誤，也不要再往畫面塞訊息
      if (error?.name === 'AbortError' || activeRootIdRef.current !== sendConvId) {
        // 已被切換的對話：靜默結束
      } else if (error instanceof QuotaError) {
        // (V1-2) 額度／速率限制：後端沒寫入，撤掉這次樂觀加入的 user + 空 AI 佔位，文字放回輸入框
        setMessages(prev => {
          const n = prev.length;
          const last = prev[n - 1];
          const userMsg = prev[n - 2];
          const trailingPair = n >= 2 && last?.role === 'assistant' && !last.id && !last.content
            && userMsg?.role === 'user' && !userMsg.id;
          return trailingPair ? prev.slice(0, n - 2) : prev;
        });
        setInput(userMessageContent);
        alert(error.message);
      } else {
        console.error("Error:", error);
        setMessages(prev => [...prev, { role: 'assistant', content: "⚠️ 連線錯誤，請檢查後端是否啟動。" }]);
      }
    } finally {
      // 只有還是「自己這條」串流時才清掉 loading，否則新對話自己的送出流程會被誤解除
      if (streamAbortRef.current === abortController) {
        streamAbortRef.current = null;
        setIsLoading(false);
      }
      refreshAfterGeneration(); // (G2-10)
    }
  };

  // (G6-2) 重新生成最後一則 AI 回覆（主對話）：原地清空該則、串流寫回同一個 message id
  // 後端會把舊回覆與其下的分支做「幽靈化」，成功後：重抓分支清單（高亮消失）、關掉被幽靈化的分支 tab
  // (F9-2) 第二參數 { userMsg, content }：編輯最後一則 user 訊息後重新生成（同一個函式，不另寫串流）
  //        content 有值 → 先把 userMsg 改成新內容，body 帶 content；後端失敗（被拒或沒送出）→ userMsg 還原成舊內容
  const handleRetry = async (msg, { userMsg, content } = {}) => {
    if (isLoading || !msg?.id || !model) return;
    if (content != null && content.length > MAX_MESSAGE_CHARS) { alert(TOO_LONG_MSG); return; } // (B13)
    const retryId = msg.id;
    const editing = content != null && !!userMsg;
    const oldUser = userMsg?.content; // (F9-2) 先記下舊內容（失敗還原用），必須在任何 setState 之前
    // (V1-2) 額度拒絕時還原這則回覆的舊內容與舊模型，同樣必須在 setState 之前記下
    const oldContent = msg.content;
    const oldModel = msg.model_used;

    // 同 handleSend：記下這串對話，切走就停止寫入
    const convId = messages[0]?.id ?? null;
    activeRootIdRef.current = convId;
    if (streamAbortRef.current) {
      try { streamAbortRef.current.abort(); } catch { /* ignore */ }
    }
    const abortController = new AbortController();
    streamAbortRef.current = abortController;
    setIsLoading(true);

    // 先清空這則回覆，讓使用者看到它重新生成；編輯時同時把 user 那則換成新內容（樂觀更新）
    setMessages(prev => prev.map(m => {
      if (editing && m.id === userMsg.id) return { ...m, content };
      return m.id === retryId ? { ...m, content: '', model_used: model } : m;
    }));

    // (F9-2) 伺服器是否已接受（response.ok）；還沒接受前失敗 → user 還原
    let accepted = false;
    try {
      const response = await apiFetch(`/messages/${retryId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify(content != null ? { model, content } : { model }),
      });

      await throwIfQuotaError(response, user);
      if (!response.ok) throw new Error("API Error");
      accepted = true;

      // (G6-2) 後端在 header 回傳這次被幽靈化的分支 id（逗號分隔，可能為空）
      const orphaned = (response.headers.get('X-Orphaned-Branch-Ids') || '').split(',').filter(Boolean);

      // 使用者已切換到別的對話 → 停止讀取，別把內容寫進別人的對話（readTextStream 讀前、讀後各檢查一次）
      const { finished } = await readTextStream(response, {
        shouldStop: () => activeRootIdRef.current !== convId,
        // (G6-2) 寫回「id 等於 retryId 的那則」，不是最後一則
        onText: (aiResponseText) => setMessages(prev => {
          if (activeRootIdRef.current !== convId) return prev;
          return prev.map(m => (m.id === retryId ? { ...m, content: aiResponseText } : m));
        }),
      });

      // 串流成功結束：分支高亮重抓；被幽靈化的分支 tab 關掉（若還是同一串對話才重抓清單）
      if (finished) {
        if (activeRootIdRef.current === convId) loadBranchList(convId);
        if (orphaned.length > 0) {
          closeBranches(orphaned);
        }
      }
    } catch (error) {
      // (F9-2) 請求被拒或根本沒送出（串流還沒開始）：資料庫沒改 → user 還原舊內容；串流中斷則保持新內容
      if (editing && !accepted && activeRootIdRef.current === convId) {
        setMessages(prev => prev.map(m => (m.id === userMsg.id ? { ...m, content: oldUser } : m)));
      }
      // 切換對話造成的 abort 不是錯誤，靜默結束
      if (error?.name === 'AbortError' || activeRootIdRef.current !== convId) {
        // 已被切換的對話：靜默結束
      } else if (error instanceof QuotaError) {
        // (V1-2) 額度／速率限制：後端沒寫入，把這則回覆還原成送出前的內容與模型（user 已由上面 F9 還原）
        setMessages(prev => prev.map(m => (
          m.id === retryId ? { ...m, content: oldContent, model_used: oldModel } : m
        )));
        alert(error.message);
      } else {
        console.error("重新生成失敗:", error);
        setMessages(prev => prev.map(m => (
          m.id === retryId ? { ...m, content: "⚠️ 連線錯誤，請檢查後端是否啟動。" } : m
        )));
      }
    } finally {
      // 只有還是「自己這條」串流時才清掉 loading
      if (streamAbortRef.current === abortController) {
        streamAbortRef.current = null;
        setIsLoading(false);
      }
      refreshAfterGeneration(); // (G2-10)
    }
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
