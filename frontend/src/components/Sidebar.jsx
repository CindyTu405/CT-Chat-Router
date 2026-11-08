import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ArrowUpDown, Check, X, Trash2, Edit2, MessageSquare, MoreVertical } from 'lucide-react';
import { TbBinaryTree2 } from 'react-icons/tb';
import { FcGoogle } from 'react-icons/fc';
import { FaGithub } from 'react-icons/fa';
import { apiFetch } from '../api';
import { formatDateTime, groupByTimeRange } from '../dateUtils';

// 一列對話：左側載入按鈕 + 右側單一三點選單（分支圖／改名／刪除）
// E4 修正：不再把 <div onClick> 巢狀在 <button> 內，操作項目改為真正的 <button>，
// 可以用 Tab 聚焦、Enter／空白鍵觸發。
function ChatRow({
  activeChatId,
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

  // (M1) 手機長按開選單：計時器、觸控起點、長按後略過下一次 click 的旗標、
  // touch 期間擋掉 contextmenu 的旗標與其延遲清除計時器。全部用 ref，不觸發重新渲染。
  const longPressTimerRef = useRef(null);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);
  const touchActiveRef = useRef(false);
  const touchClearTimerRef = useRef(null);

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

  // (M1) unmount 時清掉長按與 contextmenu 延遲計時器
  useEffect(() => () => {
    clearTimeout(longPressTimerRef.current);
    clearTimeout(touchClearTimerRef.current);
  }, []);

  const runAction = (e, fn) => {
    setMenuOpen(false);
    fn(e);
  };

  // (M1) 長按計時：500ms 內移動超過 10px 或放開就取消
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_PX = 10;
  const CONTEXT_CLEAR_MS = 300;

  const cancelLongPress = () => {
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const onRowTouchStart = (e) => {
    // 每次按下都先重設旗標，避免 iOS 長按後沒送 click 時旗標殘留，吃掉下一次正常點擊
    suppressClickRef.current = false;
    // 手指還在螢幕上，取消上一次延遲清除，保持 touch 中的 contextmenu 擋截狀態
    clearTimeout(touchClearTimerRef.current);
    touchActiveRef.current = true;
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      setMenuOpen(true);
      suppressClickRef.current = true;
      longPressTimerRef.current = null;
    }, LONG_PRESS_MS);
  };

  const onRowTouchMove = (e) => {
    const t = e.touches[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - touchStartRef.current.x);
    const dy = Math.abs(t.clientY - touchStartRef.current.y);
    // 超過容許範圍視為捲動列表，不是長按
    if (dx > LONG_PRESS_MOVE_PX || dy > LONG_PRESS_MOVE_PX) cancelLongPress();
  };

  const onRowTouchEnd = () => {
    cancelLongPress();
    // Android 可能在放開前後才送 contextmenu，延後一小段時間再解除擋截
    clearTimeout(touchClearTimerRef.current);
    touchClearTimerRef.current = setTimeout(() => {
      touchActiveRef.current = false;
      touchClearTimerRef.current = null;
    }, CONTEXT_CLEAR_MS);
  };

  const onRowClick = () => {
    // 剛由長按開啟選單：略過這次 click，不切換對話
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onLoadChat(lastViewedNode || chat.id);
  };

  const onRowContextMenu = (e) => {
    // 只擋觸控引發的選單（手機長按）；桌面右鍵沒有觸控，維持瀏覽器選單
    if (touchActiveRef.current) e.preventDefault();
  };

  const menuItemClass =
    'w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:bg-gray-100 cursor-pointer whitespace-nowrap';

  // 底色 hover 放在外層 group：滑到 ⋯ 按鈕時（⋯ 不在按鈕內）底色仍保持
  // 目前開啟中的對話（isActive）保持同樣底色，點進去後不會因滑鼠離開而消失
  const isActive = chat.id === activeChatId;

  // (M1) 三點外層樣式：選單開啟中同現狀；手機（< 768px）已選取的列常駐顯示，
  // 未選取的列透明且 pointer-events-none（點不到）；桌面（md 以上）維持 hover 才顯示
  const menuWrapClass = menuOpen
    ? 'z-50 opacity-100'
    : isActive
      ? 'z-0 opacity-100 md:opacity-0 md:group-hover:opacity-100'
      : 'z-0 opacity-0 pointer-events-none md:pointer-events-auto md:group-hover:opacity-100';

  return (
    <div className={`group relative rounded-xl transition-all ${isActive ? 'bg-white/80 shadow-sm' : 'hover:bg-white/80 hover:shadow-sm'}`}>
      {/* (M1) 手機長按：觸控事件掛在主按鈕上；不呼叫 preventDefault，列表捲動不受影響。
          select-none 讓長按不選到文字（子元素會繼承）；touch-callout 關掉 iOS 長按選單 */}
      <button
        type="button"
        onClick={onRowClick}
        onTouchStart={onRowTouchStart}
        onTouchMove={onRowTouchMove}
        onTouchEnd={onRowTouchEnd}
        onTouchCancel={onRowTouchEnd}
        onContextMenu={onRowContextMenu}
        className="w-full text-left p-3 pr-2 rounded-xl cursor-pointer transition-all flex items-center gap-3 max-md:select-none [-webkit-touch-callout:none]"
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
        <span className="flex-1 min-w-0 w-full">
          {/* ★★★ 優先顯示 Title，沒有才顯示 Content ★★★ */}
          {/* P3b-F2：單行不換行、不用省略號。P3b-BugB：右端最後 3rem 用遮罩由左至右漸層透明，避開 ⋯ 按鈕 */}
          <span className="block text-sm text-gray-700 group-hover:text-gray-900 whitespace-nowrap overflow-hidden transition font-medium [mask-image:linear-gradient(to_right,#000_calc(100%-4rem),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-4rem),transparent_100%)]">
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
      {/* P3b-F2-fix2：外層容器本身是 absolute（已建立定位），選單展開時把它的 z-index 拉到
          50，才會蓋過 sticky 的分組標題（h3 z-10）。未展開時不開新的堆疊層級，避免影響其他列的滑過效果。
          (M1) 樣式依 menuWrapClass：手機版已選取的列常駐、未選取的列點不到（見上方 menuWrapClass）。 */}
      <div
        ref={menuRef}
        className={`absolute right-2 top-1/2 -translate-y-1/2 ${menuWrapClass} transition-opacity`}
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
            className="absolute right-0 top-full mt-1 z-50 min-w-[8rem] bg-white border border-gray-200 rounded-lg shadow-md py-1"
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
        maxLength={200} // (B13) 與後端 MAX_TITLE_CHARS 一致
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
  user,
  sidebarOpen,
  activeChatId,
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
  onCloseSidebar,
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
  // P3b-F5：手機（< 768px）不套用 inline 百分比寬度，改由 fixed 滿版 class 決定
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

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

  // (S-U1-7) 帳號區：email 為 null 時用 provider 名稱當後備
  const accountLabel =
    user?.email || (user?.provider === 'github' ? 'GitHub 帳號' : 'Google 帳號');
  const [loggingOut, setLoggingOut] = useState(false);
  const onLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // 網路失敗也照樣回首頁
    }
    window.location.replace('/');
  };

  return (
    // --- 左側側邊欄 ---
    // 套用指定的更淺灰藍色 #E8F1F5
    // P5b-fix（B2）：加上 overflow-hidden，收起（w-0）時內容不再溢出到主畫面、不攔截觸控
    // P3b-F2：寬度改用 inline style 的百分比（預設 20%，可拖曳 12%~30%），展開時才套用；
    // transition 只在收合/展開時生效，拖曳中關掉避免延遲感。
    // P3b-F5：手機（< 768px）改為滿版 drawer（fixed 覆蓋全螢幕）；收起時 hidden。
    // 桌面（md 以上）維持原本的推擠式側欄與百分比寬度。
    <aside
      style={sidebarOpen && isDesktop ? { width: `${sidebarPct}%`, minWidth: 0 } : undefined}
      className={`${sidebarOpen ? 'flex fixed inset-0 z-40 w-full md:relative md:z-auto' : 'hidden md:flex md:w-0'} bg-[#E8F1F5] border-r border-gray-300 flex-col flex-shrink-0 overflow-hidden ${isResizing ? '' : 'transition-[width] duration-300'}`}
    >
      {/* P3b-F5：手機版左上 X 關閉（桌面不顯示） */}
      {sidebarOpen && (
        <button
          onClick={onCloseSidebar}
          aria-label="關閉側邊欄"
          className="md:hidden absolute top-3 left-3 z-50 p-2 text-gray-500 hover:text-[#7DB9DE] hover:bg-white/70 rounded-lg cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      )}
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

      {/* New Chat 按鈕（手機版要放在左上 X 按鈕下方，所以頂部留白 pt-16） */}
      <div className="p-4 pt-16 md:pt-4">
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
                      activeChatId={activeChatId}
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

      {/* (S-U1-7) 帳號區：固定在側欄底部、不在捲動列表內；底部用 max() 補手機安全區，避免被瀏覽器工具列蓋住 */}
      <div className="mt-auto flex-shrink-0 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-gray-300 bg-[#E8F1F5]">
        <div className="flex items-center gap-2 min-h-[2.5rem]">
          {user?.provider === 'github' ? (
            <FaGithub className="w-5 h-5 flex-shrink-0 text-gray-700" aria-hidden="true" />
          ) : (
            <FcGoogle className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
          )}
          <span
            title={accountLabel}
            className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-sm text-gray-700 [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent_100%)]"
          >
            {accountLabel}
          </span>
          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            className="flex-shrink-0 px-3 py-2 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-white/80 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7DB9DE]"
          >
            登出
          </button>
        </div>
        <a
          href="/privacy.html"
          target="_blank"
          rel="noopener"
          className="block pl-7 text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2"
        >
          隱私權說明
        </a>
      </div>
    </aside>
  );
}

export default Sidebar;
