// 共用的時間格式化工具
//
// 後端一律回傳「UTC 且結尾帶 Z」的 ISO 字串 (例如 2026-10-09T08:56:25.138679Z)。
// 舊寫法是 targetTime + (targetTime.endsWith("Z") ? "" : "Z")，
// 一旦後端回傳帶 offset 的字串 (例如 ...+08:00) 就會变成 "...+08:00Z" → Invalid Date。
// 這裡改成用正規表示式判斷，只要字串本身沒有時區資訊才補 Z，比較安全。

const HAS_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * 把後端回傳的時間字串轉成 Date 物件。
 * 若字串沒有時區標記，視為 UTC (資料庫存的就是 UTC)。
 * 回傳 null 代表無效或沒有值，呼叫端要自己處理，避免顯示 Invalid Date。
 */
export function parseUTCDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const normalized = HAS_TIMEZONE.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 用瀏覽器自己的時區顯示 (不再寫死 Asia/Taipei)
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * 格式化側邊欄用的完整日期時間，依「使用者所在時區」顯示。
 * 無效值回傳空字串，畫面上就不會出現 Invalid Date。
 */
export function formatDateTime(value) {
  const date = parseUTCDate(value);
  if (!date) return "";
  return date.toLocaleString("zh-TW", {
    timeZone: LOCAL_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * 格式化訊息氣泡下方的較短時間 (月/日 時:分)，依使用者時區顯示。
 */
export function formatShortDateTime(value) {
  const date = parseUTCDate(value);
  if (!date) return "";
  return date.toLocaleString("zh-TW", {
    timeZone: LOCAL_TIME_ZONE,
    hour12: false,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// 側邊欄時間軸分組
// ---------------------------------------------------------------------------

// 取得「當地時間零點」，用來算日历天數差；用 round 吸收夏令時間造成的 1 小時誤差。
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetweenInLocalDays(from, to) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round(
    (startOfLocalDay(to).getTime() - startOfLocalDay(from).getTime()) / MS_PER_DAY
  );
}

// 分組依據跟著排序走：updated 用子樹最新活動時間，created 用根節點建立時間。
// last_activity 理論上一定存在，缺值時退回 created_at，避免該列無法分組。
function timeOfChat(chat, sortMode) {
  if (sortMode === "updated") {
    return chat.last_activity || chat.created_at;
  }
  return chat.created_at;
}

/**
 * 算出單筆對話所屬的時間群組。
 * 規則：今天 / 昨天 / 近 7 天 / 近 30 天 / 本月 / 更早（依年月）。
 * 回傳 { key, label }；key 用於 React key 與分組比對，label 顯示在群組標題。
 */
function resolveTimeGroup(chat, sortMode, now) {
  const raw = timeOfChat(chat, sortMode);
  const date = parseUTCDate(raw);

  // 後端沒給時間或時間無法解析時，集中到最後一組，不要讓它消失在列表裡
  if (!date) {
    return { key: "unknown", label: "其他" };
  }

  const diffDays = daysBetweenInLocalDays(date, now);

  if (diffDays <= 0) return { key: "today", label: "今天" };
  if (diffDays === 1) return { key: "yesterday", label: "昨天" };
  if (diffDays <= 7) return { key: "week", label: "近 7 天" };
  if (diffDays <= 30) return { key: "month30", label: "近 30 天" };

  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return { key: "current-month", label: "本月" };
  }

  const pad = (n) => String(n).padStart(2, "0");
  return {
    key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}`,
    label: `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`,
  };
}

/**
 * 依時間軸把側邊欄列表分組。
 * @param {Array} list  後端 /chats/roots 回傳的對話列表（已由後端排好新→舊）
 * @param {string} sortMode  'updated' | 'created'，決定分組依據
 * @returns {Array<{ key: string, label: string, items: Array }>}
 *
 * 群組順序跟隨列表順序（列表本身就是新→舊），同一群組只出現一次；
 * 空群組不會出現在結果裡。
 */
export function groupByTimeRange(list, sortMode = "updated") {
  if (!Array.isArray(list) || list.length === 0) return [];

  const now = new Date();
  const groups = [];
  const indexByKey = new Map();

  for (const chat of list) {
    const { key, label } = resolveTimeGroup(chat, sortMode, now);
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      indexByKey.set(key, idx);
      groups.push({ key, label, items: [] });
    }
    groups[idx].items.push(chat);
  }

  return groups;
}

