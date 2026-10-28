// rehype 外掛：依 offset 錨點在 text node 內部分割，重疊段包 <mark data-branch>，
// 其餘片段包 <span data-s data-e>（讓選取對映仍可用）。跳過 code/pre。
//
// 這解決 split 高亮的兩個 bug：
//   1. 換行 —— 只在 text node 內部切割，段落/粗體/列表等結構原封不動。
//   2. 重複文字 —— 依 offset（字元位置）定位，只包選取的那一段，不命中相同文字。
//
// anchors：Array of { id, start, end }，start/end 是 source markdown 的半開區間 [start, end)。
export default function rehypeHighlight(anchors) {
  const valid = (anchors || []).filter(
    (a) => a && Number.isInteger(a.start) && Number.isInteger(a.end) && a.start < a.end
  );
  return (tree) => {
    const wrap = (node, inCode) => {
      if (!node.children) return;
      const isCode = node.tagName === 'code' || node.tagName === 'pre';
      const childInCode = inCode || isCode;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text') {
          if (childInCode || !child.position) return [child];
          return annotateText(child, valid);
        }
        wrap(child, childInCode);
        return [child];
      });
    };
    wrap(tree, false);
  };
}

function spanOf(start, end, children) {
  return {
    type: 'element',
    tagName: 'span',
    properties: { 'data-s': start, 'data-e': end },
    children,
  };
}

function markOf(start, end, branchId, children) {
  return {
    type: 'element',
    tagName: 'mark',
    properties: { 'data-s': start, 'data-e': end, 'data-branch': branchId },
    children,
  };
}

function textSlice(value, start, end) {
  return { type: 'text', value: value.slice(start, end) };
}

// 把單一 text node 依「落在它範圍內」的錨點分割成片段（span 或 mark 元素）
function annotateText(textNode, anchors) {
  const s = textNode.position.start.offset;
  const e = textNode.position.end.offset;
  const value = textNode.value;

  // 各錨點與此 text node 的重疊區間（source 座標），依 start 排序
  const spans = anchors
    .map((a) => ({ start: Math.max(a.start, s), end: Math.min(a.end, e), id: a.id }))
    .filter((m) => m.start < m.end)
    .sort((x, y) => x.start - y.start);

  if (spans.length === 0) {
    return [spanOf(s, e, [textNode])];
  }

  const out = [];
  let cursor = s;
  for (const m of spans) {
    if (m.start > cursor) {
      out.push(spanOf(cursor, m.start, [textSlice(value, cursor - s, m.start - s)]));
    }
    out.push(markOf(m.start, m.end, m.id, [textSlice(value, m.start - s, m.end - s)]));
    cursor = m.end;
  }
  if (cursor < e) {
    out.push(spanOf(cursor, e, [textSlice(value, cursor - s, e - s)]));
  }
  return out;
}
