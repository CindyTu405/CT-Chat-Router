import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Layers, X } from 'lucide-react';
import { fakeContextBranches, fakeTokenUsage } from '../fakeContextData';

// P3b-F6：上下文開關面板（僅 UI，假資料，不做任何後端請求）
// props:
//   items              [{ id, title }] 可勾選的分支清單（預設用假資料）
//   selectedIds        string[]        目前勾選的分支 id
//   onChange(nextIds)  勾選結果改變時回呼（父層用 useState 管理）
//   mode               'main' | 'branch' 顯示模式
//   includeMain        bool            branch 模式時是否納入主對話
//   onIncludeMainChange(bool)          branch 模式下切換主對話
//   tokenUsed/tokenLimit number       假的 token 用量（僅顯示）
//   mainTitle          string          主對話顯示名稱
// 行為：按鈕開啟、點擊面板外或按 Escape 關閉；手機為底部彈出，桌面為按鈕上方的小彈窗。
function ContextPanel({
  items = fakeContextBranches,
  selectedIds = [],
  onChange,
  mode = 'main',
  includeMain = false,
  onIncludeMainChange,
  tokenUsed = fakeTokenUsage.used,
  tokenLimit = fakeTokenUsage.limit,
  mainTitle = '主對話',
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);

  const isBranchMode = mode === 'branch';
  const count = selectedIds.length + (isBranchMode && includeMain ? 1 : 0);
  const percent = tokenLimit > 0 ? Math.min(100, Math.round((tokenUsed / tokenLimit) * 100)) : 0;
  const nearLimit = percent >= 80;

  // 點擊面板外關閉
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open]);

  // Escape 關閉
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const toggleItem = (id) => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
    onChange?.(next);
  };

  const selectAll = () => onChange?.(items.map((it) => it.id));
  const clearAll = () => onChange?.([]);

  return (
    <div ref={wrapperRef} className="relative flex-shrink-0">
      {/* 觸發按鈕：上下文 + 數量徽章 */}
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="選擇要帶入的上下文"
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition cursor-pointer ${
          open || count > 0
            ? 'bg-[#51A8DD]/10 border-[#51A8DD]/50 text-[#3D9AD1]'
            : 'bg-transparent border-gray-200 text-gray-600 hover:bg-white/60 hover:border-[#7DB9DE]'
        }`}
      >
        <Layers className="w-3.5 h-3.5" />
        <span>上下文</span>
        {count > 0 && (
          <span className="min-w-[16px] h-4 px-1 rounded-full bg-[#51A8DD] text-white text-[10px] leading-4 text-center font-medium">
            {count}
          </span>
        )}
        <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          {/* 手機：底部彈出（固定定位，不會被父層 overflow 裁切） */}
          <div className="md:hidden fixed inset-0 z-40 bg-gray-900/20" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="上下文設定"
            className="fixed z-50 inset-x-0 bottom-0 md:absolute md:inset-x-auto md:bottom-full md:mb-2 md:left-0 md:w-80 md:rounded-xl md:border md:shadow-lg max-h-[70vh] md:max-h-96 overflow-y-auto bg-white border-t border-gray-200 md:border md:border-gray-200 rounded-t-2xl shadow-[0_-4px_16px_rgba(81,168,221,0.12)] md:shadow-lg"
          >
            {/* 標題列 + 全選/清空 */}
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50/70 md:rounded-t-xl">
              <div className="flex items-center gap-1.5 min-w-0">
                <Layers className="w-3.5 h-3.5 text-[#7B90D2] flex-shrink-0" />
                <span className="text-xs font-semibold text-gray-700 truncate">上下文</span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={selectAll}
                  className="px-1.5 py-0.5 rounded text-[11px] text-[#3D9AD1] hover:bg-[#51A8DD]/10 transition cursor-pointer"
                >
                  全選
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  className="px-1.5 py-0.5 rounded text-[11px] text-gray-500 hover:bg-gray-100 transition cursor-pointer"
                >
                  清空
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="關閉"
                  aria-label="關閉"
                  className="p-1 text-gray-400 hover:text-[#51A8DD] hover:bg-gray-100 rounded transition cursor-pointer md:hidden"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* 分支清單 */}
            <ul className="py-1">
              {isBranchMode && (
                <li>
                  <button
                    type="button"
                    onClick={() => onIncludeMainChange?.(!includeMain)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-50 transition cursor-pointer"
                  >
                    <span className="text-xs text-gray-700 truncate">{mainTitle}</span>
                    <Switch checked={includeMain} />
                  </button>
                </li>
              )}

              {items.length === 0 ? (
                <li className="px-3 py-2 text-[11px] text-gray-400">沒有可選擇的分支</li>
              ) : (
                items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() => toggleItem(it.id)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-50 transition cursor-pointer"
                    >
                      <span className="text-xs text-gray-700 truncate">{it.title}</span>
                      <Switch checked={selectedIds.includes(it.id)} />
                    </button>
                  </li>
                ))
              )}
            </ul>

            {/* token 用量提示（假數字，僅佔位） */}
            <div className="px-3 py-2 border-t border-gray-200 bg-gray-50/50 md:rounded-b-xl">
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className={nearLimit ? 'text-amber-600 font-medium' : 'text-gray-400'}>
                  預估用量{isBranchMode ? '（含本分支歷史）' : ''}
                </span>
                <span className={nearLimit ? 'text-amber-600 font-mono' : 'text-gray-400 font-mono'}>
                  {tokenUsed.toLocaleString()} / {tokenLimit.toLocaleString()}
                </span>
              </div>
              <div className="h-1 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${nearLimit ? 'bg-amber-400' : 'bg-[#51A8DD]'}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
              {nearLimit && (
                <p className="mt-1 text-[10px] text-amber-600">接近上限，建議減少勾選的分支</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// 小型開關（純展示，點擊交給外層按鈕處理）
function Switch({ checked }) {
  return (
    <span
      aria-hidden="true"
      className={`relative flex-shrink-0 w-7 h-4 rounded-full transition-colors ${
        checked ? 'bg-[#51A8DD]' : 'bg-gray-300'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-3' : 'translate-x-0'
        }`}
      />
    </span>
  );
}

export default ContextPanel;
