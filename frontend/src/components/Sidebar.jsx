import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ArrowUpDown, Check, X, Trash2, Edit2, MessageSquare, Settings, MoreVertical } from 'lucide-react';
import { TbBinaryTree2 } from 'react-icons/tb';
import { formatDateTime, groupByTimeRange } from '../dateUtils';

// 一列對話：左側載入按鈕 + 右側單一三點選單（分支圖／改名／刪除）
// E4 修正：不再把 <div onClick> 巢狀在 <button> 內，操作項目改為真正的 <button>，
// 可以用 Tab 聚焦、Enter／空白鍵觸發。
function ChatRow({
  chat,
  sortBy,
  lastViewedNode,
  onLoadChat,
  onOpenTreeModal,
  onStartRenaming,
  onDeleteChat,
}) {
  // ★ 根據排序模式決定要顯示哪一個時間戳記
  const targetTime = (sortBy === 'updated' && chat.last_activity)
    ? chat.last_activity
    : chat.created_at;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // 點擊外部或按 Escape 關閉選單
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const runAction = (e, fn) => {
    setMenuOpen(false);
    fn(e);
  };

  const menuItemClass =
    'w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:bg-gray-100 cursor-pointer whitespace-nowrap';

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onLoadChat(lastViewedNode || chat.id)}
        className="w-full text-left p-3 pr-12 rounded-xl hover:bg-white/80 hover:shadow-sm cursor-pointer transition-all flex items-center gap-3"
      >
        {/* ★★★ 判斷是否有分支來決定圖示（純顯示用，操作交給右側選單）★★★ */}
        {chat.has_branch ? (
          <TbBinaryTree2
            className="w-4 h-4 text-[#228DCD] group-hover:text-[#7DB9DE] transition flex-shrink-0"
            aria-hidden="true"
          />
        ) : (
          <MessageSquare className="w-5 h-5 text-gray-500 group-hover:text-[#7DB9DE] transition flex-shrink-0" aria-hidden="true" />
        )}
        <span className="flex-1 min-w-0">
          {/* ★★★ 優先顯示 Title，沒有才顯示 Content ★★★ */}
          {/* P3b-F2：單行不換行、不用省略號，超出的部分直接裁掉；側邊欄拉寬就能看到更多標題 */}
          <span className="block text-sm text-gray-700 group-hover:text-gray-900 whitespace-nowrap overflow-hidden transition font-medium">
            {chat.title || chat.content}
          </span>
          <span className="block text-xs text-gray-500 truncate mt-0.5">
            {/* 用共用工具解析 (後端回傳 UTC)，並依「使用者所在時區」顯示。
                解析失敗時回傳空字串，避免畫面上出現 Invalid Date。 */}
            {formatDateTime(targetTime)}
          </span>
        </span>
      </button>

      {/* ★★★ 三點選單：預設隱藏，滑過或聚焦時浮現；展開時保持可見 ★★★ */}
      <div
        ref={menuRef}
        className={`absolute right-2 top-1/2 -translate-y-1/2 ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} transition-opacity`}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="p-1.5 text-gray-500 hover:text-[#7DB9DE] hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7DB9DE] rounded-md cursor-pointer bg-white/90 shadow-sm border border-gray-200"
          title="更多操作"
          aria-label={`「${chat.title || chat.content}」的更多操作`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <MoreVertical className="w-4 h-4" />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-1 z-40 min-w-[8rem] bg-white border border-gray-200 rounded-lg shadow-md py-1"
          >
            {chat.has_branch && (
              <button
                type="button"
                role="menuitem"
                onClick={(e) => runAction(e, (ev) => onOpenTreeModal(ev, chat.id))}
                className={menuItemClass}
              >
                <TbBinaryTree2 className="w-3.5 h-3.5 text-[#228DCD]" />
                分支圖
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={(e) => runAction(e, (ev) => onStartRenaming(ev, chat))}
              className={menuItemClass}
            >
              <Edit2 className="w-3.5 h-3.5" />
              重新命名
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={(e) => runAction(e, (ev) => onDeleteChat(ev, chat.id))}
              className={`${menuItemClass} text-red-500 hover:text-red-600`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              刪除對話
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// 正在改名的那一列：輸入框 + 確認／取消
function ChatRenameRow({
  renameInput,
  setRenameInput,
  setRenamingId,
  onSubmitRename,
}) {
  return (
    <div className="p-2 mx-2 bg-white border border-[#7DB9DE] rounded-lg flex items-center gap-2 shadow-sm">
      <input
        className="flex-1 bg-transparent text-sm text-gray-800 outline-none min-w-0"
        value={renameInput}
        onChange={(e) => setRenameInput(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmitRename(e);
          if (e.key === 'Escape') setRenamingId(null);
        }}
      />
      <button onClick={onSubmitRename} className="text-green-500 hover:text-green-600" title="確認改名">
        <Check className="w-4 h-4" />
      </button>
      <button onClick={() => setRenamingId(null)} className="text-gray-400 hover:text-gray-600" title="取消改名">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// 左側側邊欄：New Chat 按鈕、歷史列表（時間軸分組 + 排序／三點選單）、底部設定
// 只做渲染與局部互動，狀態與 callback 由 App 透過 props 傳入。
function Sidebar({
  sidebarOpen,
  historyList,
  sortBy,
  setSortBy,
  renamingId,
  setRenamingId,
  renameInput,
  setRenameInput,
  lastViewedNodes,
  onStartNewChat,
  onLoadChat,
  onOpenTreeModal,
  onDeleteChat,
  onStartRenaming,
  onSubmitRename,
}) {
  // P5a：時間軸分組跟著當前排序走（updated → last_activity，created → created_at）
  const timeGroups = useMemo(
    () => groupByTimeRange(historyList, sortBy),
    [historyList, sortBy]
  );

  // P3b-F2：側邊欄寬度可拖曳，以「視窗寬度百分比」儲存（12% ~ 30%），並記在 localStorage。
  const SIDEBAR_PCT_KEY = 'ctchat.sidebarWidthPct';
  const SIDEBAR_PCT_MIN = 12;
  const SIDEBAR_PCT_MAX = 30;
  const SIDEBAR_PCT_DEFAULT = 20;
  const clampPct = (p) => Math.min(SIDEBAR_PCT_MAX, Math.max(SIDEBAR_PCT_MIN, p));

  const [sidebarPct, setSidebarPct] = useState(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_PCT_KEY);
      const num = parseFloat(raw);
      if (Number.isFinite(num)) return clampPct(num);
    } catch {
      // localStorage 不可用（私密模式等）時退回預設值
    }
    return SIDEBAR_PCT_DEFAULT;
  });
  const [isResizing, setIsResizing] = useState(false);

  // 拖曳中：pointermove / pointerup 掛在 window 上，放開或卸載時清掉監聽與選取封鎖
  useEffect(() => {
    if (!isResizing) return undefined;

    const onMove = (e) => {
      const pct = (e.clientX / window.innerWidth) * 100;
      setSidebarPct(clampPct(pct));
    };
    const onUp = () => setIsResizing(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [isResizing]);

  // 每次寬度變動就寫回 localStorage（拖曳放開後也保存最後的值）
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_PCT_KEY, String(sidebarPct));
    } catch {
      // 寫入失敗不影響使用
    }
  }, [sidebarPct]);

  const onResizeHandlePointerDown = (e) => {
    // 只接受主要按鍵（左鍵／單指觸控）
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // move/up 掛在 window 上，拖曳到側邊欄外也持續有效
    setIsResizing(true);
  };

  return (
    // --- 左側側邊欄 ---
    // 套用指定的更淺灰藍色 #E8F1F5
    // P5b-fix（B2）：加上 overflow-hidden，收起（w-0）時內容不再溢出到主畫面、不攔截觸控
    // P3b-F2：寬度改用 inline style 的百分比（預設 20%，可拖曳 12%~30%），展開時才套用；
    // transition 只在收合/展開時生效，拖曳中關掉避免延遲感。
    <aside
      style={sidebarOpen ? { width: `${sidebarPct}%`, minWidth: 0 } : undefined}
      className={`${sidebarOpen ? '' : 'w-0'} overflow-hidden bg-[#E8F1F5] border-r border-gray-300 flex flex-col flex-shrink-0 relative ${isResizing ? '' : 'transition-[width] duration-300'}`}
    >
      {/* P3b-F2：右側邊界的細拖曳把手（col-resize），只在展開時可拖 */}
      {sidebarOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖曳調整側邊欄寬度"
          title="拖曳調整寬度"
          onPointerDown={onResizeHandlePointerDown}
          className={`absolute top-0 right-0 z-30 h-full w-1.5 -mr-[3px] cursor-col-resize touch-none select-none group/handle ${isResizing ? 'bg-[#51A8DD]/60' : 'bg-transparent hover:bg-[#51A8DD]/40'}`}
        />
      )}

      {/* New Chat 按鈕 */}
      <div className="p-4">
        <button 
          onClick={onStartNewChat}
          className="w-full flex items-center gap-3 px-4 py-3 bg-[#51A8DD] hover:bg-[#3D9AD1] rounded-xl transition text-sm font-semibold cursor-pointer shadow-md shadow-[#51A8DD]/30 text-white group"
        >
          <Plus className="w-4 h-4 text-white" />
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

      {/* 列表區域：依時間軸分組，群組標題 sticky
          E5 修正：scrollbar-thin / scrollbar-thumb-gray-300 是 v3 外掛 class，Tailwind v4 無效，
          改寫成等效的原生屬性寫法（Firefox 用 scrollbar-width/color，WebKit 用偽元素變體）。 */}
      <div className="flex-1 min-h-0 relative">
        <div
          className="h-full overflow-y-auto px-2 pb-2 [scrollbar-width:thin] [scrollbar-color:#d1d5db_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300"
        >
          {timeGroups.map((group) => (
            <section key={group.key} className="mb-1">
              {/* -mx-2 讓不透明背景蓋住列表容器的左右 padding，避免捲動時項目從縫隙穿出 */}
              <h3 className="sticky top-0 z-10 -mx-2 bg-[#E8F1F5] px-2 py-1.5 text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                {group.label}
              </h3>
              <div className="space-y-1">
                {group.items.map((chat) => (
                  renamingId === chat.id ? (
                    <ChatRenameRow
                      key={chat.id}
                      renameInput={renameInput}
                      setRenameInput={setRenameInput}
                      setRenamingId={setRenamingId}
                      onSubmitRename={onSubmitRename}
                    />
                  ) : (
                    <ChatRow
                      key={chat.id}
                      chat={chat}
                      sortBy={sortBy}
                      lastViewedNode={lastViewedNodes[chat.id]}
                      onLoadChat={onLoadChat}
                      onOpenTreeModal={onOpenTreeModal}
                      onStartRenaming={onStartRenaming}
                      onDeleteChat={onDeleteChat}
                    />
                  )
                ))}
              </div>
            </section>
          ))}
        </div>
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
    </aside>
  );
}

export default Sidebar;
