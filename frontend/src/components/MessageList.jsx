import { useRef, useEffect, useState, useMemo } from 'react';
import { Bot, User, Sparkles, GitBranch, ArrowDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// 這裡選用 vscDarkPlus 主題，看起來會很像 VS Code 的深色模式
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { formatShortDateTime } from '../dateUtils';
import rehypeSourceOffsets from '../rehypeSourceOffsets';
import rehypeHighlight from '../rehypeHighlight';
import { selectionOffsets } from '../selectionOffset';
import { MessageActions, MessageActionMenu } from './MessageActions';
// (G9) user 訊息：原樣顯示＋超過 10 行摺疊
import UserMessageContent from './UserMessageContent';
// (F9-2) 最後一則 user 訊息的原地編輯框
import UserMessageEditor from './UserMessageEditor';

// 錨點高亮的可點擊樣式。(B7) 同一分支跨多個 mark（例如跨粗體）時，只有第一段（data-first）左側圓角、
// 最後一段（data-last）右側圓角，接縫處不留空隙；整條一起 hover 靠 data-hover（見 handleBranchPointerOver）。
// 調整：data-[first]:pl-0.5／data-[last]:pr-0.5 是圓角那一側的留白，改成 0 就貼字；data-[hover]:bg-amber-300 是 hover 顏色。
const ANCHOR_MARK_CLASS =
  'bg-amber-200/80 text-inherit underline decoration-amber-500/70 decoration-2 underline-offset-2 cursor-pointer transition-colors data-[first]:rounded-l-sm data-[first]:pl-0.5 data-[last]:rounded-r-sm data-[last]:pr-0.5 data-[hover]:bg-amber-300';
const ANCHOR_MARK_PLAIN_CLASS =
  'bg-amber-200/80 text-inherit data-[first]:rounded-l-sm data-[first]:pl-0.5 data-[last]:rounded-r-sm data-[last]:pr-0.5';
// (L1-2) 提示段落（尚未建立分支）的樣式：虛線底線，點一下可選取這段文字。調整：decoration-[#7B90D2] 是線色，hover:bg-[#7B90D2]/15 是 hover 底色。
const ANCHOR_HINT_CLASS =
  'bg-transparent text-inherit underline decoration-dashed decoration-[#7B90D2] decoration-2 underline-offset-4 cursor-pointer rounded-sm transition-colors hover:bg-[#7B90D2]/15';

// (B7) 整條分支一起 hover 的屬性名（事件委派直接寫 DOM，不經 React state）
const BRANCH_HOVER_ATTR = 'data-hover';

// (E3) AI 回覆底部入口的視覺常數（沒有 offset 的分支），調外觀改這裡；入口文字顏色沿用 ANCHOR_MARK_CLASS
// 分隔橫線：包住入口列表的外層，mt-3 是與回覆內容的距離，pt-2 是橫線與第一個入口的距離，border-t 決定線的顏色與粗細
const BRANCH_ENTRY_RULE_CLASS = 'mt-3 pt-2 border-t border-amber-300/70';
// 入口列表間距：space-y-1 是相鄰兩個入口之間的垂直距離
const BRANCH_ENTRY_LIST_CLASS = 'space-y-1';
// 入口文字版型：block w-full 撐滿寬度，whitespace-normal break-words 允許換行（長文字不撐寬泡泡，B8），min-w-0 讓 flex/grid 父層可收縮，text-left 靠左，text-sm 字級
// (B7) rounded-sm px-0.5 hover:bg-amber-300 是入口自己的圓角、留白、hover（不再從 ANCHOR_MARK_CLASS 繼承，那邊已改成依 data-first／data-last 決定）
const BRANCH_ENTRY_TEXT_CLASS =
  'block w-full min-w-0 whitespace-normal break-words text-left text-sm rounded-sm px-0.5 hover:bg-amber-300';

// (G3) 主對話／分支面板共用此組件；差異集中在這張表（main 的頭像只在桌面顯示（G7））
// (E3) showBranchEntries：只有主對話顯示 AI 回覆底部的分支入口（分支面板內不顯示）
const MESSAGE_LIST_VARIANTS = {
  main: { showAvatar: true, showBranchEntries: true },
  branch: { showAvatar: false, showBranchEntries: false },
};

// (G8) 手機 user 氣泡長按：按住 500ms 開選單；移動超過 10px 視為捲動，取消長按
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

// (G5-B3) 手機選字後「建立分支」按鈕放在選取範圍下方，往下偏移這麼多 px，避開控制棒（可調）
const MOBILE_BUTTON_OFFSET = 28;
// (G5-B3) selectionchange 防抖時間：停手這麼久才更新按鈕（拖控制棒、shift＋方向鍵時不會一直閃）
const SELECTION_DEBOUNCE_MS = 300;

// (G5-B3) remark 外掛陣列固定成模組常數，避免每次渲染都是新陣列
const REMARK_PLUGINS = [remarkGfm];

// (B7) 整條分支一起 hover：掛在訊息容器上的事件委派（一個 over、一個 out，不經 React state）
const branchMarkOf = (el) => el?.closest?.('mark[data-branch]') ?? null;

// 把容器內所有 data-branch 等於 branchId 的 mark 設成 hover（on=true）或清除（on=false）
const setBranchHover = (root, branchId, on) => {
  const selector = `mark[data-branch="${CSS.escape(String(branchId))}"]`;
  root.querySelectorAll(selector).forEach((m) => {
    if (on) m.setAttribute(BRANCH_HOVER_ATTR, '');
    else m.removeAttribute(BRANCH_HOVER_ATTR);
  });
};

const handleBranchPointerOver = (e) => {
  const m = branchMarkOf(e.target);
  if (!m) return;
  setBranchHover(e.currentTarget, m.getAttribute('data-branch'), true);
};

const handleBranchPointerOut = (e) => {
  const m = branchMarkOf(e.target);
  if (!m) return;
  const id = m.getAttribute('data-branch');
  // 移到同一分支的另一段時不清除，避免中間閃一下
  const next = branchMarkOf(e.relatedTarget);
  if (next && next.getAttribute('data-branch') === id) return;
  setBranchHover(e.currentTarget, id, false);
};

// 指標離開整個訊息容器時，清掉所有殘留的 data-hover（例如 mark 在 hover 中途被重新渲染）
const clearBranchHover = (e) => {
  e.currentTarget.querySelectorAll(`[${BRANCH_HOVER_ATTR}]`).forEach((el) => el.removeAttribute(BRANCH_HOVER_ATTR));
};

// Markdown 樣式覆寫（程式碼區塊、表格、連結…），依氣泡角色決定行內程式碼配色。
// 抽成函式，讓「單段渲染」與「錨點切段渲染」共用同一套樣式。
// (F8) branchByIdRef：branch id → branch 物件的 ref（rehypeHighlight 標在 mark 的 data-branch 上）；
//      onOpenBranchRef：點擊高亮時開啟該分支的 ref。
// (G5-B3) 這兩個都改用 ref 讀「最新值」，讓回傳的 components 物件只需建立一次（見 MessageList 內的 markdownComponents），
//      元件身分固定，React 重新渲染時就不會把整段 DOM 拆掉重建（那會讓選取反白消失）。
// (L1-2) hintByIdRef：String(hint.id) → hint 的 ref；onHintClickRef：點擊提示段落時呼叫 onHintClick(hint, e) 的 ref（同樣用 ref 讀最新值）。
const buildMarkdownComponents = (role, branchByIdRef, onOpenBranchRef, hintByIdRef, onHintClickRef) => ({
  // 處理多行程式碼區塊 (Code Blocks)
  code({ inline, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    return !inline && match ? (
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={match[1]}
        PreTag="div"
        className="rounded-xl my-3 shadow-sm text-sm"
        {...props}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    ) : (
      // 處理單行行內程式碼 (Inline Code)
      <code
        className={`px-1.5 py-0.5 rounded-md font-mono text-[13px] ${
          role === 'user'
            ? 'bg-blue-600/50 text-white' // 使用者泡泡內的行內程式碼樣式
            : 'bg-gray-100 text-[#E83E8C]' // AI 泡泡內的行內程式碼樣式
        }`}
        {...props}
      >
        {children}
      </code>
    );
  },
  // 自定義 Markdown 標籤的 Tailwind 樣式，讓排版更好看
  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc ml-5 mb-3 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal ml-5 mb-3 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  h1: ({ children }) => <h1 className="text-2xl font-bold mb-3 mt-4">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xl font-bold mb-3 mt-4">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-bold mb-2 mt-3">{children}</h3>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-600 underline underline-offset-2 transition-colors">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-gray-300 pl-4 py-1 my-3 text-gray-600 bg-gray-50 rounded-r-lg">
      {children}
    </blockquote>
  ),
  table: ({ children }) => <div className="overflow-x-auto my-4"><table className="min-w-full divide-y divide-gray-200 border border-gray-200 rounded-lg">{children}</table></div>,
  th: ({ children }) => <th className="px-4 py-2 bg-gray-50 text-left text-sm font-semibold text-gray-700 border-b">{children}</th>,
  td: ({ children }) => <td className="px-4 py-2 text-sm text-gray-600 border-b">{children}</td>,
  // (F8) rehypeHighlight 依 source offset 標出的錨點：只有精確的那一段會變成 mark，
  // 點擊即可開啟對應分支。找不到對應分支時退化為不可點擊的純高亮。
  mark: ({ node, children }) => {
    // (G5-B3) 渲染時才讀 ref.current，拿到的是最新的 branchList／onOpenBranch
    // (B6) hast 的 property 名稱就是 rehypeHighlight 寫入的 kebab 形式（'data-s'、'data-e'、'data-branch'），
    // 要原樣轉到 DOM 上，selectionOffset.js 才能從選取端點往上找到 data-s／data-e
    const props = node?.properties || {};
    // (B7) data-first／data-last 是 rehypeHighlight 標的空字串屬性；undefined 時 React 不會輸出該屬性
    const dataAttrs = {
      'data-s': props['data-s'],
      'data-e': props['data-e'],
      'data-branch': props['data-branch'],
      'data-first': props['data-first'],
      'data-last': props['data-last'],
    };
    const branchId = props['data-branch'];
    const branch = branchId != null ? branchByIdRef?.current?.get(String(branchId)) : null;
    if (!branch) {
      // (L1-2) 不是分支就看是不是提示段落（虛線底線，點擊交給 onHintClick）
      const hint = branchId != null ? hintByIdRef?.current?.get(String(branchId)) : null;
      if (hint) {
        return (
          <mark
            {...dataAttrs}
            data-hint=""
            onClick={(e) => onHintClickRef?.current?.(hint, e)}
            title="點一下選取這段文字"
            className={ANCHOR_HINT_CLASS}
          >
            {children}
          </mark>
        );
      }
      return <mark {...dataAttrs} className={ANCHOR_MARK_PLAIN_CLASS}>{children}</mark>;
    }
    return (
      <mark
        {...dataAttrs}
        onClick={() => onOpenBranchRef?.current?.(branch)}
        title={`開啟分支：${branch.title || '新分支'}`}
        className={ANCHOR_MARK_CLASS}
      >
        {children}
      </mark>
    );
  },
});

// 中間對話視窗：空狀態提示、訊息氣泡（Markdown／程式碼高亮）、選取文字建立分支
// (G3) variant：'main'（預設，顯示頭像）或 'branch'（無頭像）；由 MESSAGE_LIST_VARIANTS 決定差異。
//      emptyState：可選，訊息為空時顯示的內容；未傳則用預設建議卡片。
function MessageList({
  messages,
  isLoading,
  setInput,
  onCreateBranch,
  branchList = [],
  onOpenBranch = () => {},
  // (P3b-F1b) 捲動容器 ref 由 App 持有，載入對話時才能在父層還原閱讀位置
  scrollContainerRef,
  skipAutoScrollToken = null,
  forceScrollToken=0,
  variant = 'main',
  emptyState,
  // (G6-2) 重新生成：傳入時，「最後一則 AI 回覆」且非串流中才會顯示重新生成鈕（見下方 AI 功能列）
  onRetry,
  // (F9-2) 編輯最後一則 user 訊息：傳入時才可能出現編輯入口（見 canEdit）；送出時呼叫 onEdit(userMsg, aiMsg, text)
  onEdit,
  // (L1-2) 提示段落：{ id, message_id, start, end }（尚未建立分支的可選段落，虛線底線）；點擊呼叫 onHintClick(hint, e)
  anchorHints = [],
  onHintClick,
}) {
  const v = MESSAGE_LIST_VARIANTS[variant] || MESSAGE_LIST_VARIANTS.main;
  const messagesEndRef = useRef(null);
  const internalContainerRef = useRef(null);
  // (P3b-F1a-fix) 使用者是否「貼在底部」：由 onScroll 維護，而不是每次內容變動後才量一次
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);

  // (P2-4) 選取 AI 回覆後的浮動「建立分支」按鈕狀態
  const [branchSel, setBranchSel] = useState(null); // { messageId, text, x, y } | null
  const branchBtnRef = useRef(null);

  // (P2-12) message id → 掛在這則訊息上的分支（只收有 anchor_text 的）
  const anchorsByMessageId = useMemo(() => {
    const map = new Map();
    (branchList || []).forEach((branch) => {
      if (!branch?.anchor_text || !branch?.anchor_message_id) return;
      const list = map.get(branch.anchor_message_id);
      if (list) list.push(branch);
      else map.set(branch.anchor_message_id, [branch]);
    });
    return map;
  }, [branchList]);

  // (G5-B3) 點擊按鈕以外的地方改由 selectionchange 處理（選取收合即隱藏），這裡只留捲動／視窗縮放時收起
  useEffect(() => {
    if (!branchSel) return;
    const close = () => setBranchSel(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [branchSel]);

  // (G5-B3) selectionchange 防抖用的計時器、以及「最新的」訊息列表與 updateBranchSelection（供監聽器讀取）
  const selectionTimerRef = useRef(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // (P2-4) 依目前的 DOM 選取，決定是否顯示「建立分支」按鈕（取代原本 AI 泡泡的滑鼠放開事件）
  // (G5-B3) 由 selectionchange 防抖後呼叫；選取收合或不在 AI 泡泡內 → 隱藏按鈕
  const updateBranchSelection = () => {
    if (!onCreateBranch) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setBranchSel(null);
      return;
    }

    // 從選取的兩端各自往上找最近的 AI 內容區（帶 data-branch-source）；兩端必須是同一個，且在本元件內
    const findSourceEl = (node) => {
      const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      return el?.closest?.('[data-branch-source]') ?? null;
    };
    const sourceEl = findSourceEl(selection.anchorNode);
    if (
      !sourceEl ||
      sourceEl !== findSourceEl(selection.focusNode) ||
      !internalContainerRef.current?.contains(sourceEl)
    ) {
      setBranchSel(null);
      return;
    }

    // 串流中的訊息還沒有真正的 id（不會掛 data-branch-source），這裡只需找到對應的訊息
    const msgId = sourceEl.getAttribute('data-msg-id');
    const msg = (messagesRef.current || []).find((m) => String(m.id) === msgId);
    if (!msg?.content) {
      setBranchSel(null);
      return;
    }

    // (F7) 先試著把選取對映回 source offset；對得到就用 offset 反推文字，
    // 確保 anchor_text 與 offset 永遠一致（content.slice(start, end) === anchor_text）。
    // 對不到（例如選到 code block）就退回 selection.toString()，offset 留 null（後端 precise=false）。
    const offsets = selectionOffsets(selection);
    let text;
    let start = null;
    let end = null;
    if (offsets) {
      [start, end] = offsets;
      text = msg.content.slice(start, end);
    } else {
      text = selection.toString().trim();
    }
    if (!text) {
      setBranchSel(null);
      return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const halfButton = 60; // 粗略半寬，避免按鈕被視窗邊界切掉
    // (G5-B3) 手機（< 768）放選取下方，避開原生工具列；電腦放上方（現況）
    const isMobile = window.innerWidth < 768;
    setBranchSel({
      messageId: msg.id,
      text,
      start,
      end,
      x: Math.min(Math.max(rect.left + rect.width / 2, halfButton), window.innerWidth - halfButton),
      y: isMobile ? rect.bottom + MOBILE_BUTTON_OFFSET : Math.max(rect.top - 8, 48),
      placement: isMobile ? 'below' : 'above',
    });
  };

  // (G5-B3) 監聽整個文件的選取變化（滑鼠、shift＋方向鍵、手機長按與控制棒都會觸發），停手 SELECTION_DEBOUNCE_MS 後才更新
  // 監聽器用 ref 讀最新的 updateBranchSelection，避免讀到建立當下的舊 messages／branchSel
  const updateBranchSelectionRef = useRef(null);
  updateBranchSelectionRef.current = updateBranchSelection;

  useEffect(() => {
    const handleSelectionChange = () => {
      clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = setTimeout(() => {
        updateBranchSelectionRef.current?.();
      }, SELECTION_DEBOUNCE_MS);
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      clearTimeout(selectionTimerRef.current);
    };
  }, []);

  const createBranchFromSelection = () => {
    if (!branchSel) return;
    onCreateBranch(branchSel.messageId, branchSel.text, branchSel.start, branchSel.end);
    window.getSelection()?.removeAllRanges();
    setBranchSel(null);
  };

  // (G8) 手機 user 氣泡長按 → 浮動功能選單：{ msg, index, rect } | null（index 用來算 canEdit）
  const [actionMenu, setActionMenu] = useState(null);
  const pressRef = useRef({ timer: null, x: 0, y: 0 });

  // 卸載時清掉長按計時器
  useEffect(() => () => clearTimeout(pressRef.current.timer), []);

  // (G8) 只有 user 且有內容的氣泡才掛長按事件；回傳要 spread 到氣泡 div 上的 props
  const longPressProps = (msg, index) => {
    if (msg.role !== 'user' || !msg.content) return {};
    return {
      onPointerDown: (e) => {
        if (e.pointerType !== 'touch') return; // 只處理手指，滑鼠不觸發
        const el = e.currentTarget;
        pressRef.current.x = e.clientX;
        pressRef.current.y = e.clientY;
        clearTimeout(pressRef.current.timer);
        pressRef.current.timer = setTimeout(() => {
          setActionMenu({ msg, index, rect: el.getBoundingClientRect() });
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e) => {
        const { x, y } = pressRef.current;
        const moved = Math.hypot(e.clientX - x, e.clientY - y);
        if (moved > LONG_PRESS_MOVE_TOLERANCE) clearTimeout(pressRef.current.timer);
      },
      onPointerUp: () => clearTimeout(pressRef.current.timer),
      onPointerCancel: () => clearTimeout(pressRef.current.timer),
      onPointerLeave: () => clearTimeout(pressRef.current.timer),
      onContextMenu: (e) => e.preventDefault(), // 擋掉 Android 長按的原生選單
    };
  };

  // (F8) branch id → branch 物件，供 mark 元件反查要開啟哪個分支
  const branchById = useMemo(() => {
    const map = new Map();
    (branchList || []).forEach((branch) => {
      if (branch?.id == null) return;
      map.set(String(branch.id), branch);
    });
    return map;
  }, [branchList]);

  // (G5-B3) 兩個 ref 讓 mark 元件讀到最新的 branchById／onOpenBranch（ref 物件本身不變）
  const branchByIdRef = useRef(branchById);
  branchByIdRef.current = branchById;
  const onOpenBranchRef = useRef(onOpenBranch);
  onOpenBranchRef.current = onOpenBranch;
  // (L1-2) 提示段落同樣用 ref 讀最新值：hintById（String(hint.id) → hint）與 onHintClick
  const hintById = new Map(anchorHints.map((hint) => [String(hint.id), hint]));
  const hintByIdRef = useRef(hintById);
  hintByIdRef.current = hintById;
  const onHintClickRef = useRef(onHintClick);
  onHintClickRef.current = onHintClick;

  // (G5-B3) Markdown components 只建立一次（依 role 各一份）；每次渲染都用同一組函式身分，React 才不會重建 DOM
  const markdownComponents = useMemo(
    () => ({
      user: buildMarkdownComponents('user', branchByIdRef, onOpenBranchRef, hintByIdRef, onHintClickRef),
      assistant: buildMarkdownComponents('assistant', branchByIdRef, onOpenBranchRef, hintByIdRef, onHintClickRef),
    }),
    []
  );

  // 單段 Markdown 渲染（沿用同一套 components）
  const renderMarkdown = (content, role, key) => (
    <ReactMarkdown
      key={key}
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={role === 'assistant' ? [rehypeSourceOffsets] : []}
      components={markdownComponents[role === 'user' ? 'user' : 'assistant']}
    >
      {content}
    </ReactMarkdown>
  );

  // (E3) message id → 掛在這則 AI 回覆底部的入口（precise === false），依 created_at 排序
  const entriesByMessageId = useMemo(() => {
    const map = new Map();
    (branchList || []).forEach((branch) => {
      if (!branch?.anchor_message_id || branch.precise !== false) return;
      const list = map.get(branch.anchor_message_id);
      if (list) list.push(branch);
      else map.set(branch.anchor_message_id, [branch]);
    });
    map.forEach((list) =>
      list.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    );
    return map;
  }, [branchList]);

  // (E3) AI 回覆底部入口：只在主對話、有 id 的 AI 回覆、且掛有入口時才出現；點擊同 inline 高亮開分支
  const renderBranchEntries = (msg) => {
    if (!v.showBranchEntries || msg.role !== 'assistant' || !msg.id) return null;
    const entries = entriesByMessageId.get(msg.id);
    if (!entries?.length) return null;
    return (
      <div className={BRANCH_ENTRY_RULE_CLASS}>
        <div className={BRANCH_ENTRY_LIST_CLASS}>
          {entries.map((branch) => (
            <button
              key={branch.id}
              type="button"
              data-branch-entry={branch.id}
              onClick={() => onOpenBranch(branch)}
              title={`開啟分支：${branch.title || '新分支'}`}
              className={`${ANCHOR_MARK_CLASS} ${BRANCH_ENTRY_TEXT_CLASS}`}
            >
              {branch.anchor_text || branch.title || '新分支'}
            </button>
          ))}
        </div>
      </div>
    );
  };

  // (F8) 有 offset 的錨點：整段 Markdown 只渲染一次，由 rehypeHighlight 在 AST 內精準包 mark。
  // 這取代了舊的「依 anchor_text 切段」做法：切段會打斷段落結構（高亮自成一行），
  // 且相同文字會全部命中。
  const renderContent = (msg) => {
    const anchors = anchorsByMessageId.get(msg.id) || [];
    const precise = anchors
      .filter(
        (a) =>
          Number.isInteger(a?.anchor_start) &&
          Number.isInteger(a?.anchor_end) &&
          a.anchor_start < a.anchor_end
      )
      .map((a) => ({ id: a.id, start: a.anchor_start, end: a.anchor_end }));

    // (L1-2) 提示段落：跳過與真正錨點重疊的範圍，其餘併入同一條 rehypeHighlight 清單
    const hints = anchorHints
      .filter(
        (h) =>
          h?.message_id === msg.id &&
          Number.isInteger(h?.start) &&
          Number.isInteger(h?.end) &&
          h.start < h.end &&
          !precise.some((a) => h.start < a.end && h.end > a.start)
      )
      .map((h) => ({ id: h.id, start: h.start, end: h.end }));
    const combined = [...precise, ...hints];

    if (combined.length > 0) {
      return (
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={[[rehypeHighlight, combined]]}
          components={markdownComponents[msg.role === 'user' ? 'user' : 'assistant']}
        >
          {msg.content}
        </ReactMarkdown>
      );
    }

    // (E3) 沒有 offset 的分支不在內容裡高亮（不再用 anchor_text 子字串切段），只出現在底部入口
    return renderMarkdown(msg.content, msg.role);
  };

  // (F9-2) 正在編輯哪一則 user 訊息（id）；null = 沒有在編輯
  const [editingId, setEditingId] = useState(null);

  // (F9-2) 開始生成（例如編輯到一半從底部輸入框送出新訊息）→ 關掉編輯框，那則已經不是最後一則了
  useEffect(() => {
    if (isLoading) setEditingId(null);
  }, [isLoading]);

  // (F9-2) 這則 user 能不能編輯：由資料算出，不另存 state。
  // 條件：父層有傳 onEdit、非生成中、是 user、有 id、是倒數第二則（後面接的是最後一則 AI），且那則 AI 也有 id。
  const canEdit = (msg, index) =>
    !!onEdit &&
    !isLoading &&
    msg.role === 'user' &&
    !!msg.id &&
    index === messages.length - 2 &&
    messages[index + 1]?.role === 'assistant' &&
    !!messages[index + 1]?.id;

  // (F9-2) 這則現在是否顯示編輯框（editingId 對上，且仍符合 canEdit；切換對話等情況會自動不符合）
  const isEditingMsg = (msg, index) => editingId === msg.id && canEdit(msg, index);

  // 自動捲動到底部（只有在使用者已經接近底部時才捲，避免打斷往上讀歷史訊息）
  // (P3b-F1a-fix) 「是否在底部」改由 onScroll 持續維護（isAtBottom），
  //   並且一律「瞬間」貼底，避免 smooth 動畫在快速串流時永遠追不上。
  // (P3b-F1b) 若 App 已經標記要還原閱讀位置／對齊最後一則 user 訊息（restoreToken 遞增），
  // 就先跳過一次，避免載入對話的瞬間被拉回底部。
  const lastAutoScrollSkipToken = useRef(0);

  const getContainer = () => scrollContainerRef?.current || internalContainerRef?.current;

  // 瞬間捲到底（不觸發 smooth），並同步狀態
  const scrollToBottomNow = () => {
    const container = getContainer();
    if (container) container.scrollTop = container.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  };

  const handleScroll = () => {
    const container = getContainer();
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom <= 100;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  };

  useEffect(() => {
    if (skipAutoScrollToken != null && skipAutoScrollToken !== lastAutoScrollSkipToken.current) {
      lastAutoScrollSkipToken.current = skipAutoScrollToken;
      return;
    }
    if (!isAtBottomRef.current) return;
    scrollToBottomNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, skipAutoScrollToken, scrollContainerRef]);

  // 使用者自己送出訊息:不管目前在哪裡,都強制捲到底,
  // 並把「貼底」狀態設為 true,之後串流會繼續跟著捲
  const lastForceTokenRef = useRef(forceScrollToken);

  useEffect(() => {
    if (forceScrollToken === lastForceTokenRef.current) return; // 擋掉初次掛載
    lastForceTokenRef.current = forceScrollToken;

    isAtBottomRef.current = true; // 先標記貼底,讓原本的 effect 之後也會跟著串流捲
    scrollToBottomNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceScrollToken]);

  return (
    // (G3) 外層 relative：「回到底部」按鈕用 absolute 定位在這一區內，不會跑到分支面板上
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={(node) => {
          internalContainerRef.current = node;
          if (typeof scrollContainerRef === 'function') scrollContainerRef(node);
          else if (scrollContainerRef) scrollContainerRef.current = node;
        }}
        onScroll={handleScroll}
        onPointerOver={handleBranchPointerOver}
        onPointerOut={handleBranchPointerOut}
        onPointerLeave={clearBranchHover}
        className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6"
      >
        {messages.length === 0 ? (
          emptyState !== undefined ? (
            emptyState
          ) : (
            // --- 空狀態 (Empty State) ---
            <div className="h-full flex flex-col items-center justify-center text-gray-500 space-y-5">
              <div className="w-16 h-16 bg-[#51A8DD] rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-[#51A8DD]/30">
                <Bot className="w-8 h-8 text-white" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-2xl font-semibold text-gray-700 tracking-tight">今天想聊些什麼？</p>
                <p className="text-sm text-gray-400">選一個提示，或直接開始輸入</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-lg px-4">
                {['隨機介紹一個景點', '推薦一道食譜', '分享一本書給我', '講個笑話'].map(suggestion => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="p-4 bg-white/80 border border-[#7DB9DE] hover:bg-gray-100 hover:border-[#7DB9DE] hover:shadow-md rounded-2xl text-sm text-left transition-all cursor-pointer text-gray-600 font-medium"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          // --- 對話列表 (Chat List) ---
          // 修正重點 1: 使用 Fragment (<>...</>) 包裹多個元素
          <>
            {messages.map((msg, index) => {
              const isEditing = isEditingMsg(msg, index); // (F9-2) 這則 user 是否正在編輯
              return (
              <div
                key={index}
                // (P3b-F1b) scrollToMessage 靠這個屬性定位訊息；樂觀訊息還沒有 id 就不掛
                {...(msg.id ? { 'data-message-id': msg.id } : {})}
                className={`flex gap-4 max-w-4xl mx-auto group ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                {/* 頭像 */}
                {/* (G7) 手機版不顯示頭像，桌面才顯示 */}
                {v.showAvatar && (
                  <div className={`w-8 h-8 rounded-full hidden md:flex items-center justify-center flex-shrink-0 text-white shadow-sm ${msg.role === 'user' ? 'bg-[#51A8DD]' : 'bg-[#7B90D2]'}`}>
                    {msg.role === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
                  </div>
                )}

                {/* 訊息內容區塊 */}
                <div className={`flex flex-col ${
                  msg.role === 'user'
                    // User 保持原本的泡泡寬度限制；(F9-2) 編輯中加 w-full，撐到同一個上限，短訊息也有足夠空間改
                    ? `items-end max-w-[85%] md:max-w-[75%]${isEditing ? ' w-full' : ''}`
                    : 'items-start flex-1 min-w-0 md:mr-12' // AI 使用 flex-1 填滿右側所有剩餘空間，min-w-0 防止文字溢出破版（G7）手機不留右側空白
                }`}>
                
                  {/* (F9-2) 編輯中撐滿 user 欄，讓編輯框的 w-full 有寬度可撐 */}
                  <div className={`relative group/bubble${isEditing ? ' w-full' : ''}`}>
                    {/* 對話框 */}
                    {/* (F9-2) 編輯中：泡泡原地換成編輯框；不掛長按事件、不套 select-none（手機才能在框內選字） */}
                    {isEditing ? (
                      <UserMessageEditor
                        original={msg.content}
                        // (F9-2) 分支數：只算 branchList 裡掛在下一則 AI 上的（含空分支；不用 anchorsByMessageId）
                        branchCount={(branchList || []).filter((b) => b.anchor_message_id === messages[index + 1].id).length}
                        onSubmit={(text) => {
                          setEditingId(null);
                          onEdit(msg, messages[index + 1], text);
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                    /* (G8) user 氣泡：手機長按開選單，關閉原生選取與長按選單（max-md 只在手機生效） */
                    <div {...longPressProps(msg, index)} className={`
                      px-5 py-3.5 rounded-2xl leading-relaxed shadow-md border-1
                      ${msg.role === 'user'
                        ? 'bg-[#51A8DD] text-white rounded-tr-none border-[#51A8DD] max-md:select-none max-md:[-webkit-touch-callout:none]'
                        : 'bg-white text-gray-800 rounded-tl-none border border-[#7B90D2]'}
                    `}>
                      {/* (P2-4) 只有 AI 回覆可以「選取文字 → 建立分支」 */}
                      {/* (G5-B3) AI 內容區掛 data-branch-source／data-msg-id，供 selectionchange 判斷選取落在哪一則（不再用滑鼠放開事件） */}
                      <div
                        {...(msg.role === 'assistant' && msg.id
                          ? { 'data-branch-source': '', 'data-msg-id': msg.id }
                          : {})}
                        className="whitespace-normal break-words text-[15px] overflow-x-auto"
                      >
                        {/* (G9) user 訊息不走 markdown，改用 UserMessageContent（key 用 id，切換對話時重置摺疊） */}
                        {msg.content && msg.role === 'user' ? (
                          <UserMessageContent key={msg.id ?? `tmp-${index}`} content={msg.content} />
                        ) : msg.content ? (
                          renderContent(msg)
                        ) : (
                          <span className="animate-pulse text-gray-400">Thinking...</span>
                        )}
                      </div>
                      {/* (E3) AI 回覆底部的分支入口（橫線＋每行一個），只在主對話顯示 */}
                      {renderBranchEntries(msg)}
                    </div>
                    )}

                    {/* ★★★ 新增：發送時間 (只有 User 顯示) ★★★ */}
                    {/* (G8) 時間右邊放功能列；電腦版常態顯示，手機版隱藏（手機改用長按選單） */}
                    {/* (F9-2) 編輯中隱藏時間與功能列 */}
                    {msg.role === 'user' && !isEditing && (
                      <div className="mt-1.5 mr-1 flex items-center justify-end gap-2">
                        <span className="text-[11px] text-gray-400 select-none">
                          {formatShortDateTime(msg.created_at) || '剛剛發送'}
                        </span>
                        {/* (F9-2) 編輯入口：只有可編輯的那則才傳 onEdit（桌面功能列，複製的右邊） */}
                        {!!msg.content && (
                          <MessageActions
                            msg={msg}
                            className="hidden md:flex"
                            onEdit={canEdit(msg, index) ? () => setEditingId(msg.id) : undefined}
                          />
                        )}
                      </div>
                    )}
                  </div>

                  {/* 模型標籤 */}
                  {msg.role === 'assistant' && msg.model_used && (
                    <div className="mt-1.5 ml-1 text-[11px] text-gray-400 flex items-center gap-1 font-mono">
                      <Sparkles className="w-3 h-3 text-gray-400" />
                      {msg.model_used}
                    </div>
                  )}

                  {/* (G8) AI 訊息功能列：模型標籤下方，手機與電腦都常態顯示（有內容才顯示） */}
                  {/* (G6-2) 重新生成只給「最後一則 AI 回覆」：有 id、非串流中、且父層有傳 onRetry */}
                  {msg.role === 'assistant' && !!msg.content && (
                    <MessageActions
                      msg={msg}
                      className="mt-1 ml-0.5 flex"
                      onRetry={
                        onRetry && index === messages.length - 1 && msg.id && !isLoading
                          ? onRetry
                          : undefined
                      }
                    />
                  )}
                </div>
              </div>
              );
            })}

            {/* 自動捲動定位點 */}
            <div ref={messagesEndRef} />
          </>
        )}

        {/* ★★★ (P2-4) 選取 AI 文字後的浮動「建立分支」按鈕 ★★★ */}
        {/* 注意：不要在整個訊息容器上攔截 mousedown（例如 e.preventDefault()），否則會吃掉滑鼠預設行為、妨礙選取與複製。
            (G5-B3) 只有按鈕本身的 onMouseDown 擋預設行為：電腦點按鈕時不會先把選取清掉；其他地方的 Ctrl+C／右鍵複製不受影響。
            選取的文字在按鈕出現時已存進 branchSel state，因此 onClick 不需要靠 mousedown 保住選取。 */}
        {branchSel && (
          <button
            ref={branchBtnRef}
            data-branch-create=""
            onClick={createBranchFromSelection}
            onMouseDown={(e) => e.preventDefault()}
            style={{ left: branchSel.x, top: branchSel.y }}
            // (G5-B3) below：top 是按鈕上緣（不往上移）；above：top 是按鈕下緣（往上移整個按鈕高度）
            className={`fixed -translate-x-1/2 ${branchSel.placement === 'below' ? '' : '-translate-y-full'} z-50 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#7B90D2] hover:bg-[#51A8DD] rounded-full shadow-lg border border-white/50 transition-colors cursor-pointer`}
            title="用選取的文字建立新分支"
          >
            <GitBranch className="w-3.5 h-3.5" />
            建立分支
          </button>
        )}

        {/* (G8) 手機 user 氣泡長按後的浮動功能選單 */}
        {/* (F9-2) 「編輯」只在這則可編輯時才出現；點了由 MessageActionMenu 先關選單，這裡開編輯框 */}
        {actionMenu && (
          <MessageActionMenu
            msg={actionMenu.msg}
            anchorRect={actionMenu.rect}
            onEdit={
              canEdit(actionMenu.msg, actionMenu.index)
                ? () => setEditingId(actionMenu.msg.id)
                : undefined
            }
            onClose={() => setActionMenu(null)}
          />
        )}
      </div>
      {/* ★★★ (P3b-F1a-fix) 懸浮「回到底部」按鈕：只有不在底部且有訊息時才出現 ★★★ */}
      {/* (G3) absolute 相對於外層 relative，只會出現在自己這一區，不會跑到分支面板上 */}
      {!isAtBottom && messages.length > 0 && (
        <button
          onClick={scrollToBottomNow}
          title="回到底部"
          aria-label="回到底部"
          className="absolute bottom-4 right-4 z-30 flex items-center justify-center w-10 h-10 text-[#51A8DD] bg-white border border-[#7DB9DE] hover:bg-[#51A8DD] hover:text-white rounded-full shadow-lg transition-colors cursor-pointer"
        >
          <ArrowDown className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}

export default MessageList;
