import { useRef, useEffect } from 'react';
import { Send } from 'lucide-react';

// 底部輸入區塊：自動高度的輸入框、送出按鈕、Enter 行為處理
function ChatInput({ input, setInput, isLoading, onSend }) {
  const textareaRef = useRef(null);

  // 監聽 input 內容，自動調整輸入框高度
  useEffect(() => {
    if (textareaRef.current) {
      // 步驟 A: 先把高度強制重置回基礎高度，這樣如果刪除文字，框才會縮小
      textareaRef.current.style.height = 'auto'; 
      // 步驟 B: 將高度設定為內容的實際高度 (scrollHeight)
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
    }
  }, [input]); // <-- 依賴項是 input，文字改變時就會觸發

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    // 輸入框區塊 - 這裡將背景改為透明，融入網格
    <div className="p-4 bg-white/70 backdrop-blur-sm border-t border-gray-200">
      <div className="max-w-4xl mx-auto relative group">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="輸入訊息..."
          rows="1"
          className="w-full bg-white text-gray-800 rounded-2xl pl-5 pr-14 py-4 focus:outline-none focus:ring-2 focus:ring-[#51A8DD]/40 border border-gray-200 group-hover:border-[#7DB9DE] transition resize-none shadow-sm max-h-[224px] overflow-y-auto"
          style={{ minHeight: '56px' }}
        />
        <button 
          onClick={onSend}
          disabled={isLoading || !input.trim()}
          className="absolute right-2 bottom-[15px] p-2.5 bg-[#51A8DD] hover:bg-[#3D9AD1] rounded-xl transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-md shadow-[#51A8DD]/25"
        >
          <Send className="w-5 h-5 text-white" />
        </button>
      </div>
      <div className="text-center mt-3 text-xs text-gray-400 font-medium">
         AI模型有可能會出錯，請檢察回覆內容。
      </div>
    </div>
  );
}

export default ChatInput;
