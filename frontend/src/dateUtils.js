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
