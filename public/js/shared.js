export function generateQueryCode(length = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉容易混淆的 0/O/1/I
  // 用 crypto 取代 Math.random：查詢碼等同於取消預約的憑證，
  // Math.random 可被預測，不該拿來產生任何具有權限意義的字串
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) out += chars[buf[i] % chars.length];
  return out;
}

export function todayStr() {
  return dateToStr(new Date());
}

export function dateToStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// JS getDay(): 0=週日...6=週六 → 轉成 1=週一...7=週日，跟後台的 weekdays 設定對齊
export function isoWeekday(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const jsDay = d.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

// 回傳該日期所屬那一週的週一（本地時區）。
// 注意：不可用 toISOString()，那會轉成 UTC，在台灣（UTC+8）會整個往前一天。
export function weekStartOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - (isoWeekday(dateStr) - 1));
  return dateToStr(d);
}

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
    confirmed: "已確認",
    pending_review: "待審核",
    cancelled: "已取消",
    rejected: "已拒絕",
  }[status] || status;
}

// 把日期字串轉成人看得懂的格式：2026-08-06 → 8月6日（週四）
export function fmtDateHuman(dateStr) {
  const names = ["一", "二", "三", "四", "五", "六", "日"];
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}月${Number(d)}日（週${names[isoWeekday(dateStr) - 1]}）`;
}

// 把 Firestore 的錯誤轉成住戶看得懂的話，而不是直接把英文錯誤碼丟到畫面上
export function friendlyError(err) {
  const byCode = {
    "permission-denied": "沒有權限執行這個動作，請聯繫社區辦公室。",
    unavailable: "連線不穩，請確認網路後再試一次。",
    "deadline-exceeded": "連線逾時，請再試一次。",
    "not-found": "找不到資料，可能已被移除。",
  };
  const known = {
    SLOT_TAKEN: "這個時段剛被別人訂走了，請重新選擇時段。",
    DAILY_LIMIT: "同一門牌今天在此場地的預約已達上限。",
    WEEKLY_LIMIT: "同一門牌本週在此場地的預約已達上限。",
    FACILITY_CLOSED: "此場地目前不開放預約。",
  };
  return known[err?.message] || byCode[err?.code] || `操作失敗：${err?.message || "未知錯誤"}`;
}
