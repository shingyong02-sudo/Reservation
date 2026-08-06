import { db, auth } from "./firebase-config.js";
import {
  collection, collectionGroup, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, query, where, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { todayStr, slotLockId, escapeHtml, fmtStatus } from "./shared.js";

const WEEKDAY_LABEL = ["一", "二", "三", "四", "五", "六", "日"];

/* ---------- 登入 ---------- */

const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const loginBtn = document.getElementById("loginBtn");
const loginAlert = document.getElementById("loginAlert");
const logoutBtn = document.getElementById("logoutBtn");
const currentUserLabel = document.getElementById("currentUserLabel");

loginBtn.addEventListener("click", async () => {
  const email = document.getElementById("loginEmail").value.trim();
  const pw = document.getElementById("loginPassword").value;
  loginAlert.innerHTML = "";
  try {
    await signInWithEmailAndPassword(auth, email, pw);
  } catch (err) {
    loginAlert.innerHTML = `<div class="alert error">登入失敗：${escapeHtml(err.message)}</div>`;
  }
});

logoutBtn.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    currentUserLabel.textContent = user.email;
    initApp();
  } else {
    loginView.classList.remove("hidden");
    appView.classList.add("hidden");
  }
});

function actorTag() {
  return `property:${auth.currentUser?.email || "unknown"}`;
}

function logAction(targetType, targetId, action, detail = {}) {
  addDoc(collection(db, "bookingLogs"), {
    targetType, targetId, action, actor: actorTag(), detail, timestamp: serverTimestamp(),
  }).catch(() => {});
}

/* ---------- Tabs ---------- */

const tabs = ["dashboard", "facilities", "equipment", "bookings", "logs"];
let appInited = false;

function initApp() {
  if (appInited) { refreshCurrentTab(); return; }
  appInited = true;
  tabs.forEach((t) => {
    document.getElementById(`tab-${t}`).addEventListener("click", () => switchAdminTab(t));
  });
  switchAdminTab("dashboard");
}

let activeTab = "dashboard";
function switchAdminTab(name) {
  activeTab = name;
  tabs.forEach((t) => {
    document.getElementById(`tab-${t}`).classList.toggle("active", t === name);
    document.getElementById(`view-${t}`).classList.toggle("hidden", t !== name);
  });
  refreshCurrentTab();
}

function refreshCurrentTab() {
  if (activeTab === "dashboard") loadDashboard();
  if (activeTab === "facilities") loadFacilities();
  if (activeTab === "equipment") loadEquipmentTab();
  if (activeTab === "bookings") loadBookings();
  if (activeTab === "logs") loadLogs();
}

/* ---------- 儀表板 ---------- */

async function loadDashboard() {
  const el = document.getElementById("view-dashboard");
  el.innerHTML = "<p>載入中…</p>";

  const todaySnap = await getDocs(query(collection(db, "bookings"), where("date", "==", todayStr())));
  const todayList = todaySnap.docs.map((d) => d.data()).filter((b) => b.status !== "cancelled" && b.status !== "rejected");

  let maintenanceList = [];
  try {
    const eqSnap = await getDocs(query(collectionGroup(db, "equipment"), where("status", "==", "maintenance")));
    maintenanceList = eqSnap.docs.map((d) => ({ facilityId: d.ref.parent.parent.id, ...d.data() }));
  } catch (e) {
    maintenanceList = [];
  }

  el.innerHTML = `
    <div class="card">
      <h3>今日預約（${todayStr()}）</h3>
      ${todayList.length === 0 ? "<p>今天目前沒有預約</p>" : `
        <table><thead><tr><th>場地</th><th>時段</th><th>申請人</th><th>門牌</th><th>狀態</th></tr></thead>
        <tbody>${todayList.map((b) => `
          <tr><td>${escapeHtml(b.facilityName)}</td><td>${escapeHtml(b.slotLabel || "")}</td>
          <td>${escapeHtml(b.applicantName)}</td><td>${escapeHtml(b.houseNumber)}</td><td>${fmtStatus(b.status)}</td></tr>
        `).join("")}</tbody></table>`}
    </div>
    <div class="card">
      <h3>設備維修中警示</h3>
      ${maintenanceList.length === 0 ? "<p>目前沒有設備標記維修中</p>" : `
        <table><thead><tr><th>場地</th><th>設備</th><th>必要設備</th><th>備註</th></tr></thead>
        <tbody>${maintenanceList.map((e) => `
          <tr><td>${escapeHtml(e.facilityId)}</td><td>${escapeHtml(e.name)}</td>
          <td>${e.essential ? "是" : "否"}</td><td>${escapeHtml(e.note || "")}</td></tr>
        `).join("")}</tbody></table>`}
    </div>`;
}

/* ---------- 場地管理 ---------- */

async function loadFacilities() {
  const el = document.getElementById("view-facilities");
  el.innerHTML = "<p>載入中…</p>";
  const snap = await getDocs(collection(db, "facilities"));
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  el.innerHTML = `
    <button class="btn" id="addFacilityBtn">＋ 新增場地</button>
    <div id="facilityList"></div>`;
  document.getElementById("addFacilityBtn").addEventListener("click", addFacility);

  const listEl = document.getElementById("facilityList");
  for (const f of list) {
    const box = document.createElement("div");
    box.className = "card";
    box.innerHTML = await renderFacilityEditor(f);
    listEl.appendChild(box);
    wireFacilityEditor(f.id);
  }
}

async function renderFacilityEditor(f) {
  const slotSnap = await getDocs(collection(db, "facilities", f.id, "timeSlotTemplates"));
  const slots = slotSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return `
    <h3>${escapeHtml(f.name)} <span style="font-size:.75rem;color:#6b7280;">(${f.id})</span></h3>
    <div class="row">
      <div><label>名稱</label><input type="text" id="f-name-${f.id}" value="${escapeHtml(f.name)}"></div>
      <div><label>容納人數（留空＝不限）</label><input type="number" id="f-capacity-${f.id}" value="${f.capacity ?? ""}"></div>
      <div><label>場地數量（間）</label><input type="number" id="f-unitCount-${f.id}" value="${f.unitCount ?? 1}"></div>
    </div>
    <div class="row">
      <div><label>開放狀態</label>
        <select id="f-status-${f.id}">
          <option value="open" ${f.status === "open" ? "selected" : ""}>開放</option>
          <option value="closed" ${f.status === "closed" ? "selected" : ""}>暫停開放</option>
        </select>
      </div>
      <div><label>審核方式</label>
        <select id="f-bookingMode-${f.id}">
          <option value="auto" ${f.bookingMode !== "review" ? "selected" : ""}>自動確認</option>
          <option value="review" ${f.bookingMode === "review" ? "selected" : ""}>需物業審核</option>
        </select>
      </div>
    </div>
    <div class="row">
      <div><label>同門牌單日預約上限（0＝不限）</label><input type="number" id="f-daily-${f.id}" value="${f.dailyLimitPerUnit ?? 0}"></div>
      <div><label>同門牌單週預約上限（0＝不限）</label><input type="number" id="f-weekly-${f.id}" value="${f.weeklyLimitPerUnit ?? 0}"></div>
    </div>
    <button class="btn small" id="f-save-${f.id}">儲存場地設定</button>
    <div id="f-alert-${f.id}"></div>

    <h4 style="margin-top:18px;">可預約時段</h4>
    <table><thead><tr><th>名稱</th><th>開始</th><th>結束</th><th>開放星期</th><th></th></tr></thead>
      <tbody id="slotTable-${f.id}">
        ${slots.map((s) => `
          <tr>
            <td>${escapeHtml(s.label || "")}</td><td>${escapeHtml(s.startTime)}</td><td>${escapeHtml(s.endTime)}</td>
            <td>${(s.weekdays || []).map((w) => WEEKDAY_LABEL[w - 1]).join("")}</td>
            <td><button class="btn small danger" data-del-slot="${s.id}" data-fac="${f.id}">刪除</button></td>
          </tr>`).join("")}
      </tbody>
    </table>
    <div class="row" style="margin-top:8px;">
      <div><label>時段名稱</label><input type="text" id="ns-label-${f.id}" placeholder="例如 上午場"></div>
      <div><label>開始時間</label><input type="time" id="ns-start-${f.id}" value="09:00"></div>
      <div><label>結束時間</label><input type="time" id="ns-end-${f.id}" value="10:00"></div>
    </div>
    <div class="row">
      ${[1,2,3,4,5,6,7].map((w) => `
        <label style="display:inline-flex;align-items:center;gap:4px;width:auto;">
          <input type="checkbox" class="ns-weekday-${f.id}" value="${w}" checked style="width:auto;">${WEEKDAY_LABEL[w-1]}
        </label>`).join("")}
    </div>
    <button class="btn small secondary" id="ns-add-${f.id}">新增時段</button>`;
}

function wireFacilityEditor(facilityId) {
  document.getElementById(`f-save-${facilityId}`).addEventListener("click", () => saveFacility(facilityId));
  document.getElementById(`ns-add-${facilityId}`).addEventListener("click", () => addTimeSlot(facilityId));
  document.querySelectorAll(`[data-del-slot][data-fac="${facilityId}"]`).forEach((btn) => {
    btn.addEventListener("click", () => deleteTimeSlot(facilityId, btn.dataset.delSlot));
  });
}

async function saveFacility(facilityId) {
  const val = (id) => document.getElementById(id).value;
  const data = {
    name: val(`f-name-${facilityId}`),
    capacity: val(`f-capacity-${facilityId}`) ? Number(val(`f-capacity-${facilityId}`)) : null,
    unitCount: Number(val(`f-unitCount-${facilityId}`)) || 1,
    status: val(`f-status-${facilityId}`),
    bookingMode: val(`f-bookingMode-${facilityId}`),
    dailyLimitPerUnit: Number(val(`f-daily-${facilityId}`)) || 0,
    weeklyLimitPerUnit: Number(val(`f-weekly-${facilityId}`)) || 0,
    updatedAt: serverTimestamp(), updatedBy: actorTag(),
  };
  await updateDoc(doc(db, "facilities", facilityId), data);
  logAction("facility", facilityId, "config_change", data);
  document.getElementById(`f-alert-${facilityId}`).innerHTML = `<div class="alert ok">已儲存</div>`;
}

async function addFacility() {
  const id = prompt("請輸入場地代號（英文/數字，例如 yoga-room，之後不能改）：");
  if (!id) return;
  const name = prompt("請輸入場地顯示名稱：", id) || id;
  await setDoc(doc(db, "facilities", id), {
    name, capacity: null, unitCount: 1, status: "open", bookingMode: "auto",
    dailyLimitPerUnit: 0, weeklyLimitPerUnit: 0, updatedAt: serverTimestamp(), updatedBy: actorTag(),
  });
  logAction("facility", id, "config_change", { created: true });
  loadFacilities();
}

async function addTimeSlot(facilityId) {
  const label = document.getElementById(`ns-label-${facilityId}`).value.trim();
  const startTime = document.getElementById(`ns-start-${facilityId}`).value;
  const endTime = document.getElementById(`ns-end-${facilityId}`).value;
  const weekdays = Array.from(document.querySelectorAll(`.ns-weekday-${facilityId}:checked`)).map((c) => Number(c.value));
  if (!startTime || !endTime || weekdays.length === 0) return alert("請填寫時間並至少選一個星期");
  await addDoc(collection(db, "facilities", facilityId, "timeSlotTemplates"), { label, startTime, endTime, weekdays });
  logAction("facility", facilityId, "config_change", { addSlot: { label, startTime, endTime, weekdays } });
  loadFacilities();
}

async function deleteTimeSlot(facilityId, slotId) {
  if (!confirm("確定刪除此時段？")) return;
  await deleteDoc(doc(db, "facilities", facilityId, "timeSlotTemplates", slotId));
  logAction("facility", facilityId, "config_change", { deleteSlot: slotId });
  loadFacilities();
}

/* ---------- 設備管理 ---------- */

async function loadEquipmentTab() {
  const el = document.getElementById("view-equipment");
  const facSnap = await getDocs(collection(db, "facilities"));
  const facilities = facSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  el.innerHTML = `
    <div class="card">
      <label>選擇場地</label>
      <select id="eqFacilitySelect">${facilities.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}</select>
    </div>
    <div id="eqArea"></div>`;

  document.getElementById("eqFacilitySelect").addEventListener("change", (e) => loadEquipmentList(e.target.value));
  if (facilities.length) loadEquipmentList(facilities[0].id);
}

async function loadEquipmentList(facilityId) {
  const eqArea = document.getElementById("eqArea");
  const snap = await getDocs(collection(db, "facilities", facilityId, "equipment"));
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  eqArea.innerHTML = `
    <div class="card">
      <table><thead><tr><th>設備名稱</th><th>必要設備</th><th>狀態</th><th>備註</th><th></th></tr></thead>
      <tbody>
        ${list.map((e) => `
          <tr>
            <td>${escapeHtml(e.name)}</td>
            <td><input type="checkbox" id="eq-ess-${e.id}" ${e.essential ? "checked" : ""} style="width:auto;"></td>
            <td>
              <select id="eq-status-${e.id}">
                <option value="normal" ${e.status === "normal" ? "selected" : ""}>正常</option>
                <option value="maintenance" ${e.status === "maintenance" ? "selected" : ""}>維修中</option>
                <option value="retired" ${e.status === "retired" ? "selected" : ""}>已汰除</option>
              </select>
            </td>
            <td><input type="text" id="eq-note-${e.id}" value="${escapeHtml(e.note || "")}"></td>
            <td><button class="btn small" data-save-eq="${e.id}">儲存</button></td>
          </tr>`).join("")}
      </tbody></table>
      <div class="row" style="margin-top:12px;">
        <div><label>新增設備名稱</label><input type="text" id="newEqName" placeholder="例如 跑步機 #3"></div>
        <div style="display:flex;align-items:flex-end;">
          <button class="btn secondary" id="addEqBtn">＋ 新增設備</button>
        </div>
      </div>
    </div>`;

  list.forEach((e) => {
    document.querySelector(`[data-save-eq="${e.id}"]`).addEventListener("click", () => saveEquipment(facilityId, e.id));
  });
  document.getElementById("addEqBtn").addEventListener("click", () => addEquipment(facilityId));
}

async function saveEquipment(facilityId, eqId) {
  const data = {
    essential: document.getElementById(`eq-ess-${eqId}`).checked,
    status: document.getElementById(`eq-status-${eqId}`).value,
    note: document.getElementById(`eq-note-${eqId}`).value.trim(),
    updatedAt: serverTimestamp(), updatedBy: actorTag(),
  };
  await updateDoc(doc(db, "facilities", facilityId, "equipment", eqId), data);
  logAction("equipment", eqId, "equipment_status_change", { facilityId, ...data });
  loadEquipmentList(facilityId);
}

async function addEquipment(facilityId) {
  const name = document.getElementById("newEqName").value.trim();
  if (!name) return;
  const ref = await addDoc(collection(db, "facilities", facilityId, "equipment"), {
    name, essential: false, status: "normal", note: "",
    updatedAt: serverTimestamp(), updatedBy: actorTag(),
  });
  logAction("equipment", ref.id, "equipment_status_change", { facilityId, created: true, name });
  loadEquipmentList(facilityId);
}

/* ---------- 預約管理 ---------- */

async function loadBookings() {
  const el = document.getElementById("view-bookings");
  el.innerHTML = `
    <div class="card">
      <div class="row">
        <div><label>狀態</label>
          <select id="bkStatusFilter">
            <option value="">全部（未來）</option>
            <option value="pending_review">待審核</option>
            <option value="confirmed">已確認</option>
            <option value="cancelled">已取消</option>
            <option value="rejected">已拒絕</option>
          </select>
        </div>
        <div style="display:flex;align-items:flex-end;"><button class="btn secondary small" id="bkRefresh">重新整理</button></div>
      </div>
    </div>
    <div id="bkList"></div>`;
  document.getElementById("bkRefresh").addEventListener("click", renderBookingList);
  document.getElementById("bkStatusFilter").addEventListener("change", renderBookingList);
  renderBookingList();
}

async function renderBookingList() {
  const status = document.getElementById("bkStatusFilter").value;
  const bkList = document.getElementById("bkList");
  bkList.innerHTML = "<p>載入中…</p>";

  let snap;
  if (status) {
    snap = await getDocs(query(collection(db, "bookings"), where("status", "==", status), orderBy("date", "desc"), limit(100)));
  } else {
    snap = await getDocs(query(collection(db, "bookings"), where("date", ">=", todayStr()), orderBy("date", "asc"), limit(100)));
  }
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  if (list.length === 0) { bkList.innerHTML = `<div class="card">沒有符合條件的預約</div>`; return; }

  bkList.innerHTML = `<div class="card"><table><thead><tr>
      <th>查詢碼</th><th>場地</th><th>日期/時段</th><th>申請人/門牌</th><th>狀態</th><th>操作</th>
    </tr></thead><tbody>
      ${list.map((b) => `
        <tr>
          <td>${b.id}</td>
          <td>${escapeHtml(b.facilityName)}</td>
          <td>${escapeHtml(b.date)} ${escapeHtml(b.slotLabel || "")}</td>
          <td>${escapeHtml(b.applicantName)} / ${escapeHtml(b.houseNumber)}</td>
          <td>${fmtStatus(b.status)}</td>
          <td>${renderBookingActions(b)}</td>
        </tr>`).join("")}
    </tbody></table></div>`;

  list.forEach((b) => {
    document.querySelectorAll(`[data-approve="${b.id}"]`).forEach((btn) => btn.addEventListener("click", () => setBookingStatus(b, "confirmed", "approve")));
    document.querySelectorAll(`[data-reject="${b.id}"]`).forEach((btn) => btn.addEventListener("click", () => setBookingStatus(b, "rejected", "reject")));
    document.querySelectorAll(`[data-cancel="${b.id}"]`).forEach((btn) => btn.addEventListener("click", () => setBookingStatus(b, "cancelled", "cancel")));
    document.querySelectorAll(`[data-release="${b.id}"]`).forEach((btn) => btn.addEventListener("click", () => releaseSlot(b)));
  });
}

function renderBookingActions(b) {
  const btns = [];
  if (b.status === "pending_review") {
    btns.push(`<button class="btn small" data-approve="${b.id}">核准</button>`);
    btns.push(`<button class="btn small danger" data-reject="${b.id}">拒絕</button>`);
  }
  if (b.status === "confirmed") {
    btns.push(`<button class="btn small danger" data-cancel="${b.id}">取消</button>`);
  }
  if (b.status === "cancelled" || b.status === "rejected") {
    btns.push(`<button class="btn small secondary" data-release="${b.id}">釋出時段</button>`);
  }
  return btns.join(" ");
}

async function setBookingStatus(b, newStatus, actionName) {
  await updateDoc(doc(db, "bookings", b.id), { status: newStatus, cancelledAt: newStatus === "cancelled" || newStatus === "rejected" ? serverTimestamp() : null });
  if (newStatus === "cancelled" || newStatus === "rejected") {
    await releaseSlot(b, false);
  } else {
    await setDoc(doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId)), {
      facilityId: b.facilityId, date: b.date, slotId: b.slotId, status: newStatus, bookingId: b.id, createdAt: serverTimestamp(),
    });
  }
  logAction("booking", b.id, actionName, { facilityId: b.facilityId, date: b.date });
  renderBookingList();
}

async function releaseSlot(b, refresh = true) {
  await setDoc(doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId)), {
    facilityId: b.facilityId, date: b.date, slotId: b.slotId, status: "cancelled", bookingId: b.id, createdAt: serverTimestamp(),
  });
  logAction("booking", b.id, "release_slot", { facilityId: b.facilityId, date: b.date });
  if (refresh) renderBookingList();
}

/* ---------- 操作紀錄 ---------- */

async function loadLogs() {
  const el = document.getElementById("view-logs");
  el.innerHTML = "<p>載入中…</p>";
  const snap = await getDocs(query(collection(db, "bookingLogs"), orderBy("timestamp", "desc"), limit(150)));
  const list = snap.docs.map((d) => d.data());

  el.innerHTML = `<div class="card"><table><thead><tr>
      <th>時間</th><th>操作者</th><th>動作</th><th>對象</th><th>細節</th>
    </tr></thead><tbody>
      ${list.map((l) => `
        <tr>
          <td>${l.timestamp?.toDate ? l.timestamp.toDate().toLocaleString("zh-TW") : ""}</td>
          <td>${escapeHtml(l.actor)}</td>
          <td>${escapeHtml(l.action)}</td>
          <td>${escapeHtml(l.targetType)}:${escapeHtml(l.targetId)}</td>
          <td>${escapeHtml(JSON.stringify(l.detail || {}))}</td>
        </tr>`).join("")}
    </tbody></table></div>`;
}
