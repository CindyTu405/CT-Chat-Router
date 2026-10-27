// P3b-F6：上下文開關面板用的假資料（僅供 UI 展示，之後可換成真實資料來源）
// 每個項目：{ id, title }，與 ContextPanel 的 items prop 形狀一致
export const fakeContextBranches = [
  { id: 'branch-1', title: '如何規劃週末行程' },
  { id: 'branch-2', title: 'React 元件拆分討論' },
  { id: 'branch-3', title: '會議記錄整理' },
];

// 假的分支自身的歷史（用於分支檢視只顯示「其他」分支）
export const fakeBranchContextItems = fakeContextBranches.slice(1);

// 假的 token 用量（不做真實計算）
export const fakeTokenUsage = {
  used: 12480,
  limit: 32000,
};

export default fakeContextBranches;
