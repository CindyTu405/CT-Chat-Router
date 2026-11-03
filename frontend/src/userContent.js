// (G9) user 訊息解析：只認兩種程式碼，其餘一律當純文字（不跑 markdown，原樣顯示）
// 先切出 ``` 區塊（fence），剩下的文字再切出 `行內` 程式碼。

// 程式碼區塊：```語言(可省略) 換行 內容 ```；[\s\S]*? 盡量少，遇到第一個收尾 ``` 就停
const FENCE_RE = /```([\w+-]*)\n?([\s\S]*?)```/g;
// 行內程式碼：一對反引號，中間不含換行
const INLINE_RE = /`([^`\n]+)`/g;

// 把一段純文字切成 code / text 片段（空字串不產生片段）
const splitInline = (chunk, out) => {
  let last = 0;
  for (const m of chunk.matchAll(INLINE_RE)) {
    if (m.index > last) out.push({ type: 'text', text: chunk.slice(last, m.index) });
    out.push({ type: 'code', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < chunk.length) out.push({ type: 'text', text: chunk.slice(last) });
};

// 回傳依原文順序排列的片段陣列：{ type: 'fence', lang, code } | { type: 'code', text } | { type: 'text', text }
export function parseUserContent(text) {
  if (text == null || text === '') return [];
  const src = String(text);
  const segments = [];
  let last = 0;

  for (const m of src.matchAll(FENCE_RE)) {
    if (m.index > last) splitInline(src.slice(last, m.index), segments);
    segments.push({ type: 'fence', lang: m[1] || '', code: m[2] });
    last = m.index + m[0].length;
  }
  if (last < src.length) splitInline(src.slice(last), segments);

  return segments;
}

export default parseUserContent;
