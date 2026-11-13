import { useEffect, useState } from 'react';
import { GitBranch, X, PanelRightClose } from 'lucide-react';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import BranchListOverlay from './BranchListOverlay';

// (P2-5) 右側分支面板：各分支獨立訊息串與獨立輸入框
// (E4) 移除 tab 列：面板一次只顯示 activeBranchId 那一條；header 左上角分支圖示開「分支列表」覆蓋層（BranchListOverlay）
// (G3-2) 訊息區改用 MessageList，輸入區改用 ChatInput（兩者皆設 branch 變體），
//        與主對話共用同一套組件（variant 設為 branch）；分支與主對話共用同一個 model state。
// props:
//   branches          [{ id, rootMessageId, title, messages, input, isLoading }]（已載入分支的快取）
//   activeBranchId    目前顯示的分支 id（null = 沒有開啟任何分支）
//   model             當前模型名稱（顯示於標題，並傳給模型選單）
//   setModel          (G3-2) 切換模型（與主對話共用）
//   isCustomModel     (G3-2) 是否為自訂模型輸入
//   setIsCustomModel  (G3-2) 切換自訂模型輸入
//   freeModels        (G3-2) 免費模型清單（模型選單用）
//   freeModelsLoading (G3-2) 免費模型清單是否載入中
//   presets / defaultModel / optionsLoading (V1-3) 後端模型選項（GET /api/model-options）與載入狀態
//   branchList        (E4) 目前對話的分支清單（GET /chats/{root}/branches 原始資料），分支列表用
//   messages          (E4) 主對話訊息，分支列表依位置排序用
//   scrollContainerRef (E4) 主對話捲動容器的 ref，點分支列表項目後捲動主對話用
//   onOpenBranch(branch) (E4) 開啟分支（與點高亮相同的 openBranchFromHighlight）
//   onInputChange(id, text)
//   onSend(id)
//   onRetry(branchId, msg)  (G6-2) 重新生成分支裡的最後一則 AI 回覆；只有最後一則 AI 回覆會觸發（見 MessageList）
//   onEdit(branchId, userMsg, aiMsg, text)  (F9-2) 編輯分支裡最後一則 user 訊息並重新生成其後的 AI 回覆（見 MessageList）；未傳則分支內不能編輯
//   footer            (L1-2) 傳入（非 undefined）時，分支底部改顯示此節點，取代 ChatInput（例如落地頁示範的固定提示列）；未傳則照常顯示 ChatInput
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
  presets,
  defaultModel,
  optionsLoading,
  branchList,
  messages,
  scrollContainerRef,
  onOpenBranch,
  onInputChange,
  onSend,
  onRetry,
  onEdit,
  footer,
  onToggle,
}) {
  // (G3-2) 自己送出訊息時強制捲到底（比照主對話 forceScrollToken）
  const [sendScrollToken, setSendScrollToken] = useState(0);
  // (E4) 分支列表覆蓋層是否開啟
  const [listOpen, setListOpen] = useState(false);

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

  // (E4) 點分支列表一項：關清單、開分支，並把主對話捲到該高亮（precise）或該底部入口（否則）置中
  const handlePickFromList = (branch) => {
    setListOpen(false);
    onOpenBranch(branch);
    const root = scrollContainerRef?.current || document;
    const selector = branch.precise ? `[data-branch="${branch.id}"]` : `[data-branch-entry="${branch.id}"]`;
    root.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  return (
    // P3b-F5：手機（< 768px）滿版覆蓋（fixed）；桌面（md 以上）維持並排的百分比寬度。
    // 桌面寬度用 inline style；手機不設 inline 寬度，由 w-full 決定。
    <aside
      style={isDesktop ? { width: `${panelPercent}%` } : undefined}
      className="isolate fixed inset-0 z-40 w-full md:z-auto md:inset-auto md:h-full md:w-auto md:relative flex flex-shrink-0 h-full flex-col bg-white/95 border-l border-[#7DB9DE]/60 shadow-[-4px_0_12px_rgba(81,168,221,0.06)]"
    >
      {/* --- 左側拖曳把手：調整面板寬度（僅桌面） --- */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖曳調整分支面板寬度"
        title="拖曳調整寬度"
        onPointerDown={handleResizeStart}
        className={`absolute left-0 top-0 z-30 h-full w-[6px] cursor-col-resize transition-colors hidden md:block ${
          isResizing ? 'bg-[#51A8DD]/60' : 'bg-transparent hover:bg-[#51A8DD]/40'
        }`}
      />

      {/* --- 面板標題 --- */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white/70 backdrop-blur-sm">
        <div className="flex items-center gap-2 min-w-0">
          {/* (E4) 左上角分支圖示改為按鈕：開啟分支列表 */}
          <button
            type="button"
            onClick={() => setListOpen(true)}
            title="分支列表"
            aria-label="分支列表"
            className="w-7 h-7 rounded-lg bg-[#7B90D2] hover:bg-[#51A8DD] flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors"
          >
            <GitBranch className="w-4 h-4 text-white" />
          </button>
          <div className="min-w-0">
            {/* (E4) 標題＝目前分支標題（單行截斷）；沒開分支時「分支對話」 */}
            <p className="text-sm font-semibold text-gray-700 leading-tight truncate">
              {activeBranch ? activeBranch.title || '未命名分支' : '分支對話'}
            </p>
            {/* (L1-2) 沒有模型名稱時不佔位 */}
            {model && <p className="text-[11px] text-gray-400 font-mono truncate">{model}</p>}
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

      {/* --- 訊息區（G3-2）：與主對話共用 MessageList --- */}
      {/* (G3-2) key 綁分支 id：切 tab 時重建組件，捲動狀態歸零並貼底 */}
      <MessageList
        key={activeBranch ? activeBranch.id : 'none'}
        variant="branch"
        messages={activeBranch ? activeBranch.messages : []}
        isLoading={activeBranch ? activeBranch.isLoading : false}
        setInput={() => {}}
        forceScrollToken={sendScrollToken}
        // (G6-2) 重新生成：把分支 id 補進去，父層只需要 (branchId, msg)
        onRetry={activeBranch && onRetry ? (msg) => onRetry(activeBranch.id, msg) : undefined}
        // (F9-2) 編輯分支最後一則 user：把分支 id 補進去，父層收 (branchId, userMsg, aiMsg, text)
        onEdit={activeBranch && onEdit ? (userMsg, aiMsg, text) => onEdit(activeBranch.id, userMsg, aiMsg, text) : undefined}
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
      {/* (L1-2) 傳入 footer 時以它取代 ChatInput（未傳則行為不變） */}
      {footer !== undefined && activeBranch && footer}
      {footer === undefined && activeBranch && (
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
          presets={presets}
          defaultModel={defaultModel}
          optionsLoading={optionsLoading}
        />
      )}

      {/* --- (E4) 分支列表覆蓋層：蓋住整個面板（含標題列），X 關閉 --- */}
      {listOpen && (
        <BranchListOverlay
          branches={branchList || []}
          messages={messages || []}
          onSelect={handlePickFromList}
          onClose={() => setListOpen(false)}
        />
      )}
    </aside>
  );
}

export default BranchPanel;
