import { Menu } from 'lucide-react';
import ModelSelector from './ModelSelector';

// 頂部導航列：側邊欄開關、對話標題、模型選單（未來匯出按鈕也在此）
function ChatHeader({
  sidebarOpen,
  setSidebarOpen,
  messages,
  model,
  setModel,
  isCustomModel,
  setIsCustomModel,
  freeModels,
  freeModelsLoading,
}) {
  return (
    <div className="h-14 border-b border-gray-200 flex items-center justify-between px-4 bg-white/80 backdrop-blur-sm z-10 sticky top-0 shadow-sm">
      <div className="flex items-center gap-3">
        <button 
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-2 text-gray-500 hover:text-[#7DB9DE] hover:bg-gray-100 rounded-lg transition cursor-pointer"
        >
          <Menu className="w-5 h-5" />
        </button>
        {/* 標題顯示區域 */}
        <span className="font-medium text-gray-800 truncate max-w-[150px] md:max-w-md">
          {messages.length > 0 ? (
            // 有對話時：優先顯示 title，沒有則顯示內容摘要
            messages[0].title || messages[0].content.slice(0, 20) + (messages[0].content.length > 20 ? "..." : "")
          ) : (
            // 沒對話時 (New Chat)
            "AI Chat"
          )}
        </span>
      </div>

      <ModelSelector
        model={model}
        setModel={setModel}
        isCustomModel={isCustomModel}
        setIsCustomModel={setIsCustomModel}
        freeModels={freeModels}
        freeModelsLoading={freeModelsLoading}
      />
    </div>
  );
}

export default ChatHeader;
