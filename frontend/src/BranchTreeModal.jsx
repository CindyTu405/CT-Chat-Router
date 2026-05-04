import { useState, useEffect, useCallback } from 'react';
import { ReactFlow, Controls, Background, applyNodeChanges, applyEdgeChanges, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { X, User, Bot } from 'lucide-react';
import { TbBinaryTree2 } from 'react-icons/tb';

const API_URL = "http://localhost:8000"; // 確保這裡跟你的 App.jsx 一致

// --- 1. 定義「自訂節點」的外觀 (最多預覽三行) ---
const CustomMessageNode = ({ data }) => {
  const isUser = data.role === 'user';
  
  return (
    <div 
      className={`w-64 p-3 rounded-xl shadow-md border-2 ${
        isUser 
          ? 'bg-[#228DCD] border-[#7DB9DE] text-white' 
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
        <span className={`text-xs font-bold ${isUser ? 'text-white' : 'text-gray-700'}`}>
          {isUser ? 'User' : 'AI'}
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

// --- 2. Dagre 排版引擎 (自動計算樹狀結構的座標) ---
const getLayoutedElements = (nodes, edges) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  // TB 代表 Top to Bottom (由上到下)
  dagreGraph.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 80 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 256, height: 120 }); // 預設寬高
  });
  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 256 / 2,
        y: nodeWithPosition.y - 120 / 2,
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
            data: { role: msg.role, content: msg.content },
            position: { x: 0, y: 0 }, // 初始先放 0,0，等一下給 dagre 排版
          });

          // 建立連接線 (如果有爸爸的話)
          if (msg.parent_id) {
            initialEdges.push({
              id: `e-${msg.parent_id}-${msg.id}`,
              source: msg.parent_id,
              target: msg.id,
              animated: false, // 讓連線有流動的動畫效果
              style: { stroke: '#9ca3af', strokeWidth: 2 }
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
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center backdrop-blur-sm p-4 md:p-10">
      {/* 彈出視窗本體 */}
      <div className="bg-white w-full h-full max-w-6xl rounded-2xl shadow-2xl flex flex-col overflow-hidden relative animate-in fade-in zoom-in-95 duration-200">
        
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
              <Background color="#ccc" gap={16} />
              <Controls />
            </ReactFlow>
          )}
        </div>
      </div>
    </div>
  );
}