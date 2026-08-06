import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, query, where,
  runTransaction, addDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { generateQueryCode, todayStr, isoWeekday, slotLockId, escapeHtml, fmtStatus } from "./shared.js";

const tabBook = document.getElementById("tabBook");
const tabLookup = document.getElementById("tabLookup");
const viewBook = document.getElementById("viewBook");
const viewLookup = document.getElementById("viewLookup");

tabBook.addEventListener("click", () => switchTab("book"));
tabLookup.addEventListener("click", () => switchTab("lookup"));

function switchTab(name) {
  const isBook = name === "book";
  tabBook.classList.toggle("active", isBook);
  tabLookup.classList.toggle("active", !isBook);
  viewBook.classList.toggle("hidden", !isBook);
  viewLookup.classList.toggle("hidden", isBook);
}

/* ---------- 場地列表 ---------- */

const facilityGrid = document.getElementById("facilityGrid");
const bookingPanel = document.getElementById("bookingPanel");
let facilitiesCache = [];

async function loadFacilities() {
  facilityGrid.innerHTML = "<p>載入中…</p>";
  const snap = await getDocs(collection(db, "facilities"));
  facilitiesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  facilitiesCache.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (facilitiesCache.length === 0) {
    facilityGrid.innerHTML = "<p>目前尚未設定任何場地，請聯繫物業。</p>";
    return;
  }

  const cards = await Promise.all(facilitiesCache.map(renderFacilityCard));
  facilityGrid.innerHTML = cards.join("");

  facilitiesCache.forEach((f) => {
    const el = document.getElementById(`fac-${f.id}`);
    if (el && f.status !== "closed") {
      el.addEventListener("click", () => openBookingPanel(f.id));
    }
  });
}

async function isFacilityBlocked(facilityId) {
  const eqSnap = await getDocs(
    query(collection(db, "facilities", facilityId, "equipment"),
      where("essential", "==", true), where("status", "==", "maintenance"))
  );
  if (eqSnap.empty) return null;
  return eqSnap.docs.map((d) => d.data().name).join("、");
}

async function renderFacilityCard(f) {
  const blockedReason = f.status === "closed" ? null : await isFacilityBlocked(f.id);
  let badge = `<span class="badge open">開放預約</span>`;
  if (f.status === "closed") badge = `<span class="badge closed">場地暫停開放</span>`;
  else if (blockedReason) badge = `<span class="badge maintenance">必要設備維修中</span>`;

  const capacityLine = f.capacity
    ? `容納人數：${f.capacity} 人`
    : (f.unitCount ? `場地數量：${f.unitCount} 間` : "");

  return `
    <div class="card facility-card" id="fac-${f.id}">
      <h3>${escapeHtml(f.name)}</h3>
      <div class="meta">${capacityLine}</div>
      ${badge}
      ${blockedReason ? `<div class="alert warn">${escapeHtml(blockedReason)} 故障中，暫停預約</div>` : ""}
    </div>`;
}

/* ---------- 預約流程 ---------- */

let currentFacility = null;
let selectedSlot = null;

async function openBookingPanel(facilityId) {
  currentFacility = facilitiesCache.find((f) => f.id === facilityId);
  selectedSlot = null;

  const blockedReason = await isFacilityBlocked(facilityId);
  bookingPanel.classList.remove("hidden");
  bookingPanel.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(currentFacility.name)} — 選擇日期與時段</h3>
      ${blockedReason ? `<div class="alert warn">目前「${escapeHtml(blockedReason)}」維修中，此場地暫停預約，請稍後再試。</div>` : ""}
      <label>日期</label>
      <input type="date" id="bookDate" min="${todayStr()}" value="${todayStr()}" ${blockedReason ? "disabled" : ""}>
      <div id="slotArea"></div>
      <div id="bookForm" class="hidden">
        <label>姓名</label>
        <input type="text" id="applicantName" placeholder="請輸入姓名">
        <label>門牌號碼</label>
        <input type="text" id="houseNumber" placeholder="例如 3-5F 或 A棟501">
        <label>使用人數</label>
        <input type="number" id="peopleCount" min="1" value="1" ${currentFacility.capacity ? `max="${currentFacility.capacity}"` : ""}>
        <label>連絡電話（選填）</label>
        <input type="text" id="phone" placeholder="方便物業聯繫">
        <div id="bookAlert"></div>
        <button class="btn" id="submitBooking">送出預約</button>
      </div>
    </div>`;

  bookingPanel.scrollIntoView({ behavior: "smooth" });
  document.getElementById("bookDate").addEventListener("change", loadSlots);
  if (!blockedReason) loadSlots();
}

async function loadSlots() {
  const date = document.getElementById("bookDate").value;
  const slotArea = document.getElementById("slotArea");
  document.getElementById("bookForm").classList.add("hidden");
  selectedSlot = null;
  slotArea.innerHTML = "<p>載入時段中…</p>";

  const weekday = isoWeekday(date);
  const tplSnap = await getDocs(collection(db, "facilities", currentFacility.id, "timeSlotTemplates"));
  const templates = tplSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => (t.weekdays || []).includes(weekday))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  if (templates.length === 0) {
    slotArea.innerHTML = `<div class="alert warn">這天沒有開放時段</div>`;
    return;
  }

  const lockSnap = await getDocs(
    query(collection(db, "slotLocks"),
      where("facilityId", "==", currentFacility.id),
      where("date", "==", date),
      where("status", "in", ["confirmed", "pending_review"]))
  );
  const taken = new Set(lockSnap.docs.map((d) => d.data().slotId));

  slotArea.innerHTML = `<div class="slot-grid">${templates.map((t) => `
      <div class="slot-btn ${taken.has(t.id) ? "taken" : ""}" data-slot="${t.id}"
           data-start="${t.startTime}" data-end="${t.endTime}" data-label="${t.label || (t.startTime + '-' + t.endTime)}">
        ${escapeHtml(t.label || `${t.startTime}-${t.endTime}`)}
      </div>`).join("")}</div>`;

  slotArea.querySelectorAll(".slot-btn:not(.taken)").forEach((btn) => {
    btn.addEventListener("click", () => {
      slotArea.querySelectorAll(".slot-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedSlot = {
        id: btn.dataset.slot, startTime: btn.dataset.start,
        endTime: btn.dataset.end, label: btn.dataset.label,
      };
      document.getElementById("bookForm").classList.remove("hidden");
    });
  });
}

document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "submitBooking") submitBooking();
});

async function submitBooking() {
  const date = document.getElementById("bookDate").value;
  const applicantName = document.getElementById("applicantName").value.trim();
  const houseNumber = document.getElementById("houseNumber").value.trim();
  const peopleCount = Number(document.getElementById("peopleCount").value);
  const phone = document.getElementById("phone").value.trim();
  const alertBox = document.getElementById("bookAlert");
  alertBox.innerHTML = "";

  if (!selectedSlot) return showAlert(alertBox, "請先選擇時段");
  if (!applicantName || !houseNumber) return showAlert(alertBox, "請填寫姓名與門牌號碼");
  if (!peopleCount || peopleCount < 1) return showAlert(alertBox, "使用人數需至少 1 人");
  if (currentFacility.capacity && peopleCount > currentFacility.capacity) {
    return showAlert(alertBox, `使用人數不可超過容納人數（${currentFacility.capacity} 人）`);
  }

  const submitBtn = document.getElementById("submitBooking");
  submitBtn.disabled = true;
  submitBtn.textContent = "送出中…";

  try {
    const { start: weekStart } = weekRangeOf(date);
    const dailyUsageRef = doc(db, "unitDailyUsage", `${currentFacility.id}__${houseNumber}__${date}`);
    const weeklyUsageRef = doc(db, "unitWeeklyUsage", `${currentFacility.id}__${houseNumber}__${weekStart}`);

    // 注意：Firestore 的 client transaction.get() 只接受單一文件參照、不支援查詢，
    // 所以「同門牌次數上限」改用專屬計數文件（不含姓名/電話等個資）在交易內讀寫，
    // 避免要求住戶端擁有列出整個 bookings 集合的權限（那會洩漏其他住戶的個資）。
    const result = await runTransaction(db, async (tx) => {
      const facilityRef = doc(db, "facilities", currentFacility.id);
      const facilitySnap = await tx.get(facilityRef);
      if (!facilitySnap.exists() || facilitySnap.data().status === "closed") {
        throw new Error("此場地目前不開放預約");
      }
      const fdata = facilitySnap.data();

      const lockRef = doc(db, "slotLocks", slotLockId(currentFacility.id, date, selectedSlot.id));
      const lockSnap = await tx.get(lockRef);
      if (lockSnap.exists() && ["confirmed", "pending_review"].includes(lockSnap.data().status)) {
        throw new Error("SLOT_TAKEN");
      }

      const dailySnap = fdata.dailyLimitPerUnit ? await tx.get(dailyUsageRef) : null;
      const weeklySnap = fdata.weeklyLimitPerUnit ? await tx.get(weeklyUsageRef) : null;
      const dailyCount = dailySnap?.exists() ? dailySnap.data().count : 0;
      const weeklyCount = weeklySnap?.exists() ? weeklySnap.data().count : 0;
      if (fdata.dailyLimitPerUnit && dailyCount >= fdata.dailyLimitPerUnit) throw new Error("DAILY_LIMIT");
      if (fdata.weeklyLimitPerUnit && weeklyCount >= fdata.weeklyLimitPerUnit) throw new Error("WEEKLY_LIMIT");

      const status = fdata.bookingMode === "review" ? "pending_review" : "confirmed";
      const queryCode = generateQueryCode();
      const bookingRef = doc(db, "bookings", queryCode);

      tx.set(bookingRef, {
        facilityId: currentFacility.id, facilityName: fdata.name, date,
        slotId: selectedSlot.id, startTime: selectedSlot.startTime, endTime: selectedSlot.endTime,
        slotLabel: selectedSlot.label, applicantName, houseNumber, peopleCount,
        phone: phone || null, status, createdAt: serverTimestamp(), cancelledAt: null,
      });
      tx.set(lockRef, {
        facilityId: currentFacility.id, date, slotId: selectedSlot.id,
        status, bookingId: queryCode, createdAt: serverTimestamp(),
      });
      if (fdata.dailyLimitPerUnit) tx.set(dailyUsageRef, { count: dailyCount + 1 });
      if (fdata.weeklyLimitPerUnit) tx.set(weeklyUsageRef, { count: weeklyCount + 1 });

      return { queryCode, status };
    });

    addDoc(collection(db, "bookingLogs"), {
      targetType: "booking", targetId: result.queryCode, action: "create", actor: "resident",
      detail: { facilityId: currentFacility.id, date, slotId: selectedSlot.id }, timestamp: serverTimestamp(),
    }).catch(() => {});

    showSuccess(result.queryCode, result.status);
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = "送出預約";
    const map = {
      SLOT_TAKEN: "這個時段剛被別人訂走了，請重新選擇時段",
      DAILY_LIMIT: "同一門牌今天在此場地的預約已達上限",
      WEEKLY_LIMIT: "同一門牌本週在此場地的預約已達上限",
    };
    showAlert(alertBox, map[err.message] || `送出失敗：${err.message}`);
  }
}

function weekRangeOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const wd = isoWeekday(dateStr); // 1..7
  const monday = new Date(d); monday.setDate(d.getDate() - (wd - 1));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const fmt = (x) => x.toISOString().slice(0, 10);
  return { start: fmt(monday), end: fmt(sunday) };
}

function showAlert(box, msg) { box.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`; }

function showSuccess(queryCode, status) {
  bookingPanel.innerHTML = `
    <div class="card">
      <h3>${status === "pending_review" ? "已送出，待物業審核" : "預約成功"}</h3>
      <p>請截圖保存以下查詢碼，之後可用「查詢/取消」頁面查詢或取消此預約：</p>
      <div class="query-code">${queryCode}</div>
      ${status === "pending_review" ? `<div class="alert warn">此場地需物業審核，審核通過後才算確定。</div>` : ""}
      <button class="btn secondary" onclick="location.reload()">再預約一筆</button>
    </div>`;
}

/* ---------- 查詢 / 取消 ---------- */

document.getElementById("lookupBtn").addEventListener("click", doLookup);

async function doLookup() {
  const code = document.getElementById("lookupCode").value.trim().toUpperCase();
  const house = document.getElementById("lookupHouse").value.trim();
  const result = document.getElementById("lookupResult");
  result.innerHTML = "";
  if (!code || !house) {
    result.innerHTML = `<div class="alert error">請輸入查詢碼與門牌號碼</div>`;
    return;
  }
  const snap = await getDoc(doc(db, "bookings", code));
  if (!snap.exists()) {
    result.innerHTML = `<div class="alert error">查無此預約，請確認查詢碼是否正確</div>`;
    return;
  }
  const b = snap.data();
  if (b.houseNumber !== house) {
    result.innerHTML = `<div class="alert error">門牌號碼不相符</div>`;
    return;
  }

  const canCancel = ["confirmed", "pending_review"].includes(b.status) && b.date >= todayStr();
  result.innerHTML = `
    <div class="card">
      <h3>${escapeHtml(b.facilityName)}</h3>
      <p>日期：${escapeHtml(b.date)}　時段：${escapeHtml(b.slotLabel || `${b.startTime}-${b.endTime}`)}</p>
      <p>申請人：${escapeHtml(b.applicantName)}　門牌：${escapeHtml(b.houseNumber)}　人數：${b.peopleCount}</p>
      <p>狀態：${fmtStatus(b.status)}</p>
      ${canCancel ? `<button class="btn danger" id="cancelBtn">取消此預約</button>` : ""}
      <div id="cancelAlert"></div>
    </div>`;

  if (canCancel) {
    document.getElementById("cancelBtn").addEventListener("click", () => doCancel(code));
  }
}

async function doCancel(code) {
  if (!confirm("確定要取消此預約嗎？")) return;
  try {
    await updateDoc(doc(db, "bookings", code), { status: "cancelled", cancelledAt: serverTimestamp() });
    addDoc(collection(db, "bookingLogs"), {
      targetType: "booking", targetId: code, action: "cancel", actor: "resident",
      detail: {}, timestamp: serverTimestamp(),
    }).catch(() => {});
    document.getElementById("lookupResult").innerHTML =
      `<div class="alert ok">已取消。時段的正式釋出將由物業協助處理，若急需該時段請聯繫社區辦公室。</div>`;
  } catch (err) {
    document.getElementById("cancelAlert").innerHTML = `<div class="alert error">取消失敗：${escapeHtml(err.message)}</div>`;
  }
}

loadFacilities();
