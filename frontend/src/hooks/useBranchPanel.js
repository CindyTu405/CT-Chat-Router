// (R-5) 從 App.jsx 搬出：右側分支面板（開啟的分支 tab、各分支訊息與輸入框）與目前對話的分支清單（錨點高亮）。不依賴主對話的 messages：建立分支時由呼叫端傳入 rootId
import { useState, useCallback } from 'react';
import { apiFetch } from '../api';
import { readTextStream } from '../readTextStream';
import { QuotaError, throwIfQuotaError, MAX_MESSAGE_CHARS, MAX_ANCHOR_TEXT_CHARS, TOO_LONG_MSG } from '../quotaErrors';

export function useBranchPanel({ model, user, fetchHistory, refreshAfterGeneration }) {
  // ★★★ (P2-5) 右側分支面板 ★★★
  // 每條分支各自持有訊息串與輸入框，彼此獨立，不影響主視窗的 messages
  // 形狀：{ id, anchorMessageId, rootMessageId, title, messages, input, isLoading }
  const [branches, setBranches] = useState([]);
  const [activeBranchId, setActiveBranchId] = useState(null);
  const [branchPanelOpen, setBranchPanelOpen] = useState(false);

  // ★★★ (P2-12) 持久化錨點高亮：目前對話的所有分支（GET /chats/{root_id}/branches）★★★
  // 只放後端回來的原始資料，畫面靠 anchor_message_id + anchor_text 在訊息裡畫重點
  const [branchList, setBranchList] = useState([]);

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
  const handleCreateBranch = async (rootId, anchorMessageId, selectedText, anchorStart = null, anchorEnd = null) => {
    // rootId：目前時間線的第一則訊息 id，由呼叫端（App）傳入（R-5 起分支 Hook 不讀 messages）。
    // 剛開始的新對話還沒重新載入歷史，messages[0] 還沒有真正的 id，就沒得建立分支。
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

      await throwIfQuotaError(response, user);
      if (!response.ok) throw new Error("API Error");

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

      // 只更新這條分支的最後一則 AI 訊息
      await readTextStream(response, {
        onText: (aiResponseText) => updateBranch(branchId, b => {
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
        }),
      });
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
      refreshAfterGeneration(); // (G2-10)
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

      await throwIfQuotaError(response, user);
      if (!response.ok) throw new Error("API Error");
      accepted = true;

      // 寫回這條分支裡 id 等於 retryId 的那則
      await readTextStream(response, {
        onText: (aiResponseText) => updateBranch(branchId, b => ({
          ...b,
          messages: b.messages.map(m => (m.id === retryId ? { ...m, content: aiResponseText } : m)),
        })),
      });
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
      refreshAfterGeneration(); // (G2-10)
    }
  };

  // (G6-2) 幽靈化的分支關閉：從清單移除；若正是目前選中的分支就清成 null（retry 成功後由 handleRetry 呼叫）
  const closeBranches = (ids) => {
    // (G6-2) 用functional update 過濾，避免覆蓋串流期間其他分支狀態的變動（不用點擊當下的快照）
    setBranches(prev => prev.filter(b => !ids.includes(b.id)));
    // 被關掉的若正是目前選中的分支，就清成 null（面板顯示「尚未開啟分支」，使用者再點選其他 tab）
    setActiveBranchId(a => (ids.includes(a) ? null : a));
  };

  // (R-5) 刪除目前對話時重置分支面板（handleDeleteChat 呼叫）
  const resetBranches = () => {
    setBranchPanelOpen(false);
    setActiveBranchId(null);
    setBranches([]);
    setBranchList([]); // 目前對話的分支高亮資料也屬於被刪的對話
  };

  return { branches, activeBranchId, branchPanelOpen, setBranchPanelOpen, branchList, loadBranchList, updateBranch, openBranchFromHighlight, handleCreateBranch, sendBranchMessage, retryBranchMessage, closeBranches, resetBranches };
}
