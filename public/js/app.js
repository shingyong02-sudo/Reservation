import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, query, where,
  runTransaction, addDoc, updateDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  generateQueryCode, todayStr, isoWeekday, weekStartOf, slotLockId,
  escapeHtml, fmtStatus, fmtDateHuman, friendlyError,
} from "./shared.js";

const $ = (id) => document.getElementById(id);

const tabBook = $("tabBook");
const tabLookup = $("tabLookup");
const viewBook = $("viewBook");
const viewLookup = $("viewLookup");

tabBook.addEventListener("click", () => switchTab("book"));
tabLookup.addEventListener("click", () => switchTab("lookup"));

function switchTab(name) {
  const isBook = name === "book";
  tabBook.classList.toggle("active", isBook);
  tabLookup.classList.toggle("active", !isBook);
  tabBook.setAttribute("aria-selected", String(isBook));
  tabLookup.setAttribute("aria-selected", String(!isBook));
  viewBook.classList.toggle("hidden", !isBook);
  viewLookup.classList.toggle("hidden", isBook);
}

/* ---------- 場地列表 ---------- */

const facilityGrid = $("facilityGrid");
const bookingPanel = $("bookingPanel");
let facilitiesCache = [];
const blockedCache = new Map(); // facilityId → 故障的必要設備名稱字串，或 null

async function loadFacilities() {
  facilityGrid.innerHTML = skeletonCards(6);
  try {
    const snap = await getDocs(collection(db, "facilities"));
    facilitiesCache = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    if (facilitiesCache.length === 0) {
      facilityGrid.innerHTML = `<p class="empty">目前尚未設定任何場地，請聯繫物業。</p>`;
      return;
    }

    // 每個場地的必要設備狀態平行查詢一次，結果存進 blockedCache 供後續重用，
    // 避免點進預約面板時又打一次同樣的查詢
    await Promise.all(facilitiesCache.map(async (f) => {
      blockedCache.set(f.id, f.status === "closed" ? null : await fetchBlockedReason(f.id));
    }));

    facilityGrid.innerHTML = facilitiesCache.map(renderFacilityCard).join("");
    facilitiesCache.forEach((f) => {
      const el = $(`fac-${f.id}`);
      if (el) el.addEventListener("click", () => openBookingPanel(f.id));
    });
  } catch (err) {
    facilityGrid.innerHTML =
      `<div class="alert error" role="alert">場地載入失敗：${escapeHtml(friendlyError(err))}
       <button class="btn small secondary" id="retryLoad">重新載入</button></div>`;
    $("retryLoad")?.addEventListener("click", loadFacilities);
  }
}

function skeletonCards(n) {
  return Array.from({ length: n }, () =>
    `<div class="card skeleton" aria-hidden="true"><div class="sk-line sk-title"></div><div class="sk-line"></div></div>`
  ).join("");
}

async function fetchBlockedReason(facilityId) {
  const eqSnap = await getDocs(
    query(collection(db, "facilities", facilityId, "equipment"),
      where("essential", "==", true), where("status", "==", "maintenance"))
  );
  return eqSnap.empty ? null : eqSnap.docs.map((d) => d.data().name).join("、");
}

function renderFacilityCard(f) {
  const blocked = blockedCache.get(f.id);
  const closed = f.status === "closed";
  const disabled = closed || !!blocked;

  let badge = `<span class="badge open">開放預約</span>`;
  if (closed) badge = `<span class="badge closed">場地暫停開放</span>`;
  else if (blocked) badge = `<span class="badge maintenance">必要設備維修中</span>`;

  const capacityLine = f.capacity
    ? `可容納 ${f.capacity} 人`
    : (f.unitCount ? `共 ${f.unitCount} 間` : "");

  // 用真正的 <button> 而不是可點的 <div>，鍵盤與螢幕報讀器才能操作
  return `
    <button type="button" class="card facility-card" id="fac-${f.id}" ${disabled ? "disabled" : ""}>
      <h3>${escapeHtml(f.name)}</h3>
      <div class="meta">${escapeHtml(capacityLine)}</div>
      ${badge}
      ${blocked ? `<div class="alert warn">${escapeHtml(blocked)} 故障中，暫停預約</div>` : ""}
    </button>`;
}

/* ---------- 預約流程 ---------- */

let currentFacility = null;
let selectedSlot = null;

function openBookingPanel(facilityId) {
  currentFacility = facilitiesCache.find((f) => f.id === facilityId);
  selectedSlot = null;

  bookingPanel.classList.remove("hidden");
  bookingPanel.innerHTML = `
    <div class="card">
      <button type="button" class="btn small secondary back-btn" id="backToList">← 回場地列表</button>
      <h3>${escapeHtml(currentFacility.name)}</h3>
      <label for="bookDate">選擇日期</label>
      <input type="date" id="bookDate" min="${todayStr()}" value="${todayStr()}">
      <div id="slotArea"></div>
      <div id="bookForm" class="hidden">
        <label for="applicantName">姓名</label>
        <input type="text" id="applicantName" autocomplete="name" placeholder="請輸入姓名">
        <label for="houseNumber">門牌號碼</label>
        <input type="text" id="houseNumber" placeholder="例如 A棟-1201">
        <label for="peopleCount">使用人數</label>
        <input type="number" id="peopleCount" min="1" value="1"
               ${currentFacility.capacity ? `max="${currentFacility.capacity}"` : ""}>
        <label for="phone">連絡電話（選填）</label>
        <input type="tel" id="phone" autocomplete="tel" placeholder="方便物業聯繫">
        <div id="bookAlert" role="alert" aria-live="assertive"></div>
        <button type="button" class="btn" id="submitBooking">送出預約</button>
      </div>
    </div>`;

  bookingPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  $("backToList").addEventListener("click", closeBookingPanel);
  $("bookDate").addEventListener("change", loadSlots);
  $("submitBooking")?.addEventListener("click", submitBooking);
  loadSlots();
}

function closeBookingPanel() {
  bookingPanel.classList.add("hidden");
  bookingPanel.innerHTML = "";
  currentFacility = null;
  selectedSlot = null;
  facilityGrid.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadSlots() {
  const date = $("bookDate").value;
  const slotArea = $("slotArea");
  $("bookForm").classList.add("hidden");
  selectedSlot = null;
  slotArea.innerHTML = `<p class="loading">載入時段中…</p>`;

  try {
    const weekday = isoWeekday(date);
    const [tplSnap, lockSnap] = await Promise.all([
      getDocs(collection(db, "facilities", currentFacility.id, "timeSlotTemplates")),
      getDocs(query(collection(db, "slotLocks"),
        where("facilityId", "==", currentFacility.id),
        where("date", "==", date),
        where("status", "in", ["confirmed", "pending_review"]))),
    ]);

    const templates = tplSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => (t.weekdays || []).includes(weekday))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    if (templates.length === 0) {
      slotArea.innerHTML = `<div class="alert warn">${fmtDateHuman(date)}沒有開放時段，請改選其他日期。</div>`;
      return;
    }

    const taken = new Set(lockSnap.docs.map((d) => d.data().slotId));
    const available = templates.filter((t) => !taken.has(t.id)).length;

    slotArea.innerHTML = `
      <p class="slot-hint">${fmtDateHuman(date)}　可預約 ${available} / ${templates.length} 個時段</p>
      <div class="slot-grid" role="group" aria-label="可選時段">
        ${templates.map((t) => {
          const label = t.label || `${t.startTime}-${t.endTime}`;
          const isTaken = taken.has(t.id);
          return `<button type="button" class="slot-btn ${isTaken ? "taken" : ""}"
                    data-slot="${escapeHtml(t.id)}" aria-pressed="false"
                    ${isTaken ? "disabled" : ""}>
                    <span class="slot-label">${escapeHtml(label)}</span>
                    <span class="slot-time">${escapeHtml(t.startTime)}–${escapeHtml(t.endTime)}</span>
                    ${isTaken ? `<span class="slot-taken-tag">已被預約</span>` : ""}
                  </button>`;
        }).join("")}
      </div>`;

    slotArea.querySelectorAll(".slot-btn:not([disabled])").forEach((btn) => {
      btn.addEventListener("click", () => {
        slotArea.querySelectorAll(".slot-btn").forEach((b) => {
          b.classList.remove("selected");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("selected");
        btn.setAttribute("aria-pressed", "true");
        const t = templates.find((x) => x.id === btn.dataset.slot);
        selectedSlot = {
          id: t.id, startTime: t.startTime, endTime: t.endTime,
          label: t.label || `${t.startTime}-${t.endTime}`,
        };
        $("bookForm").classList.remove("hidden");
        $("applicantName").focus();
      });
    });
  } catch (err) {
    slotArea.innerHTML = `<div class="alert error" role="alert">${escapeHtml(friendlyError(err))}</div>`;
  }
}

async function submitBooking() {
  const date = $("bookDate").value;
  const applicantName = $("applicantName").value.trim();
  const houseNumber = $("houseNumber").value.trim();
  const peopleCount = Number($("peopleCount").value);
  const phone = $("phone").value.trim();
  const alertBox = $("bookAlert");
  alertBox.innerHTML = "";

  if (!selectedSlot) return showAlert(alertBox, "請先選擇時段");
  if (!applicantName) { showAlert(alertBox, "請填寫姓名"); return $("applicantName").focus(); }
  if (!houseNumber) { showAlert(alertBox, "請填寫門牌號碼"); return $("houseNumber").focus(); }
  if (!peopleCount || peopleCount < 1) { showAlert(alertBox, "使用人數需至少 1 人"); return $("peopleCount").focus(); }
  if (currentFacility.capacity && peopleCount > currentFacility.capacity) {
    showAlert(alertBox, `使用人數不可超過容納人數（${currentFacility.capacity} 人）`);
    return $("peopleCount").focus();
  }

  const submitBtn = $("submitBooking");
  submitBtn.disabled = true;
  submitBtn.textContent = "送出中…";

  const dailyRef = doc(db, "unitDailyUsage", `${currentFacility.id}__${houseNumber}__${date}`);
  const weeklyRef = doc(db, "unitWeeklyUsage", `${currentFacility.id}__${houseNumber}__${weekStartOf(date)}`);

  try {
    const result = await runTransaction(db, async (tx) => {
      const facilitySnap = await tx.get(doc(db, "facilities", currentFacility.id));
      if (!facilitySnap.exists() || facilitySnap.data().status === "closed") {
        throw new Error("FACILITY_CLOSED");
      }
      const fdata = facilitySnap.data();

      const lockRef = doc(db, "slotLocks", slotLockId(currentFacility.id, date, selectedSlot.id));
      const lockSnap = await tx.get(lockRef);
      if (lockSnap.exists() && ["confirmed", "pending_review"].includes(lockSnap.data().status)) {
        throw new Error("SLOT_TAKEN");
      }

      // 次數上限用專屬計數文件在交易內讀寫。Firestore 的 client transaction.get()
      // 只接受單一文件參照、不支援查詢，而且計數文件不含個資，
      // 住戶端才不必擁有列出整個 bookings 集合的權限。
      const dailySnap = fdata.dailyLimitPerUnit ? await tx.get(dailyRef) : null;
      const weeklySnap = fdata.weeklyLimitPerUnit ? await tx.get(weeklyRef) : null;
      const dailyCount = dailySnap?.exists() ? dailySnap.data().count : 0;
      const weeklyCount = weeklySnap?.exists() ? weeklySnap.data().count : 0;
      if (fdata.dailyLimitPerUnit && dailyCount >= fdata.dailyLimitPerUnit) throw new Error("DAILY_LIMIT");
      if (fdata.weeklyLimitPerUnit && weeklyCount >= fdata.weeklyLimitPerUnit) throw new Error("WEEKLY_LIMIT");

      const status = fdata.bookingMode === "review" ? "pending_review" : "confirmed";
      const queryCode = generateQueryCode();

      tx.set(doc(db, "bookings", queryCode), {
        facilityId: currentFacility.id, facilityName: fdata.name, date,
        slotId: selectedSlot.id, startTime: selectedSlot.startTime, endTime: selectedSlot.endTime,
        slotLabel: selectedSlot.label, applicantName, houseNumber, peopleCount,
        phone: phone || null, status, createdAt: serverTimestamp(), cancelledAt: null,
      });
      tx.set(lockRef, {
        facilityId: currentFacility.id, date, slotId: selectedSlot.id,
        status, bookingId: queryCode, createdAt: serverTimestamp(),
      });
      if (fdata.dailyLimitPerUnit) tx.set(dailyRef, { count: dailyCount + 1 });
      if (fdata.weeklyLimitPerUnit) tx.set(weeklyRef, { count: weeklyCount + 1 });

      return { queryCode, status, date, slotLabel: selectedSlot.label, facilityName: fdata.name };
    });

    addDoc(collection(db, "bookingLogs"), {
      targetType: "booking", targetId: result.queryCode, action: "create", actor: "resident",
      detail: { facilityId: currentFacility.id, date, slotId: selectedSlot.id }, timestamp: serverTimestamp(),
    }).catch(() => {});

    showSuccess(result);
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = "送出預約";
    showAlert(alertBox, friendlyError(err));
    if (err.message === "SLOT_TAKEN") loadSlots(); // 重新整理時段，讓住戶馬上看到最新狀態
  }
}

function showAlert(box, msg) {
  box.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`;
}

function showSuccess({ queryCode, status, date, slotLabel, facilityName }) {
  bookingPanel.innerHTML = `
    <div class="card success-card">
      <div class="success-icon" aria-hidden="true">✓</div>
      <h3>${status === "pending_review" ? "已送出，待物業審核" : "預約成功"}</h3>
      <p class="success-detail">
        ${escapeHtml(facilityName)}　${fmtDateHuman(date)}　${escapeHtml(slotLabel)}
      </p>
      <p class="code-hint">請保存以下查詢碼，用來查詢或取消這筆預約：</p>
      <div class="query-code" id="queryCodeText">${escapeHtml(queryCode)}</div>
      <button type="button" class="btn" id="copyCodeBtn">複製查詢碼</button>
      <div id="copyResult" aria-live="polite"></div>
      ${status === "pending_review"
        ? `<div class="alert warn">此場地需物業審核，審核通過後才算確定。</div>` : ""}
      <button type="button" class="btn secondary" id="bookAgainBtn">再預約一筆</button>
    </div>`;

  $("copyCodeBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(queryCode);
      $("copyResult").innerHTML = `<div class="alert ok">已複製到剪貼簿</div>`;
    } catch {
      // iOS Safari 在非使用者手勢或無 HTTPS 情境會擋下剪貼簿，退而求其次選取文字讓使用者自己複製
      const range = document.createRange();
      range.selectNodeContents($("queryCodeText"));
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      $("copyResult").innerHTML = `<div class="alert warn">請長按上方選取的文字複製</div>`;
    }
  });
  $("bookAgainBtn").addEventListener("click", () => {
    closeBookingPanel();
    loadFacilities();
  });
}

/* ---------- 查詢 / 取消 ---------- */

$("lookupBtn").addEventListener("click", doLookup);
$("lookupCode").addEventListener("keydown", (e) => { if (e.key === "Enter") doLookup(); });
$("lookupHouse").addEventListener("keydown", (e) => { if (e.key === "Enter") doLookup(); });

async function doLookup() {
  const code = $("lookupCode").value.trim().toUpperCase();
  const house = $("lookupHouse").value.trim();
  const result = $("lookupResult");
  const btn = $("lookupBtn");

  if (!code || !house) {
    result.innerHTML = `<div class="alert error">請輸入查詢碼與門牌號碼</div>`;
    return;
  }

  btn.disabled = true;
  btn.textContent = "查詢中…";
  result.innerHTML = "";
  try {
    const snap = await getDoc(doc(db, "bookings", code));
    // 查詢碼錯誤與門牌不符回報相同訊息，避免有人用查詢碼逐一試出哪些碼是有效的
    if (!snap.exists() || snap.data().houseNumber !== house) {
      result.innerHTML = `<div class="alert error">查無符合的預約，請確認查詢碼與門牌號碼是否正確。</div>`;
      return;
    }

    const b = snap.data();
    const canCancel = ["confirmed", "pending_review"].includes(b.status) && b.date >= todayStr();
    result.innerHTML = `
      <div class="card">
        <h3>${escapeHtml(b.facilityName)}</h3>
        <dl class="detail-list">
          <dt>日期</dt><dd>${fmtDateHuman(b.date)}</dd>
          <dt>時段</dt><dd>${escapeHtml(b.slotLabel || `${b.startTime}-${b.endTime}`)}</dd>
          <dt>申請人</dt><dd>${escapeHtml(b.applicantName)}</dd>
          <dt>門牌</dt><dd>${escapeHtml(b.houseNumber)}</dd>
          <dt>人數</dt><dd>${escapeHtml(String(b.peopleCount))} 人</dd>
          <dt>狀態</dt><dd><span class="badge ${b.status}">${fmtStatus(b.status)}</span></dd>
        </dl>
        ${canCancel ? `<button type="button" class="btn danger" id="cancelBtn">取消此預約</button>` : ""}
        <div id="cancelAlert" role="alert" aria-live="assertive"></div>
      </div>`;
    if (canCancel) $("cancelBtn").addEventListener("click", () => doCancel(code, b));
  } catch (err) {
    result.innerHTML = `<div class="alert error" role="alert">${escapeHtml(friendlyError(err))}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "查詢";
  }
}

async function doCancel(code, booking) {
  if (!confirm("確定要取消此預約嗎？取消後這個時段會立即開放給其他住戶。")) return;
  const btn = $("cancelBtn");
  btn.disabled = true;
  btn.textContent = "取消中…";

  try {
    // 順序不可調換：安全規則要求「預約已是取消狀態」才允許釋出時段鎖
    await updateDoc(doc(db, "bookings", code), {
      status: "cancelled", cancelledAt: serverTimestamp(),
    });

    // 釋出時段，讓別人馬上能訂；失敗也不影響取消本身（物業仍可在後台手動釋出）
    await setDoc(doc(db, "slotLocks", slotLockId(booking.facilityId, booking.date, booking.slotId)), {
      facilityId: booking.facilityId, date: booking.date, slotId: booking.slotId,
      status: "cancelled", bookingId: code, createdAt: serverTimestamp(),
    }).catch(() => {});

    // 退還次數額度，否則住戶取消後仍會被上限擋住
    await refundUsage(booking).catch(() => {});

    addDoc(collection(db, "bookingLogs"), {
      targetType: "booking", targetId: code, action: "cancel", actor: "resident",
      detail: { facilityId: booking.facilityId, date: booking.date }, timestamp: serverTimestamp(),
    }).catch(() => {});

    $("lookupResult").innerHTML =
      `<div class="alert ok" role="status">已取消預約，該時段已重新開放預約。</div>`;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "取消此預約";
    $("cancelAlert").innerHTML = `<div class="alert error">${escapeHtml(friendlyError(err))}</div>`;
  }
}

async function refundUsage(b) {
  const refs = [
    doc(db, "unitDailyUsage", `${b.facilityId}__${b.houseNumber}__${b.date}`),
    doc(db, "unitWeeklyUsage", `${b.facilityId}__${b.houseNumber}__${weekStartOf(b.date)}`),
  ];
  await Promise.all(refs.map((ref) => runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists() && snap.data().count > 0) {
      tx.set(ref, { count: snap.data().count - 1 });
    }
  }).catch(() => {})));
}

loadFacilities();
