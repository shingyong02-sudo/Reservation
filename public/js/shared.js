export function generateQueryCode(length = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉容易混淆的 0/O/1/I
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
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
