import { useState, useEffect, useCallback, useRef } from 'react';
import BranchTreeModal from './BranchTreeModal';
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import BranchPanel from './components/BranchPanel';
import { scrollToMessage } from './scrollUtils';

import { apiFetch } from './api';

// (V1-2) 後端在送出前就拒絕（額度用完／太頻繁）時丟出；後端沒寫入 DB，畫面要還原到送出前的狀態
class QuotaError extends Error {}

// (B13) 與後端輸入上限一致
const MAX_MESSAGE_CHARS = 20000;
const MAX_TITLE_CHARS = 200;
const MAX_ANCHOR_TEXT_CHARS = 5000;
const TOO_LONG_MSG = "內容太長，上限 20,000 字";

// 429 / 503 時依 detail.code 轉成 QuotaError；其他回應不做任何事
async function throwIfQuotaError(response) {
  // (B13) 安全網：後端 pydantic 驗證失敗（detail 為陣列，例如內容超長）→ 走同一條還原路徑
  if (response.status === 422) {
    let detail = null;
    try { detail = (await response.json())?.detail; } catch { /* ignore */ }
    if (Array.isArray(detail)) throw new QuotaError(TOO_LONG_MSG);
    return;
  }
  if (response.status !== 429 && response.status !== 503) return;
  let code = null;
  try {
    const body = await response.json();
    code = body?.detail?.code ?? null;
  } catch { /* 忽略解析錯誤（例如 rate limiter 回的是 {"error": ...}） */ }

  if (response.status === 429 && code === 'daily_quota_exceeded') {
    throw new QuotaError("今日額度已用完，將於台灣時間 00:00 重置");
  }
  if (response.status === 429) {
    throw new QuotaError("傳送太頻繁，請稍後再試");
  }
  if (response.status === 503 && code === 'site_quota_exceeded') {
    throw new QuotaError("今日服務額度已滿，請明天再試");
  }
}

function App({ user }) {
  // 清掉舊版的匿名 session id（已改用登入 cookie），只在掛載時執行一次
  useEffect(() => {
    try { localStorage.removeItem('chat_session_id'); } catch { /* 忽略 */ }
  }, []);

  // --- 狀態管理 ---
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [historyList, setHistoryList] = useState([]); // 側邊欄列表
  // (V1-3) 模型初始值由後端 /api/model-options 決定（見下方 effect）；載入前為空，送出會被停用
  const [model, setModel] = useState("");
  const [presets, setPresets] = useState([]); // 後端 ALLOWED_MODELS 可直接選的項目
  const [defaultModel, setDefaultModel] = useState(null); // 後端決定的預設模型，null = 沒有可用模型
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [freeModels, setFreeModels] = useState([]);
  const [freeModelsLoading, setFreeModelsLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [isCustomModel, setIsCustomModel] = useState(false); //即時輸入模型
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

  // ★★★ (P2-12) 持久化錨點高亮：目前對話的所有分支（GET /chats/{root_id}/branches）★★★
  // 只放後端回來的原始資料，畫面靠 anchor_message_id + anchor_text 在訊息裡畫重點
  const [branchList, setBranchList] = useState([]);

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

  // 載入 OpenRouter 免費模型清單
  useEffect(() => {
    apiFetch(`/api/free-models`)
      .then(res => res.json())
      .then(data => setFreeModels(data.models || []))
      .catch(err => console.error("無法載入免費模型:", err))
      .finally(() => setFreeModelsLoading(false));
  }, []);

  // (V1-3) 載入模型選項：presets、預設模型都由後端決定；失敗時視為沒有 presets 且沒有預設
  useEffect(() => {
    apiFetch(`/api/model-options`)
      .then(res => {
        if (!res.ok) throw new Error(`model-options ${res.status}`);
        return res.json();
      })
      .then(data => {
        const nextPresets = data.presets || [];
        const nextDefault = data.default_model || null;
        setPresets(nextPresets);
        setDefaultModel(nextDefault);
        setModel(prev => prev || nextDefault || "");
      })
      .catch(err => {
        console.error("無法載入模型選項:", err);
        setPresets([]);
        setDefaultModel(null);
      })
      .finally(() => setOptionsLoading(false));
  }, []);
  // 2. 載入特定對話 (點擊側邊欄觸發)

  // (P2-12) 取得這棵對話樹的所有分支，供錨點文字持久高亮使用
  const loadBranchList = useCallback(async (rootId) => {
    if (!rootId) {
      setBranchList([]);
      return;
    }
    try {
      const res = await apiFetch(`/chats/${rootId}/branches`);
      if (!res.ok) throw new Error("API Error");
      const data = await res.json();
      setBranchList(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("載入分支清單失敗:", error);
      setBranchList([]);
    }
  }, []);

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
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        if (activeRootIdRef.current !== rootId) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setMessages(prev => {
          if (activeRootIdRef.current !== rootId) return prev;
          const next = [...prev];
          const lastMsg = next[next.length - 1];
          if (!lastMsg || lastMsg.id !== messageId) return prev;
          next[next.length - 1] = { ...lastMsg, content: text };
          return next;
        });
      }
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

      await throwIfQuotaError(response);
      if (!response.ok) throw new Error("API Error");
      
      if (messages.length === 0) {
        setTimeout(fetchHistory, 1000);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";
      
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

      while (true) {
        // ★★★ (P3b) 使用者已切換到別的對話 → 停止套用，別把內容寫進別人的對話 ★★★
        if (activeRootIdRef.current !== sendConvId) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;

        // 讀取是非同步的，回來後再確認一次畫面上還是同一串對話
        if (activeRootIdRef.current !== sendConvId) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        aiResponseText += chunk;

        // 即時更新最後一則 (AI)
        setMessages(prev => {
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
        });
      } // ★ 修正 2：補上 while 迴圈的右大括號！

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

      await throwIfQuotaError(response);
      if (!response.ok) throw new Error("API Error");
      accepted = true;

      // (G6-2) 後端在 header 回傳這次被幽靈化的分支 id（逗號分隔，可能為空）
      const orphaned = (response.headers.get('X-Orphaned-Branch-Ids') || '').split(',').filter(Boolean);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";
      let finished = false; // 串流完整讀完（沒有中途切走）才為 true

      while (true) {
        // 使用者已切換到別的對話 → 停止讀取，別把內容寫進別人的對話
        if (activeRootIdRef.current !== convId) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        const { done, value } = await reader.read();
        if (done) { finished = true; break; }

        // 讀取是非同步的，回來後再確認一次畫面上還是同一串對話
        if (activeRootIdRef.current !== convId) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }

        aiResponseText += decoder.decode(value, { stream: true });

        // (G6-2) 寫回「id 等於 retryId 的那則」，不是最後一則
        setMessages(prev => {
          if (activeRootIdRef.current !== convId) return prev;
          return prev.map(m => (m.id === retryId ? { ...m, content: aiResponseText } : m));
        });
      }

      // 串流成功結束：分支高亮重抓；被幽靈化的分支 tab 關掉（若還是同一串對話才重抓清單）
      if (finished) {
        if (activeRootIdRef.current === convId) loadBranchList(convId);
        if (orphaned.length > 0) {
          // (G6-2) 用functional update 過濾，避免覆蓋串流期間其他分支狀態的變動（不用點擊當下的快照）
          setBranches(prev => prev.filter(b => !orphaned.includes(b.id)));
          // 被關掉的若正是目前選中的分支，就清成 null（面板顯示「尚未開啟分支」，使用者再點選其他 tab）
          setActiveBranchId(a => (orphaned.includes(a) ? null : a));
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
      const res = await apiFetch(`/chats/${rootMessageId}/history`);
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

  // ★★★ (P2-12) 點擊錨點高亮 → 在右側面板開啟對應分支 ★★★
  // 已經開著就只切換，不重複開 tab
  const openBranchFromHighlight = (branch) => {
    if (!branch) return;

    if (branches.some(b => b.id === branch.id)) {
      setActiveBranchId(branch.id);
      setBranchPanelOpen(true);
      return;
    }

    // 還沒有任何訊息的分支：把錨點文字放進輸入框，等使用者自己送出
    const newTab = {
      id: branch.id,
      anchorMessageId: branch.anchor_message_id,
      rootMessageId: branch.root_message_id,
      title: branch.title || '新分支',
      messages: [],
      input: branch.root_message_id ? '' : (branch.anchor_text || ''),
      isLoading: false,
    };

    setBranches(prev => (
      prev.some(b => b.id === branch.id) ? prev : [...prev, newTab]
    ));
    setActiveBranchId(branch.id);
    setBranchPanelOpen(true);

    if (branch.root_message_id) {
      loadBranchMessages(branch.id, branch.root_message_id);
    }
  };

  // ★★★ (P2-4) 選取 AI 回覆文字 → 建立分支 ★★★
  // (P2-5) 成功後在右側面板開一個新 tab，並載入該分支的訊息
  const handleCreateBranch = async (anchorMessageId, selectedText, anchorStart = null, anchorEnd = null) => {
    // root_id 一律取目前時間線的第一則訊息 (messages[0])。
    // 剛開始的新對話還沒重新載入歷史，messages[0] 還沒有真正的 id，就沒得建立分支。
    const rootId = messages[0]?.id;
    if (!rootId) {
      alert("請先重新載入對話再建立分支");
      return;
    }

    try {
      const res = await apiFetch(`/chats/${rootId}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anchor_message_id: anchorMessageId,
          anchor_text: selectedText.slice(0, MAX_ANCHOR_TEXT_CHARS),
          anchor_start: anchorStart,
          anchor_end: anchorEnd,
        }),
      });

      if (res.status === 429) {
        alert("操作太頻繁，請稍後再試");
        return;
      }
      if (!res.ok) throw new Error("API Error");

      const data = await res.json();

      if (data.reused) {
        // (E3) 同範圍已有分支：不建新 tab，直接開既有的那一條
        const existing = (branchList || []).find((b) => String(b.id) === String(data.branch_id)) || {
          id: data.branch_id,
          anchor_message_id: data.anchor_message_id,
          root_message_id: data.root_message_id,
          title: data.title,
          anchor_text: selectedText,
        };
        openBranchFromHighlight(existing);
      } else {
        // tab 標題：後端回傳的 title（與 inline 高亮、底部入口同一份）
        const title = data.title || "新分支";

        // (P2-10) 分支還不會有任何訊息：選取文字只放進輸入框，等使用者自己送出
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
      }

      // (P2-12) 重新抓分支清單，讓剛建立的錨點文字立刻變成可點擊的高亮
      loadBranchList(rootId);

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
    if (!branch || !branch.input.trim() || branch.isLoading || !model) return;

    if (branch.input.length > MAX_MESSAGE_CHARS) { alert(TOO_LONG_MSG); return; } // (B13)
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
      const response = await apiFetch(`/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          model: model,
          parent_id: parentId,
          branch_id: branchId,
        }),
      });

      await throwIfQuotaError(response);
      if (!response.ok) throw new Error("API Error");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";
      const newMsgId = response.headers.get("X-Message-Id");
      // (F9-B4) 補回樂觀 user 訊息的 id：倒數第二則是沒有 id 的 user、最後一則是 assistant 時才補
      const newUserMsgId = response.headers.get("X-User-Message-Id");
      if (newUserMsgId) {
        updateBranch(branchId, b => {
          const len = b.messages.length;
          if (len < 2) return b;
          const last = b.messages[len - 1];
          const userMsg = b.messages[len - 2];
          if (last?.role !== 'assistant') return b;
          if (!userMsg || userMsg.role !== 'user' || userMsg.id) return b;
          const msgs = [...b.messages];
          msgs[len - 2] = { ...userMsg, id: newUserMsgId };
          return { ...b, messages: msgs };
        });
      }

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
      if (error instanceof QuotaError) {
        // (V1-2) 額度／速率限制：後端沒寫入，撤掉這次樂觀加入的 user + 空 AI 佔位，文字放回分支輸入框
        updateBranch(branchId, b => {
          const msgs = b.messages;
          const n = msgs.length;
          const last = msgs[n - 1];
          const userMsg = msgs[n - 2];
          const trailingPair = n >= 2 && last?.role === 'assistant' && !last.id && !last.content
            && userMsg?.role === 'user' && !userMsg.id;
          return { ...b, messages: trailingPair ? msgs.slice(0, n - 2) : msgs, input: content };
        });
        alert(error.message);
        return; // finally 仍會執行（關掉 isLoading、重抓分支訊息）
      }
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

  // (G6-2) 分支面板裡重新生成一則 AI 回覆：比照 sendBranchMessage（無 abort controller），串流寫回同一個 message id
  // 注意：這裡不處理幽靈分支的 tab 關閉與高亮重抓（規格未要求）
  // (F9-2) 第三參數 { userMsg, content }：同 handleRetry，編輯分支最後一則 user（樂觀更新、被拒時還原）
  const retryBranchMessage = async (branchId, msg, { userMsg, content } = {}) => {
    const branch = branches.find(b => b.id === branchId);
    if (!branch || branch.isLoading || !msg?.id || !model) return;
    if (content != null && content.length > MAX_MESSAGE_CHARS) { alert(TOO_LONG_MSG); return; } // (B13)
    const retryId = msg.id;
    const editing = content != null && !!userMsg;
    const oldUser = userMsg?.content; // (F9-2) 先記下舊內容，必須在任何 setState 之前
    // (V1-2) 額度拒絕時還原這則回覆的舊內容與舊模型，同樣必須在 setState 之前記下
    const oldContent = msg.content;
    const oldModel = msg.model_used;

    // 先清空這則回覆並標示分支忙碌中；編輯時同時把 user 那則換成新內容
    updateBranch(branchId, b => ({
      ...b,
      isLoading: true,
      messages: b.messages.map(m => {
        if (editing && m.id === userMsg.id) return { ...m, content };
        return m.id === retryId ? { ...m, content: '', model_used: model } : m;
      }),
    }));

    // (F9-2) 伺服器是否已接受（response.ok）；還沒接受前失敗 → user 還原
    let accepted = false;
    try {
      const response = await apiFetch(`/messages/${retryId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(content != null ? { model, content } : { model }),
      });

      await throwIfQuotaError(response);
      if (!response.ok) throw new Error("API Error");
      accepted = true;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiResponseText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        aiResponseText += decoder.decode(value, { stream: true });

        // 寫回這條分支裡 id 等於 retryId 的那則
        updateBranch(branchId, b => ({
          ...b,
          messages: b.messages.map(m => (m.id === retryId ? { ...m, content: aiResponseText } : m)),
        }));
      }
    } catch (error) {
      // (F9-2) 請求被拒或沒送出：user 還原舊內容
      if (editing && !accepted) {
        updateBranch(branchId, b => ({
          ...b,
          messages: b.messages.map(m => (m.id === userMsg.id ? { ...m, content: oldUser } : m)),
        }));
      }
      if (error instanceof QuotaError) {
        // (V1-2) 額度／速率限制：後端沒寫入，把這則回覆還原成送出前的內容與模型（user 已由上面 F9 還原）
        updateBranch(branchId, b => ({
          ...b,
          messages: b.messages.map(m => (
            m.id === retryId ? { ...m, content: oldContent, model_used: oldModel } : m
          )),
        }));
        alert(error.message);
        return; // finally 仍會執行（關掉 isLoading）
      }
      console.error("分支重新生成失敗:", error);
      updateBranch(branchId, b => ({
        ...b,
        messages: b.messages.map(m => (
          m.id === retryId ? { ...m, content: "⚠️ 連線錯誤，請檢查後端是否啟動。" } : m
        )),
      }));
    } finally {
      updateBranch(branchId, b => ({ ...b, isLoading: false }));
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
         setBranchPanelOpen(false);
         setActiveBranchId(null);
         setBranches([]);
         setBranchList([]); // 目前對話的分支高亮資料也屬於被刪的對話
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
          onCreateBranch={handleCreateBranch}
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
