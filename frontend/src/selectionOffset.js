// 從 DOM Selection 的 Range 端點，還原出 source markdown 的字元 offset。
// 依賴 rehypeSourceOffsets 渲染出的 <span data-s data-e>：往上找到帶 data-s 的 span，
// source offset = data-s + 節內偏移。找不到（例如選到 code block）回傳 null。
//
// container / offset 就是 Range 的 startContainer/startOffset（或 end 端）。

function nodeSourceBase(node) {
  // 從某個 DOM 節點往上找第一個帶 data-s 的 span，回傳該 span；找不到回傳 null
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && !(el.getAttribute && el.getAttribute('data-s') !== null)) {
    el = el.parentElement;
  }
  return el;
}

export function sourceOffsetAt(container, offset) {
  let node = container;
  let inner = offset;

  // Range 端點落在「元素邊界」時，offset 是 child index，要轉成該 child 的文字起點
  if (node.nodeType === Node.ELEMENT_NODE) {
    const child = node.childNodes[offset];
    if (child) {
      node = child;
      inner = 0;
    } else {
      // offset 指向最後一個 child 之後 → 取最後一個 child 的結尾
      const last = node.childNodes[node.childNodes.length - 1];
      if (!last) return null;
      node = last;
      inner = last.nodeType === Node.TEXT_NODE ? last.length : 0;
    }
  }

  const span = nodeSourceBase(node);
  if (!span) return null;
  const base = Number(span.getAttribute('data-s'));
  // node 若仍是元素（帶 data-s 的 span 本身），inner 為 0 或 1（child index）
  if (node.nodeType === Node.TEXT_NODE) return base + inner;
  return base + (inner === 0 ? 0 : (node.textContent?.length ?? 0));
}

// 從 Selection 算出 [start, end) 半開區間；任一端對映失敗回傳 null
export function selectionOffsets(selection) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = sourceOffsetAt(range.startContainer, range.startOffset);
  const end = sourceOffsetAt(range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  if (start === end) return null; // 空選取
  return start < end ? [start, end] : [end, start];
}
