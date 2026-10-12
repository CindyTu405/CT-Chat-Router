import { Plus, ArrowUpDown, Check, X, Trash2, Edit2, MessageSquare, Settings } from 'lucide-react';
import { TbBinaryTree2 } from 'react-icons/tb';
import { formatDateTime } from '../dateUtils';

// 左側側邊欄：New Chat 按鈕、歷史列表（含排序／改名／刪除／分支圖入口）、底部設定
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

      {/* 列表區域 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1 scrollbar-thin scrollbar-thumb-gray-300">
        {historyList.map((chat) => (
          <div key={chat.id} className="group relative">
            {/* 判斷：如果是正在改名的狀態，顯示輸入框 */}
            {renamingId === chat.id ? (
              <div className="p-2 mx-2 bg-white border border-[#7DB9DE] rounded-lg flex items-center gap-2 shadow-sm">
                <input
                  className="flex-1 bg-transparent text-sm text-gray-800 outline-none min-w-0"
                  value={renameInput}
                  onChange={(e) => setRenameInput(e.target.value)}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                      if (e.key === 'Enter') onSubmitRename(e);
                      if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
                <button onClick={onSubmitRename} className="text-green-500 hover:text-green-600">
                  <Check className="w-4 h-4" />
                </button>
                <button onClick={() => setRenamingId(null)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              // 一般狀態：顯示按鈕
              <button 
                onClick={() => onLoadChat(lastViewedNodes[chat.id] || chat.id)}
                className="w-full text-left p-3 rounded-xl hover:bg-white/80 hover:shadow-sm group cursor-pointer transition-all flex items-center gap-3 relative"
              >
                {/* ★★★ 修改這裡：判斷是否有分支來決定圖示 ★★★ */}
                {chat.has_branch ? (
                  <div 
                    onClick={(e) => onOpenTreeModal(e, chat.id)}
                    className="p-0.5 hover:bg-[#D8E6F0] rounded-md transition z-10 relative"
                    title="查看對話分支圖"
                  >
                  <TbBinaryTree2 
                    className="w-4 h-4 text-[#228DCD] hover:text-[#7DB9DE] transition flex-shrink-0" 
                    title="這是一個有分支的對話"
                  /></div>
                ) : (
                  <MessageSquare className="w-5 h-5 text-gray-500 group-hover:text-[#7DB9DE] transition flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0 pr-6"> {/* pr-6 留空間給 hover 按鈕 */}
                    {/* ★★★ 優先顯示 Title，沒有才顯示 Content ★★★ */}
                  <div className="text-sm text-gray-700 group-hover:text-gray-900 truncate transition font-medium">
                    {chat.title || chat.content}
                  </div>
                  <div className="text-xs text-gray-500 truncate mt-0.5">
                      {(() => {
                          // ★ 根據排序模式決定要顯示哪一個時間戳記
                          const targetTime = (sortBy === 'updated' && chat.last_activity) 
                            ? chat.last_activity 
                            : chat.created_at;

                          // 用共用工具解析 (後端回傳 UTC)，並依「使用者所在時區」顯示。
                          // 解析失敗時回傳空字串，避免畫面上出現 Invalid Date。
                          return formatDateTime(targetTime);
                        })()}
                        {/* {console.log("Chat ID:", chat.id, "Last Activity:", chat.last_activity)} */}
                  </div>
                </div>
                {/* ★★★ 懸停操作按鈕 (Group Hover Actions) ★★★ */}
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 rounded-md p-1 shadow-sm border border-gray-200">
                  <div 
                    onClick={(e) => onStartRenaming(e, chat)}
                    className="p-1.5 text-gray-500 hover:text-[#7DB9DE] hover:bg-gray-100 rounded cursor-pointer"
                    title="重新命名"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </div>
                  <div 
                    onClick={(e) => onDeleteChat(e, chat.id)}
                    className="p-1.5 text-gray-500 hover:text-red-500 hover:bg-gray-100 rounded cursor-pointer"
                    title="刪除對話"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </div>
                </div>
              </button>
            )}
          </div>
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
