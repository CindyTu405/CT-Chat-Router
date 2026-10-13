import { useMemo } from 'react';
import { Plus, ArrowUpDown, Check, X, Trash2, Edit2, MessageSquare, Settings } from 'lucide-react';
import { TbBinaryTree2 } from 'react-icons/tb';
import { formatDateTime, groupByTimeRange } from '../dateUtils';

// 一列對話：左側載入按鈕 + 右側獨立操作按鈕（分支圖／改名／刪除）
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

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onLoadChat(lastViewedNode || chat.id)}
        className="w-full text-left p-3 pr-24 rounded-xl hover:bg-white/80 hover:shadow-sm cursor-pointer transition-all flex items-center gap-3"
      >
        {/* ★★★ 判斷是否有分支來決定圖示（純顯示用，操作交給右側按鈕）★★★ */}
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
          <span className="block text-sm text-gray-700 group-hover:text-gray-900 truncate transition font-medium">
            {chat.title || chat.content}
          </span>
          <span className="block text-xs text-gray-500 truncate mt-0.5">
            {/* 用共用工具解析 (後端回傳 UTC)，並依「使用者所在時區」顯示。
                解析失敗時回傳空字串，避免畫面上出現 Invalid Date。 */}
            {formatDateTime(targetTime)}
          </span>
        </span>
      </button>

      {/* ★★★ 操作按鈕列：預設隱藏，滑過或聚焦時浮現 ★★★ */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity bg-white/90 rounded-md p-1 shadow-sm border border-gray-200">
        {chat.has_branch && (
          <button
            type="button"
            onClick={(e) => onOpenTreeModal(e, chat.id)}
            className="p-1.5 text-gray-500 hover:text-[#7DB9DE] hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7DB9DE] rounded cursor-pointer"
            title="查看對話分支圖"
            aria-label={`查看「${chat.title || chat.content}」的對話分支圖`}
          >
            <TbBinaryTree2 className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => onStartRenaming(e, chat)}
          className="p-1.5 text-gray-500 hover:text-[#7DB9DE] hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7DB9DE] rounded cursor-pointer"
          title="重新命名"
          aria-label={`重新命名「${chat.title || chat.content}」`}
        >
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => onDeleteChat(e, chat.id)}
          className="p-1.5 text-gray-500 hover:text-red-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7DB9DE] rounded cursor-pointer"
          title="刪除對話"
          aria-label={`刪除「${chat.title || chat.content}」`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
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

// 左側側邊欄：New Chat 按鈕、歷史列表（時間軸分組 + 排序／改名／刪除／分支圖入口）、底部設定
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

  return (
    // --- 左側側邊欄 ---
    // 套用指定的更淺灰藍色 #E8F1F5
    <div className={`${sidebarOpen ? 'w-80' : 'w-0'} bg-[#E8F1F5] border-r border-gray-300 transition-all duration-300 flex flex-col flex-shrink-0 relative`}>

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

      {/* 列表區域：依時間軸分組，群組標題 sticky */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin scrollbar-thumb-gray-300">
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
    </div>
  );
}

export default Sidebar;
