// rehype 外掛：把每個 text node 包成 <span data-s data-e>，
// 讓前端選取時能把 DOM 位置對映回原始 markdown 的字元 offset（DESIGN_P3 主題 1.2）。
// data-s / data-e 是該 text node 對應的 source 字元偏移（半開區間 [s, e)）。
// 跳過 code / pre 內的文字：code block 由 SyntaxHighlighter 渲染，不能切碎。
export default function rehypeSourceOffsets() {
  return (tree) => {
    const wrap = (node, inCode) => {
      if (!node.children) return;
      const isCode = node.tagName === 'code' || node.tagName === 'pre';
      const childInCode = inCode || isCode;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text') {
          // 沒有 position（不應發生）或位於 code/pre 內 → 原樣保留
          if (childInCode || !child.position) return [child];
          return [
            {
              type: 'element',
              tagName: 'span',
              properties: {
                'data-s': child.position.start.offset,
                'data-e': child.position.end.offset,
              },
              children: [child],
            },
          ];
        }
        // 遞迴處理子節點
        wrap(child, childInCode);
        return [child];
      });
    };
    wrap(tree, false);
  };
}
