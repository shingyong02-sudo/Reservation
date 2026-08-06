/* 全站共用設定與工具函式 */

export const COMMUNITY = { 
  name: "聯懋超綻",
  org: "聯懋超綻管理委員會",
  subtitle: "公共設施預約系統",
  sealGlyphs: ["聯", "懋", "超", "綻"],
  phone: "03-8888-5678",
  serviceHours: "09:00 – 18:00",
  // 開放預約的天數範圍（今天起算）
  bookingWindowDays: 14,
};

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉容易混淆的 0/O/1/I

// 查詢碼格式：兩碼英文 + 連字號 + 五碼英數，例：YX-8F2K6
// 用 crypto 而非 Math.random：查詢碼等同取消預約的憑證，不可被預測
export function generateQueryCode() {
  const buf = new Uint32Array(7);
  crypto.getRandomValues(buf);
  const letters = CODE_CHARS.slice(0, 24); // 只取英文字母段
  const pick = (i, pool) => pool[buf[i] % pool.length];
  const head = pick(0, letters) + pick(1, letters);
  let tail = "";
  for (let i = 2; i < 7; i++) tail += pick(i, CODE_CHARS);
  return `${head}-${tail}`;
}

// 使用者可能輸入小寫或漏打連字號，統一正規化後再比對
export function normalizeCode(raw) {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 7 ? `${s.slice(0, 2)}-${s.slice(2)}` : s;
}

export function todayStr() { return dateToStr(new Date()); }

export function dateToStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDate(dateStr) { return new Date(dateStr + "T00:00:00"); }

export function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}

// JS getDay(): 0=週日…6=週六 → 轉成 1=週一…7=週日，與後台 weekdays 設定對齊
export function isoWeekday(dateStr) {
  const jsDay = parseDate(dateStr).getDay();
  return jsDay === 0 ? 7 : jsDay;
}

// 回傳該日期所屬那一週的週一（本地時區）。
// 不可用 toISOString()：那會轉成 UTC，在台灣（UTC+8）整整往前一天。
export function weekStartOf(dateStr) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() - (isoWeekday(dateStr) - 1));
  return dateToStr(d);
}

export const WEEKDAY_LABEL = ["一", "二", "三", "四", "五", "六", "日"];

export function slotLockId(facilityId, date, slotId) {
  return `${facilityId}__${date}__${slotId}`;
}

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function fmtStatus(status) {
  return {
    confirmed: "預約成立", pending_review: "待審核",
    cancelled: "已取消", rejected: "已拒絕",
  }[status] || status;
}

// 2026-08-06 → 8月6日（週四）
export function fmtDateHuman(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}月${Number(d)}日（週${WEEKDAY_LABEL[isoWeekday(dateStr) - 1]}）`;
}

// 2026-08-06 → 2026/08/06（四）
export function fmtDateFull(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${y}/${m}/${d}（${WEEKDAY_LABEL[isoWeekday(dateStr) - 1]}）`;
}

export function fmtSlot(s) {
  return `${s.startTime} – ${s.endTime}`;
}

// 把 Firestore 的錯誤轉成住戶看得懂的話，而不是把英文錯誤碼丟到畫面上
export function friendlyError(err) {
  const byCode = {
    "permission-denied": "沒有權限執行這個動作，請聯繫物業管理中心。",
    unavailable: "連線不穩，請確認網路後再試一次。",
    "deadline-exceeded": "連線逾時，請再試一次。",
    "not-found": "找不到資料，可能已被移除。",
  };
  const known = {
    SLOT_TAKEN: "這個時段剛被其他住戶預約了，請重新選擇。",
    SAME_SLOT_OTHER_FACILITY: "同一時段每戶限預約一項設施，您在這個時段已有其他場地的預約。",
    DAILY_LIMIT: "同一門牌今日在此場地的預約已達上限。",
    WEEKLY_LIMIT: "同一門牌本週在此場地的預約已達上限。",
    FACILITY_CLOSED: "此場地目前暫停開放預約。",
    OUT_OF_WINDOW: `僅開放預約今日起 ${COMMUNITY.bookingWindowDays} 天內的時段。`,
  };
  return known[err?.message] || byCode[err?.code] || `操作失敗：${err?.message || "未知錯誤"}`;
}

// 版首／頁尾的印章標記，兩個頁面共用同一份，改一處即可
export function sealHtml(extraClass = "") {
  return `<span class="seal ${extraClass}" aria-hidden="true">${
    COMMUNITY.sealGlyphs.map((g) => `<span>${g}</span>`).join("")}</span>`;
}
