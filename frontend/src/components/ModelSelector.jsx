import { Sparkles } from 'lucide-react';

// 模型下拉選單（含自訂輸入模式）
// 狀態 model / isCustomModel 由 App 管理，本元件只負責渲染與切换。
function ModelSelector({
  model,
  setModel,
  isCustomModel,
  setIsCustomModel,
  freeModels,
  freeModelsLoading,
}) {
  return (
    <div className="relative">
      {/* --- 模型選擇區 (支援下拉與手動輸入) --- */}
      <div className="relative flex items-center gap-2">

        {/* 裝飾用的小星星 Icon */}
        <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none z-10">
          <Sparkles className="h-3.5 w-3.5 text-[#7B90D2]" />
        </div>

        {!isCustomModel ? (
          // 模式 A：下拉選單
          <select 
            value={model}
            onChange={(e) => {
              if (e.target.value === "custom") {
                setIsCustomModel(true);
                setModel(""); // 清空，讓使用者準備輸入
              } else {
                setModel(e.target.value);
              }
            }}
            className="bg-white border border-gray-300 text-gray-700 text-xs md:text-sm rounded-lg focus:ring-[#7DB9DE] focus:border-[#7DB9DE] block w-40 md:w-56 pl-8 p-2 appearance-none cursor-pointer hover:bg-gray-50 transition shadow-sm"
          >
            <optgroup label="Google (原生 API)">
              <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
            </optgroup>
            <optgroup label="OpenRouter (需儲值/免費)">
              {freeModelsLoading ? (
                <option disabled>載入中...</option>
              ) : freeModels.length === 0 ? (
                <option disabled>暫無免費模型</option>
              ) : (
                freeModels.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))
              )}
            </optgroup>
            <optgroup label="進階功能">
              {/* 這個選項是切換到輸入框的鑰匙 */}
              <option value="custom">✨ 自訂輸入 (貼上模型 ID)...</option>
            </optgroup>
          </select>
        ) : (
          // 模式 B：手動輸入框
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="例如: qwen/qwen-2.5-72b..."
              className="bg-white border border-[#7DB9DE] text-gray-800 text-xs md:text-sm rounded-lg focus:ring-2 focus:ring-[#7DB9DE] block w-40 md:w-56 pl-8 p-2 transition outline-none shadow-sm"
              autoFocus // 切換過來時自動聚焦
            />
            <button
              onClick={() => {
                setIsCustomModel(false);
                setModel("gemini-2.5-flash-lite"); // 取消時切回預設模型
              }}
              className="text-gray-500 hover:text-gray-800 text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded transition cursor-pointer"
            >
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ModelSelector;
