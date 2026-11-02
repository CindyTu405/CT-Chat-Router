import { useEffect, useState } from 'react';
import { GitBranch, X, PanelRightClose } from 'lucide-react';
import MessageList from './MessageList';
import ChatInput from './ChatInput';

// (P2-5) 右側分支面板：多 tab 切換、各分支獨立訊息串與獨立輸入框
// (G3-2) 訊息區改用 MessageList，輸入區改用 ChatInput（兩者皆設 branch 變體），
//        與主對話共用同一套組件（variant 設為 branch）；分支與主對話共用同一個 model state。
// props:
//   branches          [{ id, rootMessageId, title, messages, input, isLoading }]
//   activeBranchId    目前選中的分支 id（null = 沒有開啟任何分支）
//   model             當前模型名稱（顯示於標題，並傳給模型選單）
//   setModel          (G3-2) 切換模型（與主對話共用）
//   isCustomModel     (G3-2) 是否為自訂模型輸入
//   setIsCustomModel  (G3-2) 切換自訂模型輸入
//   freeModels        (G3-2) 免費模型清單（模型選單用）
//   freeModelsLoading (G3-2) 免費模型清單是否載入中
//   onSelectBranch(id)
//   onCloseBranch(id)
//   onInputChange(id, text)
//   onSend(id)
//   onToggle()        收起整個面板
function BranchPanel({
  branches,
  activeBranchId,
  model,
  setModel,
  isCustomModel,
  setIsCustomModel,
  freeModels,
  freeModelsLoading,
  onSelectBranch,
  onCloseBranch,
  onInputChange,
  onSend,
  onToggle,
}) {
  // (G3-2) 自己送出訊息時強制捲到底（比照主對話 forceScrollToken）
  const [sendScrollToken, setSendScrollToken] = useState(0);

  // 面板寬度（可拖曳調整）：佔視窗寬度 20% ~ 50%，以百分比儲存並持久化
  const MIN_PANEL_PERCENT = 20;
  const MAX_PANEL_PERCENT = 50;
  const DEFAULT_PANEL_PERCENT = 25;
  const PANEL_WIDTH_STORAGE_KEY = 'ct-chat:branchPanelWidthPercent';

  const clampPanelPercent = (percent) =>
    Math.min(MAX_PANEL_PERCENT, Math.max(MIN_PANEL_PERCENT, percent));

  // 從 localStorage 還原（掛載時讀取一次），無效值則回退預設
  const [panelPercent, setPanelPercent] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
      if (Number.isFinite(stored) && stored > 0) return clampPanelPercent(stored);
    } catch {
      // localStorage 不可用時忽略
    }
    return DEFAULT_PANEL_PERCENT;
  });
  const [isResizing, setIsResizing] = useState(false);
  // P3b-F5：手機（< 768px）不套用 inline 百分比寬度
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 寬度變動時寫回 localStorage
  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(panelPercent));
    } catch {
      // localStorage 不可用時忽略
    }
  }, [panelPercent]);

  const activeBranch = branches.find((b) => b.id === activeBranchId) || null;

  // 拖曳時在 window 上監聽 pointermove / pointerup，並鎖住文字選取
  useEffect(() => {
    if (!isResizing) return undefined;

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    // 面板貼齊視窗右側，寬度換算成視窗寬度的百分比
    const handlePointerMove = (e) => {
      const viewportWidth = window.innerWidth || 1;
      const percent = ((viewportWidth - e.clientX) / viewportWidth) * 100;
      setPanelPercent(clampPanelPercent(percent));
    };
    const handlePointerUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [isResizing]);

  // 視窗大小改變時把百分比拉回可用範圍內
  useEffect(() => {
    const handleWindowResize = () => {
      setPanelPercent((percent) => clampPanelPercent(percent));
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  const handleResizeStart = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsResizing(true);
  };

  // (G3-2) 比照主對話：自己送出訊息時強制捲到底
  const handleSend = () => {
    if (!activeBranch) return;
    setSendScrollToken((t) => t + 1);
    onSend(activeBranch.id);
  };

  return (
    // P3b-F5：手機（< 768px）滿版覆蓋（fixed）；桌面（md 以上）維持並排的百分比寬度。
    // 桌面寬度用 inline style；手機不設 inline 寬度，由 w-full 決定。
    <aside
      style={isDesktop ? { width: `${panelPercent}%` } : undefined}
      className="fixed inset-0 z-40 w-full md:z-auto md:inset-auto md:h-full md:w-auto md:relative flex flex-shrink-0 h-full flex-col bg-white/95 border-l border-[#7DB9DE]/60 shadow-[-4px_0_12px_rgba(81,168,221,0.06)]"
    >
      {/* --- 左側拖曳把手：調整面板寬度（僅桌面） --- */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖曳調整分支面板寬度"
        title="拖曳調整寬度"
        onPointerDown={handleResizeStart}
        className={`absolute left-0 top-0 z-10 h-full w-[6px] cursor-col-resize transition-colors hidden md:block ${
          isResizing ? 'bg-[#51A8DD]/60' : 'bg-transparent hover:bg-[#51A8DD]/40'
        }`}
      />

      {/* --- 面板標題 --- */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white/70 backdrop-blur-sm">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-[#7B90D2] flex items-center justify-center flex-shrink-0">
            <GitBranch className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-700 leading-tight">分支對話</p>
            <p className="text-[11px] text-gray-400 font-mono truncate">
              {branches.length > 0 ? `${branches.length} 條分支 · ${model}` : model}
            </p>
          </div>
        </div>
        {onToggle && (
          <button
            onClick={onToggle}
            title="收起分支面板"
            aria-label="收起分支面板"
            className="p-1.5 text-gray-400 hover:text-[#51A8DD] hover:bg-gray-100 rounded-lg transition cursor-pointer flex-shrink-0"
          >
            {/* 手機版用 X（關閉覆蓋層），桌面版用收合圖示 */}
            <X className="w-4 h-4 md:hidden" />
            <PanelRightClose className="w-4 h-4 hidden md:block" />
          </button>
        )}
      </div>

      {/* --- Tab bar --- */}
      {branches.length > 0 && (
        <div className="flex items-stretch gap-1 px-2 py-2 overflow-x-auto border-b border-gray-200 bg-gray-50/70">
          {branches.map((b) => {
            const isActive = b.id === activeBranchId;
            return (
              <div
                key={b.id}
                onClick={() => onSelectBranch(b.id)}
                title={b.title}
                className={`group/tab flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-lg text-xs cursor-pointer border transition flex-shrink-0 max-w-[160px] ${
                  isActive
                    ? 'bg-[#51A8DD] text-white border-[#51A8DD] shadow-sm'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-[#7DB9DE] hover:text-[#3D9AD1]'
                }`}
              >
                {b.isLoading && (
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse flex-shrink-0" />
                )}
                <span className="truncate">{b.title || '未命名分支'}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseBranch(b.id);
                  }}
                  title="關閉這個分支"
                  className={`p-0.5 rounded transition flex-shrink-0 cursor-pointer ${
                    isActive ? 'hover:bg-white/25' : 'hover:bg-gray-200'
                  }`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* --- 訊息區（G3-2）：與主對話共用 MessageList --- */}
      {/* (G3-2) key 綁分支 id：切 tab 時重建組件，捲動狀態歸零並貼底 */}
      <MessageList
        key={activeBranch ? activeBranch.id : 'none'}
        variant="branch"
        messages={activeBranch ? activeBranch.messages : []}
        isLoading={activeBranch ? activeBranch.isLoading : false}
        setInput={() => {}}
        forceScrollToken={sendScrollToken}
        emptyState={
          !activeBranch ? (
            // 空狀態：沒有開啟任何分支
            <div className="h-full flex flex-col items-center justify-center text-center px-6 space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-[#7B90D2]/15 flex items-center justify-center">
                <GitBranch className="w-6 h-6 text-[#7B90D2]" />
              </div>
              <p className="text-sm font-medium text-gray-600">尚未開啟分支</p>
              <p className="text-xs text-gray-400 leading-relaxed">
                在主對話中選取一段 AI 回覆，按「建立分支」，
                <br />
                就能在這裡展開一條獨立的對話。
              </p>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-gray-400">
              這條分支還沒有訊息
            </div>
          )
        }
      />

      {/* --- 底部輸入框（只在有分支時出現，與主對話共用 ChatInput） --- */}
      {activeBranch && (
        <ChatInput
          variant="branch"
          placeholder={activeBranch.isLoading ? '等待回覆中...' : '在這個分支繼續對話...'}
          input={activeBranch.input}
          setInput={(text) => onInputChange(activeBranch.id, text)}
          isLoading={activeBranch.isLoading}
          onSend={handleSend}
          model={model}
          setModel={setModel}
          isCustomModel={isCustomModel}
          setIsCustomModel={setIsCustomModel}
          freeModels={freeModels}
          freeModelsLoading={freeModelsLoading}
        />
      )}
    </aside>
  );
}

export default BranchPanel;
