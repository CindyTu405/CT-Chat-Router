import { useState, useEffect, useCallback } from 'react';
import { ReactFlow, Controls, Background, applyNodeChanges, applyEdgeChanges, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { X, User, Bot } from 'lucide-react';
import { TbBinaryTree2 } from 'react-icons/tb';

// const API_URL = "http://localhost:8000"; 
// const API_URL = "https://ai-chat-backend-ugmu.onrender.com";
const API_URL = import.meta.env.VITE_API_URL;

// --- 1. 定義「自訂節點」的外觀 (最多預覽三行) ---
const CustomMessageNode = ({ data }) => {
  const isUser = data.role === 'user';
  
  return (
    <div 
      className={`w-64 p-3 rounded-xl shadow-md border-2 ${
        isUser 
          ? 'bg-[#51A8DD] border-[#7DB9DE] text-white' 
          : 'bg-white border-[#7B90D2] text-gray-800'
      }`}
    >
      {/* 頂部連接點 (稍微改成中性的灰色，在深色背景上才不突兀) */}
      <Handle type="target" position={Position.Top} className="w-2 h-2 bg-gray-300 border-none" />
      
      {/* 標題與 Icon 區塊 */}
      <div className={`flex items-center gap-2 mb-2 border-b pb-1 ${
        isUser ? 'border-white/30 opacity-90' : 'border-gray-200 opacity-80'
      }`}>
        {isUser ? (
          <User className="w-4 h-4 text-white" />
        ) : (
          <Bot className="w-4 h-4 text-[#7B90D2]" />
        )}
        <span className={`text-xs font-bold ${isUser ? 'text-white' : 'text-[#7B90D2]'}`}>
          {isUser ? 'User' : data.model_used}
        </span>
      </div>
      
      {/* 文字預覽內容3行 */}
      <div className={`text-sm line-clamp-3 whitespace-pre-wrap break-words ${
        isUser ? 'text-white' : 'text-gray-800'
      }`}>
        {data.content}
      </div>
      
      {/* 底部連接點 */}
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 bg-gray-300 border-none" />
    </div>
  );
};

const nodeTypes = { custom: CustomMessageNode };

// --- 2. Dagre 排版引擎 (加入動態高度估算) ---
const getLayoutedElements = (nodes, edges) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  
  // 保留你的微調間距
  dagreGraph.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 10 });

  nodes.forEach((node) => {
    // ★ 核心優化：動態估算文字高度
    const text = node.data.content || "";
    
    // 1. 計算使用者有沒有按 Enter 換行 (\n)
    const enterLines = text.split('\n').length;
    // 2. 計算字數換行 (256px 寬度，扣掉 Padding，大約一行可塞 18 個字)
    const wrapLines = Math.ceil(text.length / 18);
    // 3. 取兩者最大值。因為有 line-clamp-3，所以最高不會超過 3 行
    const actualLines = Math.min(3, Math.max(enterLines, wrapLines));
    
    // 4. 算出最終精準高度: 基礎 UI (標題+留白) 約 60，每行文字高約 20
    const estimatedHeight = 60 + (actualLines * 20);

    // 將算好的高度存進 node.data，等一下定位 Y 軸時需要用到
    node.data.estimatedHeight = estimatedHeight;

    // 餵給 Dagre 引擎最精準的高度
    dagreGraph.setNode(node.id, { width: 256, height: estimatedHeight });
  });

  edges.forEach((edge) => {
    // 保留你的分組邏輯
    const minlen = edge.data?.isNewTurn ? 6 : 1;
    dagreGraph.setEdge(edge.source, edge.target, { minlen: minlen });
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const h = node.data.estimatedHeight; // 拿出剛剛算好的專屬高度
    
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 256 / 2,
        y: nodeWithPosition.y - h / 2, // ★ 每個節點依照自己的高度去對齊中心點
      },
    };
  });

  return { nodes: layoutedNodes, edges };
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

        data.forEach((msg) => {
          // 建立節點
          initialNodes.push({
            id: msg.id,
            type: 'custom',
            data: { role: msg.role, content: msg.content, model_used: msg.model_used },
            position: { x: 0, y: 0 }, // 初始先放 0,0，等一下給 dagre 排版
            draggable: false,
          });

          // 建立連接線 (如果有爸爸的話)
          if (msg.parent_id) {
            const isMsgUser = msg.role === 'user'; // 如果這句話是 User 說的，代表它是接在 AI 下面，開啟了新回合
            
            initialEdges.push({
              id: `e-${msg.parent_id}-${msg.id}`,
              source: msg.parent_id,
              target: msg.id,
              animated: false, // 讓連線有流動的動畫效果
              style: { stroke: '#9ca3af', strokeWidth: 2 },
              data: { isNewTurn: isMsgUser } // ★ 將「是否為新回合」的資訊傳給排版引擎
            });
          }
        });

        // 套用自動排版
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
      <div className="bg-[#E8F1F5] w-full h-full max-w-6xl rounded-2xl shadow-2xl flex flex-col overflow-hidden relative animate-in fade-in zoom-in-95 duration-200">
        
        {/* 頂部標題列 */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gray-50 z-10">
          
          <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <TbBinaryTree2 className="w-6 h-6 text-[#228DCD]" />
            對話分支地圖
            <span className="text-xs font-normal text-gray-500 bg-gray-200 px-2 py-1 rounded">點擊節點，以開啟對話</span>
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