import { useState, useEffect, useCallback } from 'react';
import { ReactFlow, Controls, Background, applyNodeChanges, applyEdgeChanges, Handle, Position, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { X, User, Bot } from 'lucide-react';
import { TbBinaryTree2 } from 'react-icons/tb';

// const API_URL = "http://localhost:8000"; 
// const API_URL = "https://ai-chat-backend-ugmu.onrender.com";
const API_URL = import.meta.env.VITE_API_URL;

// ============================================================
// (P2-7) 自訂排版：主幹垂直、分支向右
// ============================================================

const NODE_W = 256;              // 節點固定寬度 (w-64)
const TRUNK_X = 0;               // 主幹脊柱的 x（固定）
const TRUNK_GAP_Y = 24;          // 主幹節點之間的垂直間距
const BRANCH_GAP_X = 72;         // 主幹右緣 → 第一欄分支的距離
const BRANCH_COL_GAP = 48;       // 分支同一列相鄰節點的水平間距
const BRANCH_ROW_GAP = 20;       // 分支換列時的垂直間距
const BRANCH_MAX_COLS = 4;       // 一條分支每一列最多放幾則，超過就蛇行換列

const TRUNK_EDGE_COLOR = '#64748b';   // 主幹連線（實線、石板灰）
const BRANCH_EDGE_COLOR = '#f59e0b';  // 分支連線（虛線、琥珀色）

// 主幹 = branch_id 為 null 或 undefined（後端用 NULL 表示主幹）
const isTrunkBranch = (branchId) => branchId === null || branchId === undefined;

// 依 created_at 字串（ISO8601，含 Z）排序即可得到時間序
const byCreatedAt = (a, b) =>
  String(a.data.created_at || '').localeCompare(String(b.data.created_at || ''));

// 動態估算節點高度：文字最多預覽 3 行，寬 256px 大約一行 18 字
const estimateNodeHeight = (content = '') => {
  const enterLines = content.split('\n').length;
  const wrapLines = Math.ceil(content.length / 18);
  const lines = Math.min(3, Math.max(1, enterLines, wrapLines));
  return 60 + lines * 20;
};

// --- 1. 自訂節點外觀：主幹實色框、分支虛線淡化框 ---
const CustomMessageNode = ({ data }) => {
  const isUser = data.role === 'user';
  const isTrunk = isTrunkBranch(data.branch_id);

  // 主幹：實線 + 原色；分支：虛線 + 淡化，降低視覺重量
  const frameClass = isTrunk
    ? isUser
      ? 'bg-[#51A8DD] border-solid border-[#7DB9DE] text-white shadow-md'
      : 'bg-white border-solid border-[#7B90D2] text-gray-800 shadow-md'
    : isUser
      ? 'bg-[#B7DAF0] border-dashed border-[#7DB9DE] text-slate-700 shadow-sm'
      : 'bg-[#F7FAFF] border-dashed border-[#A9B8DC] text-gray-600 shadow-sm';

  const headerBorder = isTrunk
    ? isUser ? 'border-white/30' : 'border-gray-200'
    : isUser ? 'border-slate-500/25' : 'border-slate-300';

  const titleColor = isTrunk
    ? isUser ? 'text-white' : 'text-[#7B90D2]'
    : 'text-slate-500';

  const iconColor = isUser ? (isTrunk ? 'text-white' : 'text-slate-600') : (isTrunk ? 'text-[#7B90D2]' : 'text-slate-400');

  return (
    <div className={`w-64 p-3 rounded-xl border-2 ${frameClass}`}>
      {/* 連接點（垂直：主幹上下串接；水平：分支左右串接） */}
      <Handle id="top" type="target" position={Position.Top} isConnectable={false}
        className="w-1.5 h-1.5 bg-gray-400 border-none" />
      <Handle id="left" type="target" position={Position.Left} isConnectable={false}
        style={{ top: '35%' }} className="w-1.5 h-1.5 bg-gray-400 border-none" />
      <Handle id="right-in" type="target" position={Position.Right} isConnectable={false}
        style={{ top: '70%' }} className="w-1.5 h-1.5 bg-gray-400 border-none" />

      {/* 標題與 Icon 區塊 */}
      <div className={`flex items-center gap-2 mb-2 border-b pb-1 ${headerBorder}`}>
        {isUser ? (
          <User className={`w-4 h-4 ${iconColor}`} />
        ) : (
          <Bot className={`w-4 h-4 ${iconColor}`} />
        )}
        <span className={`text-xs font-bold ${titleColor} truncate max-w-[130px]`}>
          {isUser ? 'User' : data.model_used}
        </span>
        {!isTrunk && (
          <span className="ml-auto text-[10px] leading-4 px-1.5 rounded border border-dashed border-slate-400 text-slate-500 bg-white/70">
            分支
          </span>
        )}
      </div>

      {/* 文字預覽內容 3 行 */}
      <div className={`text-sm line-clamp-3 whitespace-pre-wrap break-words ${
        isTrunk ? (isUser ? 'text-white' : 'text-gray-800') : 'text-slate-600'
      }`}>
        {data.content}
      </div>

      <Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false}
        className="w-1.5 h-1.5 bg-gray-400 border-none" />
      <Handle id="right" type="source" position={Position.Right} isConnectable={false}
        style={{ top: '30%' }} className="w-1.5 h-1.5 bg-gray-400 border-none" />
      <Handle id="left-out" type="source" position={Position.Left} isConnectable={false}
        style={{ top: '70%' }} className="w-1.5 h-1.5 bg-gray-400 border-none" />
    </div>
  );
};

const nodeTypes = { custom: CustomMessageNode };

// --- 2. 排版引擎 ---
// 主幹：x 固定，y 依 created_at 遞增往下排成脊柱。
// 分支：依 branch_id 分組，從 anchor_message_id 的座標往右偏移後橫向延伸；
//       超過 BRANCH_MAX_COLS 則蛇行換列，同一錨點上的多條分支再往下錯開。
const rectsOverlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const getLayoutedElements = (nodes, edges) => {
  const heights = new Map(nodes.map((n) => [n.id, estimateNodeHeight(n.data.content)]));
  const pos = new Map();   // id -> { x, y, w, h }
  const placed = [];       // 已佔用的矩形，用來避免分支互撞

  // --- 2-1. 主幹脊柱 ---
  const trunkNodes = nodes.filter((n) => isTrunkBranch(n.data.branch_id)).sort(byCreatedAt);
  let trunkCursorY = 0;
  trunkNodes.forEach((node) => {
    const h = heights.get(node.id);
    const rect = { x: TRUNK_X, y: trunkCursorY, w: NODE_W, h };
    pos.set(node.id, rect);
    placed.push(rect);
    trunkCursorY += h + TRUNK_GAP_Y;
  });

  // --- 2-2. 分支：依 branch_id 分組 ---
  const groups = new Map();
  nodes
    .filter((n) => !isTrunkBranch(n.data.branch_id))
    .forEach((node) => {
      const key = String(node.data.branch_id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    });

  // 分支之間也依「第一則訊息的時間」排序，讓顏色/位置穩定可預期
  const orderedKeys = [...groups.keys()].sort((a, b) =>
    byCreatedAt(groups.get(a)[0], groups.get(b)[0])
  );

  // 逐條分支放置（用 placed 矩形避開已佔用的空間）
  orderedKeys.forEach((key) => {
    const msgs = [...groups.get(key)].sort(byCreatedAt);

    // 錨點：優先看 anchor_message_id，退回分支首則的 parent_id
    const anchorId =
      msgs.find((m) => m.data.anchor_message_id)?.data.anchor_message_id ??
      msgs[0].data.parent_id;
    const anchor = anchorId ? pos.get(anchorId) : null;

    // 起點 x：錨點右緣再往右一個間距（錨點不存在時，接在主幹欄右側）
    const originX = (anchor ? anchor.x + anchor.w : TRUNK_X + NODE_W) + BRANCH_GAP_X;

    // 切成多列（每列最多 BRANCH_MAX_COLS 則）
    const rows = [];
    for (let i = 0; i < msgs.length; i += BRANCH_MAX_COLS) {
      rows.push(msgs.slice(i, i + BRANCH_MAX_COLS));
    }
    const rowHeights = rows.map((row) => Math.max(...row.map((m) => heights.get(m.id))));

    // 用「已佔用矩形」推導這條分支的起始 y：
    // 先試著與錨點頂端對齊，若撞到（別條分支／換列後的內容）就整條往下讓開。
    let startY = anchor ? anchor.y : 0;
    let band = [];

    for (let guard = 0; guard < 200; guard += 1) {
      const rowTops = [];
      let top = startY;
      rowHeights.forEach((h) => {
        rowTops.push(top);
        top += h + BRANCH_ROW_GAP;
      });

      band = rows.flatMap((row, rowIndex) =>
        row.map((msg, col) => {
          // 偶數列由左往右、奇數列由右往左（蛇行）：
          // 換列後的第一則永遠與前一列最後一則左右相鄰，邊線不會繞回頭。
          const lane = rowIndex % 2 === 0 ? col : BRANCH_MAX_COLS - 1 - col;
          return {
            msg,
            rect: {
              x: originX + lane * (NODE_W + BRANCH_COL_GAP),
              y: rowTops[rowIndex],
              w: NODE_W,
              h: heights.get(msg.id),
            },
          };
        })
      );

      const hits = band.filter(({ rect }) => placed.some((p) => rectsOverlap(p, rect)));
      if (hits.length === 0) break;
      // 讓到所有衝突矩形的最下緣再往下一個間距
      startY = Math.max(...hits.map(({ rect }) => rect.y + rect.h)) + BRANCH_ROW_GAP;
    }

    band.forEach(({ msg, rect }) => {
      pos.set(msg.id, rect);
      placed.push(rect);
    });
  });

  // --- 2-3. 套用座標 ---
  const layoutedNodes = nodes.map((node) => {
    const p = pos.get(node.id) || { x: 0, y: 0 };
    return {
      ...node,
      position: { x: p.x, y: p.y },
      data: {
        ...node.data,
        isTrunk: isTrunkBranch(node.data.branch_id),
        estimatedHeight: heights.get(node.id),
      },
    };
  });

  // --- 2-4. 邊線：連 parent → child，依「主幹 / 分支」給不同顏色與線型 ---
  const branchIds = new Set(
    nodes.filter((n) => !isTrunkBranch(n.data.branch_id)).map((n) => n.id)
  );

  const layoutedEdges = edges.map((edge) => {
    const s = pos.get(edge.source);
    const t = pos.get(edge.target);
    const isBranchEdge = branchIds.has(edge.target) || branchIds.has(edge.source);
    const color = isBranchEdge ? BRANCH_EDGE_COLOR : TRUNK_EDGE_COLOR;

    // 依相對位置挑連接點：橫向相鄰走左右、垂直往下走上下
    let handles = { sourceHandle: 'bottom', targetHandle: 'top' };
    if (s && t) {
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      if (Math.abs(dy) < 48 && Math.abs(dx) > 48) {
        handles = dx > 0
          ? { sourceHandle: 'right', targetHandle: 'left' }
          : { sourceHandle: 'left-out', targetHandle: 'right-in' };
      }
    }

    return {
      ...edge,
      ...handles,
      style: isBranchEdge
        ? { stroke: color, strokeWidth: 2, strokeDasharray: '5 4' }
        : { stroke: color, strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    };
  });

  return { nodes: layoutedNodes, edges: layoutedEdges };
};

// --- 3. 主元件 ---
export default function BranchTreeModal({ isOpen, onClose, rootId, onSelectNode }) {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const onNodesChange = useCallback((changes) => setNodes((nds) => applyNodeChanges(changes, nds)), []);
  const onEdgesChange = useCallback((changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), []);

  // 當視窗打開時，去後端抓「整棵樹」的資料
  useEffect(() => {
    if (!isOpen || !rootId) return;

    const fetchTreeData = async () => {
      setIsLoading(true);
      try {
        const res = await fetch(`${API_URL}/chats/${rootId}/tree`);
        const data = await res.json();

        // 轉換資料給 React Flow 看
        const initialNodes = [];
        const initialEdges = [];

        const nodeIds = new Set(data.map((msg) => msg.id));

        data.forEach((msg) => {
          // 建立節點（把 branch_id / anchor_message_id 一起帶進 node.data）
          initialNodes.push({
            id: msg.id,
            type: 'custom',
            data: {
              role: msg.role,
              content: msg.content,
              model_used: msg.model_used,
              created_at: msg.created_at,
              parent_id: msg.parent_id,
              branch_id: msg.branch_id ?? null,
              anchor_message_id: msg.anchor_message_id ?? null,
            },
            position: { x: 0, y: 0 }, // 先放 0,0，由自訂排版重算
            draggable: false,
          });

          // 建立連接線 (如果有爸爸，且爸爸也在這棵樹裡)
          if (msg.parent_id && nodeIds.has(msg.parent_id)) {
            initialEdges.push({
              id: `e-${msg.parent_id}-${msg.id}`,
              source: msg.parent_id,
              target: msg.id,
              animated: false,
              data: {
                isBranch: !isTrunkBranch(msg.branch_id),
              },
            });
          }
        });

        // 套用自訂排版（主幹垂直、分支向右）
        const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(initialNodes, initialEdges);

        setNodes(layoutedNodes);
        setEdges(layoutedEdges);
      } catch (error) {
        console.error("無法載入樹狀圖資料:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchTreeData();
  }, [isOpen, rootId]);

  // ==========================================
  // ★ 新增：監聽 Esc 鍵關閉彈出視窗的邏輯
  // ==========================================
  useEffect(() => {
    // 如果視窗沒打開，就不用浪費效能去監聽鍵盤
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose(); // 呼叫關閉視窗的方法
      }
    };

    // 綁定鍵盤事件
    window.addEventListener('keydown', handleKeyDown);

    // 組件關閉或卸載時，把監聽器清掉（好習慣，避免記憶體洩漏）
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]); 

  if (!isOpen) return null;

  return (
    // 黑底半透明背景
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center backdrop-blur-sm p-4 md:p-10"
      onClick={(e) => {
          // 關鍵：如果點擊的目標 (e.target) 是這個背景層本身 (e.currentTarget)
          // 代表使用者點在視窗外面，我們就呼叫 onClose() 關閉視窗
          if (e.target === e.currentTarget) {
            onClose();
          }
        }}
    >
      {/* 彈出視窗本體 */}
      <div className="bg-[#E8F1F5] w-full h-full max-w-6xl rounded-2xl shadow-2xl flex flex-col overflow-hidden relative animate-fade-zoom-in">
        
        {/* 頂部標題列 */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gray-50 z-10">
          
          <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2 flex-wrap">
            <TbBinaryTree2 className="w-6 h-6 text-[#228DCD]" />
            對話分支地圖
            <span className="text-xs font-normal text-gray-500 bg-gray-200 px-2 py-1 rounded">點擊節點，以開啟對話</span>
            {/* 圖例：主幹垂直、分支向右 */}
            <span className="text-[11px] font-normal text-gray-500 flex items-center gap-1">
              <span className="w-4 h-0.5 bg-[#64748b] rounded" />主幹
            </span>
            <span className="text-[11px] font-normal text-gray-500 flex items-center gap-1">
              <span className="w-4 h-0.5 rounded border-t-2 border-dashed border-[#f59e0b]" />分支
            </span>
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded-full transition cursor-pointer text-gray-500">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* React Flow 畫布區 */}
        <div className="flex-1 w-full bg-gray-50/50">
          {isLoading ? (
            <div className="w-full h-full flex items-center justify-center text-gray-500">載入樹狀圖中...</div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              // 當點擊某個節點時，觸發 onSelectNode (回到主要對話畫面)
              onNodeClick={(event, node) => {
                onSelectNode(node.id);
                onClose(); // 關閉彈出視窗
              }}
              fitView // 自動縮放讓整棵樹都在畫面內
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.2}
            >
              <Background variant='cross' color="#d3e3eb" gap={16} size={2} />
              <Controls />
            </ReactFlow>
          )}
        </div>
      </div>
    </div>
  );
}
