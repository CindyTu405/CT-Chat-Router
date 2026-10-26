import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';

// 模型下拉選單（含自訂輸入模式）
// P4：原生 <select> 改為自訂下拉選單，面板以觸發按鈕右下角為錨點（top:100%; right:0）展開，
// 下方空間不足時自動向上翻轉；保留原本 optgroup 分群組、自訂輸入模式與 onChange 行為。
// 狀態 model / isCustomModel 由 App 管理，本元件只負責渲染與切換。

const DEFAULT_MODEL_VALUE = 'gemini-2.5-flash-lite';

// 固定分群組（對應原本原生 <select> 的 optgroup）
const presetGroups = () => [
  {
    label: 'Google (原生 API)',
    options: [{ value: DEFAULT_MODEL_VALUE, label: 'Gemini 2.5 Flash Lite' }],
  },
];

function ModelSelector({
  model,
  setModel,
  isCustomModel,
  setIsCustomModel,
  freeModels,
  freeModelsLoading,
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false); // 下方空間不足時向上展開
  const [activeIndex, setActiveIndex] = useState(-1); // 鍵盤/滑鼠高亮的項目索引

  const wrapperRef = useRef(null); // 觸發按鈕 + 下拉面板的整體容器（供點擊外關閉與錨點用）
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  // --- 建立扁平化選項清單：群組標題以 kind:'group' 呈現，選項以 kind:'option' 呈現 ---
  const items = useMemo(() => {
    const openRouterOptions = freeModelsLoading
      ? [{ value: '__loading', label: '載入中...', disabled: true }]
      : freeModels.length === 0
        ? [{ value: '__empty', label: '暫無免費模型', disabled: true }]
        : freeModels.map((m) => ({ value: m.id, label: m.name }));

    const groups = [
      ...presetGroups(),
      { label: 'OpenRouter (需儲值/免費)', options: openRouterOptions },
      { label: '進階功能', options: [{ value: 'custom', label: '✨ 自訂輸入 (貼上模型 ID)...' }] },
    ];

    const list = [];
    groups.forEach((g) => {
      list.push({ kind: 'group', label: g.label });
      g.options.forEach((o) => list.push({ kind: 'option', ...o }));
    });
    return list;
  }, [freeModels, freeModelsLoading]);

  // 只有可選中的項目參與鍵盤導航（跳過群組標題與 disabled 佔位項）
  const selectableIndexes = useMemo(
    () =>
      items
        .map((it, i) => (it.kind === 'option' && !it.disabled ? i : -1))
        .filter((i) => i >= 0),
    [items]
  );

  // 目前選中的模型名稱（顯示在觸發按鈕上）
  const currentOption = items.find((it) => it.kind === 'option' && it.value === model);
  const currentLabel = currentOption ? currentOption.label : model || '選擇模型';

  // --- 點擊面板外關閉 ---
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open]);

  // --- 開啟時：高亮定位到當前模型，並將焦點移到面板以便接收鍵盤事件 ---
  useEffect(() => {
    if (!open) return;
    const idx = items.findIndex((it) => it.kind === 'option' && it.value === model);
    setActiveIndex(idx >= 0 ? idx : (selectableIndexes[0] ?? -1));
    panelRef.current?.focus();
  }, [open, items, model, selectableIndexes]);

  // --- 面板展開後量測：若下方空間不足且上方空間較大，則以右上角為錨點向上翻轉 ---
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !panelRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const needed = panelRef.current.offsetHeight + 8; // 8px 間隙
    setDropUp(spaceBelow < needed && spaceAbove > spaceBelow);
  }, [open]);

  // --- 高亮項目改變時捲動到可見範圍（面板 max-h-[400px] 可垂直捲動） ---
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const el = panelRef.current.querySelector(`[data-index="${activeIndex}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  // 上下方向鍵在可選項目間循環移動
  const moveActive = (step) => {
    if (selectableIndexes.length === 0) return;
    const pos = selectableIndexes.indexOf(activeIndex);
    const nextPos =
      pos === -1
        ? step > 0
          ? 0
          : selectableIndexes.length - 1
        : (pos + step + selectableIndexes.length) % selectableIndexes.length;
    setActiveIndex(selectableIndexes[nextPos]);
  };

  // 選擇項目：維持原本 onChange 行為（custom 切換到輸入模式，其餘直接 setModel）
  const selectOption = (item) => {
    if (item.disabled) return;
    if (item.value === 'custom') {
      setIsCustomModel(true);
      setModel(''); // 清空，讓使用者準備輸入
    } else {
      setModel(item.value);
    }
    setOpen(false);
  };

  // 面板鍵盤行為：Escape 關閉、上下方向鍵選擇、Enter/空白鍵確認
  const handlePanelKeyDown = (e) => {
    switch (e.key) {
      case 'Escape':
        setOpen(false);
        buttonRef.current?.focus();
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(selectableIndexes[0] ?? -1);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(selectableIndexes[selectableIndexes.length - 1] ?? -1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (items[activeIndex]?.kind === 'option') selectOption(items[activeIndex]);
        break;
      default:
        break;
    }
  };

  return (
    <div className="relative">
      {/* --- 模型選擇區 (支援下拉與手動輸入) --- */}
      <div ref={wrapperRef} className="relative flex items-center gap-2">

        {/* 裝飾用的小星星 Icon */}
        <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none z-10">
          <Sparkles className="h-3.5 w-3.5 text-[#7B90D2]" />
        </div>

        {!isCustomModel ? (
          // 模式 A：自訂下拉選單（P4：面板錨點為觸發按鈕右下角）
          <>
            <button
              ref={buttonRef}
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              onKeyDown={(e) => {
                // 面板關閉時，按方向鍵可直接開啟
                if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault();
                  setOpen(true);
                }
              }}
              className="bg-transparent text-gray-600 text-xs md:text-sm rounded-lg w-40 md:w-56 pl-8 pr-2 py-1 cursor-pointer hover:bg-white/60 transition flex items-center gap-1"
            >
              <span className="truncate flex-1 text-left">{currentLabel}</span>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
              />
            </button>

            {open && (
              <div
                ref={panelRef}
                role="listbox"
                tabIndex={-1}
                aria-label="選擇模型"
                aria-activedescendant={activeIndex >= 0 ? `model-option-${activeIndex}` : undefined}
                onKeyDown={handlePanelKeyDown}
                /* 錨點：手機（預設）左緣對齊按鈕左緣；md 以上置中（left-1/2 + -translate-x-1/2）；上下由 top-full / bottom-full 決定 */
                className={`absolute left-0 md:left-1/2 md:-translate-x-1/2 z-50 w-64 md:w-72 max-w-[calc(100vw-2rem)] max-h-[400px] overflow-y-auto overscroll-contain bg-white border border-gray-200 rounded-lg shadow-lg py-1 outline-none ${
                  dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
                }`}
              >
                {items.map((it, i) =>
                  it.kind === 'group' ? (
                    <div
                      key={`group-${it.label}`}
                      className="px-3 pt-2 pb-1 text-[11px] font-semibold text-gray-400 select-none"
                    >
                      {it.label}
                    </div>
                  ) : (
                    <div
                      key={it.value}
                      id={`model-option-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={it.value === model}
                      aria-disabled={it.disabled || undefined}
                      onMouseEnter={() => {
                        if (!it.disabled) setActiveIndex(i);
                      }}
                      onClick={() => selectOption(it)}
                      className={`mx-1 px-3 py-1.5 rounded text-xs md:text-sm ${
                        it.disabled
                          ? 'text-gray-400 cursor-default'
                          : activeIndex === i
                            ? 'bg-[#7DB9DE]/20 text-gray-800 cursor-pointer'
                            : 'text-gray-700 hover:bg-gray-50 cursor-pointer'
                      } ${it.value === model && !it.disabled ? 'font-medium text-[#4A90D9]' : ''}`}
                    >
                      {it.label}
                    </div>
                  )
                )}
              </div>
            )}
          </>
        ) : (
          // 模式 B：手動輸入框
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="例如: qwen/qwen-2.5-72b..."
              className="bg-transparent text-gray-700 text-xs md:text-sm rounded-lg focus:ring-2 focus:ring-[#7DB9DE] block w-40 md:w-56 pl-8 py-1 transition outline-none"
              autoFocus // 切換過來時自動聚焦
            />
            <button
              onClick={() => {
                setIsCustomModel(false);
                setModel(DEFAULT_MODEL_VALUE); // 取消時切回預設模型
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
