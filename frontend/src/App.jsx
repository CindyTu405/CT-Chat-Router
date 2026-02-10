function App() {
  return (
    // 這裡用了 flex, min-h-screen, bg-gray-900, text-white 這些 Tailwind class
    <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white">
      <div className="text-center p-10 border border-gray-700 rounded-2xl shadow-xl bg-gray-800">
        <h1 className="text-4xl font-bold mb-4 text-blue-400">
          Tailwind v4 運作成功！
        </h1>
        <p className="text-gray-300 text-lg">
          現在我們可以開始寫漂亮的 AI 聊天室了。
        </p>
        <button className="mt-6 px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded-full transition cursor-pointer">
          點我沒反應
        </button>
      </div>
    </div>
  )
}

export default App