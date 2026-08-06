import { db, auth } from "./firebase-config.js";
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, query, where, orderBy, limit, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  todayStr, weekStartOf, slotLockId, escapeHtml, fmtStatus, fmtDateHuman, friendlyError,
} from "./shared.js";

const $ = (id) => document.getElementById(id);
const WEEKDAY_LABEL = ["一", "二", "三", "四", "五", "六", "日"];

/* ---------- 登入 ---------- */

const loginBtn = $("loginBtn");
const loginAlert = $("loginAlert");

loginBtn.addEventListener("click", doLogin);
$("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const email = $("loginEmail").value.trim();
  const pw = $("loginPassword").value;
  loginAlert.innerHTML = "";
  if (!email || !pw) {
    loginAlert.innerHTML = `<div class="alert error">請輸入帳號與密碼</div>`;
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = "登入中…";
  try {
    await signInWithEmailAndPassword(auth, email, pw);
  } catch (err) {
    // 不區分「帳號不存在」與「密碼錯誤」，避免被用來試出哪些 email 是有效管理員帳號
    const msg = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"]
      .includes(err.code) ? "帳號或密碼錯誤" :
      err.code === "auth/too-many-requests" ? "嘗試次數過多，請稍後再試" :
      `登入失敗：${err.code || err.message}`;
    loginAlert.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "登入";
    $("loginPassword").value = "";
  }
}

$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  const authed = !!user;
  $("loginView").classList.toggle("hidden", authed);
  $("appView").classList.toggle("hidden", !authed);
  $("headerRight").classList.toggle("hidden", !authed);
  if (authed) {
    $("currentUserLabel").textContent = user.email;
    initApp();
  }
});

const actorTag = () => `property:${auth.currentUser?.email || "unknown"}`;

function logAction(targetType, targetId, action, detail = {}) {
  addDoc(collection(db, "bookingLogs"), {
    targetType, targetId, action, actor: actorTag(), detail, timestamp: serverTimestamp(),
  }).catch(() => {});
}

/* ---------- 分頁切換 ---------- */

const TABS = ["dashboard", "facilities", "equipment", "bookings", "logs"];
let appInited = false;
let activeTab = "dashboard";

function initApp() {
  if (appInited) { refreshCurrentTab(); return; }
  appInited = true;
  TABS.forEach((t) => $(`tab-${t}`).addEventListener("click", () => switchAdminTab(t)));
  switchAdminTab("dashboard");
}

function switchAdminTab(name) {
  activeTab = name;
  TABS.forEach((t) => {
    $(`tab-${t}`).classList.toggle("active", t === name);
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`view-${t}`).classList.toggle("hidden", t !== name);
  });
  refreshCurrentTab();
}

function refreshCurrentTab() {
  ({
    dashboard: loadDashboard, facilities: loadFacilities,
    equipment: loadEquipmentTab, bookings: loadBookings, logs: loadLogs,
  })[activeTab]();
}

// 表格在手機上一定放不下，統一包一層可橫向捲動的容器，讓頁面本身不會被撐破
const tableWrap = (html) => `<div class="table-wrap">${html}</div>`;
const errorBox = (err) =>
  `<div class="alert error" role="alert">${escapeHtml(friendlyError(err))}</div>`;

/* ---------- 儀表板 ---------- */

async function loadDashboard() {
  const el = $("view-dashboard");
  el.innerHTML = `<p class="loading">載入中…</p>`;
  try {
    const facSnap = await getDocs(collection(db, "facilities"));
    const facilities = facSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // 逐場地平行查詢維修中的設備。先前用 collectionGroup 需要額外建立索引，
    // 一旦查詢失敗就會靜默顯示「沒有設備維修中」——那正好是本系統最不能出錯的一項。
    const [todaySnap, ...eqSnaps] = await Promise.all([
      getDocs(query(collection(db, "bookings"), where("date", "==", todayStr()))),
      ...facilities.map((f) =>
        getDocs(query(collection(db, "facilities", f.id, "equipment"),
          where("status", "==", "maintenance")))),
    ]);

    const todayList = todaySnap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((b) => !["cancelled", "rejected"].includes(b.status))
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));

    const maintenance = [];
    eqSnaps.forEach((snap, i) => snap.docs.forEach((d) =>
      maintenance.push({ facility: facilities[i].name, ...d.data() })));

    const pendingSnap = await getDocs(query(collection(db, "bookings"),
      where("status", "==", "pending_review")));

    el.innerHTML = `
      <div class="stat-row">
        <div class="card stat"><div class="stat-num">${todayList.length}</div><div class="stat-label">今日預約</div></div>
        <div class="card stat ${pendingSnap.size ? "warn" : ""}"><div class="stat-num">${pendingSnap.size}</div><div class="stat-label">待審核</div></div>
        <div class="card stat ${maintenance.length ? "danger" : ""}"><div class="stat-num">${maintenance.length}</div><div class="stat-label">設備維修中</div></div>
      </div>

      <div class="card">
        <h3>設備維修中警示</h3>
        ${maintenance.length === 0 ? `<p class="empty">目前沒有設備標記維修中</p>` : tableWrap(`
          <table><thead><tr><th>場地</th><th>設備</th><th>必要設備</th><th>備註</th></tr></thead>
          <tbody>${maintenance.map((e) => `
            <tr class="${e.essential ? "row-danger" : ""}">
              <td>${escapeHtml(e.facility)}</td><td>${escapeHtml(e.name)}</td>
              <td>${e.essential ? "⚠️ 是（場地停訂）" : "否"}</td>
              <td>${escapeHtml(e.note || "")}</td></tr>`).join("")}
          </tbody></table>`)}
      </div>

      <div class="card">
        <h3>今日預約（${fmtDateHuman(todayStr())}）</h3>
        ${todayList.length === 0 ? `<p class="empty">今天目前沒有預約</p>` : tableWrap(`
          <table><thead><tr><th>場地</th><th>時段</th><th>申請人</th><th>門牌</th><th>人數</th><th>狀態</th></tr></thead>
          <tbody>${todayList.map((b) => `
            <tr><td>${escapeHtml(b.facilityName)}</td><td>${escapeHtml(b.slotLabel || "")}</td>
            <td>${escapeHtml(b.applicantName)}</td><td>${escapeHtml(b.houseNumber)}</td>
            <td>${escapeHtml(String(b.peopleCount ?? ""))}</td>
            <td><span class="badge ${b.status}">${fmtStatus(b.status)}</span></td></tr>`).join("")}
          </tbody></table>`)}
      </div>`;
  } catch (err) {
    el.innerHTML = errorBox(err);
  }
}

/* ---------- 場地管理 ---------- */

async function loadFacilities() {
  const el = $("view-facilities");
  el.innerHTML = `<p class="loading">載入中…</p>`;
  try {
    const snap = await getDocs(collection(db, "facilities"));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const slotSnaps = await Promise.all(list.map((f) =>
      getDocs(collection(db, "facilities", f.id, "timeSlotTemplates"))));

    el.innerHTML = `<button type="button" class="btn" id="addFacilityBtn">＋ 新增場地</button>` +
      list.map((f, i) => facilityEditor(f, slotSnaps[i].docs.map((d) => ({ id: d.id, ...d.data() })))).join("");

    $("addFacilityBtn").addEventListener("click", addFacility);
    list.forEach((f) => wireFacilityEditor(f.id));
  } catch (err) {
    el.innerHTML = errorBox(err);
  }
}

function facilityEditor(f, slots) {
  const id = f.id;
  return `<div class="card">
    <h3>${escapeHtml(f.name)} <span class="doc-id">${escapeHtml(id)}</span></h3>
    <div class="row">
      <div><label for="f-name-${id}">名稱</label><input type="text" id="f-name-${id}" value="${escapeHtml(f.name)}"></div>
      <div><label for="f-capacity-${id}">容納人數（留空＝不限）</label><input type="number" min="0" id="f-capacity-${id}" value="${f.capacity ?? ""}"></div>
      <div><label for="f-unitCount-${id}">場地數量（間）</label><input type="number" min="1" id="f-unitCount-${id}" value="${f.unitCount ?? 1}"></div>
    </div>
    <div class="row">
      <div><label for="f-status-${id}">開放狀態</label>
        <select id="f-status-${id}">
          <option value="open" ${f.status === "open" ? "selected" : ""}>開放</option>
          <option value="closed" ${f.status === "closed" ? "selected" : ""}>暫停開放</option>
        </select></div>
      <div><label for="f-bookingMode-${id}">審核方式</label>
        <select id="f-bookingMode-${id}">
          <option value="auto" ${f.bookingMode !== "review" ? "selected" : ""}>自動確認</option>
          <option value="review" ${f.bookingMode === "review" ? "selected" : ""}>需物業審核</option>
        </select></div>
    </div>
    <div class="row">
      <div><label for="f-daily-${id}">同門牌單日上限（0＝不限）</label><input type="number" min="0" id="f-daily-${id}" value="${f.dailyLimitPerUnit ?? 0}"></div>
      <div><label for="f-weekly-${id}">同門牌單週上限（0＝不限）</label><input type="number" min="0" id="f-weekly-${id}" value="${f.weeklyLimitPerUnit ?? 0}"></div>
    </div>
    <button type="button" class="btn small" id="f-save-${id}">儲存場地設定</button>
    <div id="f-alert-${id}" aria-live="polite"></div>

    <h4>可預約時段</h4>
    ${slots.length === 0 ? `<p class="empty">尚未設定時段，住戶將無法預約此場地</p>` : tableWrap(`
      <table><thead><tr><th>名稱</th><th>開始</th><th>結束</th><th>開放星期</th><th></th></tr></thead>
      <tbody>${slots.sort((a, b) => a.startTime.localeCompare(b.startTime)).map((s) => `
        <tr><td>${escapeHtml(s.label || "")}</td><td>${escapeHtml(s.startTime)}</td><td>${escapeHtml(s.endTime)}</td>
        <td>${(s.weekdays || []).map((w) => WEEKDAY_LABEL[w - 1]).join("")}</td>
        <td><button type="button" class="btn small danger" data-del-slot="${escapeHtml(s.id)}" data-fac="${escapeHtml(id)}">刪除</button></td></tr>`).join("")}
      </tbody></table>`)}
    <div class="row">
      <div><label for="ns-label-${id}">時段名稱</label><input type="text" id="ns-label-${id}" placeholder="例如 上午場"></div>
      <div><label for="ns-start-${id}">開始時間</label><input type="time" id="ns-start-${id}" value="09:00"></div>
      <div><label for="ns-end-${id}">結束時間</label><input type="time" id="ns-end-${id}" value="10:00"></div>
    </div>
    <fieldset class="weekday-set">
      <legend>開放星期</legend>
      ${[1, 2, 3, 4, 5, 6, 7].map((w) => `
        <label class="chk"><input type="checkbox" class="ns-weekday-${id}" value="${w}" checked>${WEEKDAY_LABEL[w - 1]}</label>`).join("")}
    </fieldset>
    <button type="button" class="btn small secondary" id="ns-add-${id}">新增時段</button>
  </div>`;
}

function wireFacilityEditor(id) {
  $(`f-save-${id}`).addEventListener("click", () => saveFacility(id));
  $(`ns-add-${id}`).addEventListener("click", () => addTimeSlot(id));
  document.querySelectorAll(`[data-del-slot][data-fac="${id}"]`).forEach((btn) =>
    btn.addEventListener("click", () => deleteTimeSlot(id, btn.dataset.delSlot)));
}

async function saveFacility(id) {
  const v = (k) => $(`${k}-${id}`).value;
  const alertEl = $(`f-alert-${id}`);
  const name = v("f-name").trim();
  if (!name) { alertEl.innerHTML = `<div class="alert error">場地名稱不可空白</div>`; return; }

  const data = {
    name,
    capacity: v("f-capacity") === "" ? null : Number(v("f-capacity")),
    unitCount: Number(v("f-unitCount")) || 1,
    status: v("f-status"),
    bookingMode: v("f-bookingMode"),
    dailyLimitPerUnit: Number(v("f-daily")) || 0,
    weeklyLimitPerUnit: Number(v("f-weekly")) || 0,
    updatedAt: serverTimestamp(), updatedBy: actorTag(),
  };
  try {
    await updateDoc(doc(db, "facilities", id), data);
    logAction("facility", id, "config_change", { ...data, updatedAt: null });
    alertEl.innerHTML = `<div class="alert ok">已儲存</div>`;
    setTimeout(() => { alertEl.innerHTML = ""; }, 3000);
  } catch (err) {
    alertEl.innerHTML = errorBox(err);
  }
}

async function addFacility() {
  const id = prompt("請輸入場地代號（英文或數字，例如 yoga-room，建立後不能更改）：");
  if (!id) return;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    alert("代號只能使用英文、數字與連字號，且需以英數開頭。");
    return;
  }
  const name = prompt("請輸入場地顯示名稱：", id);
  if (!name) return;
  try {
    await setDoc(doc(db, "facilities", id), {
      name, capacity: null, unitCount: 1, status: "open", bookingMode: "auto",
      dailyLimitPerUnit: 0, weeklyLimitPerUnit: 0, order: 99,
      updatedAt: serverTimestamp(), updatedBy: actorTag(),
    });
    logAction("facility", id, "config_change", { created: true, name });
    loadFacilities();
  } catch (err) {
    alert(friendlyError(err));
  }
}

async function addTimeSlot(id) {
  const label = $(`ns-label-${id}`).value.trim();
  const startTime = $(`ns-start-${id}`).value;
  const endTime = $(`ns-end-${id}`).value;
  const weekdays = [...document.querySelectorAll(`.ns-weekday-${id}:checked`)].map((c) => Number(c.value));
  const alertEl = $(`f-alert-${id}`);

  if (!startTime || !endTime || weekdays.length === 0) {
    alertEl.innerHTML = `<div class="alert error">請填寫起訖時間並至少勾選一個星期</div>`;
    return;
  }
  if (endTime <= startTime) {
    alertEl.innerHTML = `<div class="alert error">結束時間必須晚於開始時間</div>`;
    return;
  }
  try {
    await addDoc(collection(db, "facilities", id, "timeSlotTemplates"), { label, startTime, endTime, weekdays });
    logAction("facility", id, "config_change", { addSlot: { label, startTime, endTime, weekdays } });
    loadFacilities();
  } catch (err) {
    alertEl.innerHTML = errorBox(err);
  }
}

async function deleteTimeSlot(facilityId, slotId) {
  if (!confirm("確定刪除此時段？已經預約到這個時段的住戶不會被自動取消，需另行處理。")) return;
  try {
    await deleteDoc(doc(db, "facilities", facilityId, "timeSlotTemplates", slotId));
    logAction("facility", facilityId, "config_change", { deleteSlot: slotId });
    loadFacilities();
  } catch (err) {
    $(`f-alert-${facilityId}`).innerHTML = errorBox(err);
  }
}

/* ---------- 設備管理 ---------- */

async function loadEquipmentTab() {
  const el = $("view-equipment");
  el.innerHTML = `<p class="loading">載入中…</p>`;
  try {
    const facSnap = await getDocs(collection(db, "facilities"));
    const facilities = facSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    el.innerHTML = `
      <div class="card">
        <label for="eqFacilitySelect">選擇場地</label>
        <select id="eqFacilitySelect">${facilities.map((f) =>
          `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join("")}</select>
        <p class="hint">勾選「必要設備」的項目一旦標記為維修中，該場地會立即停止開放預約。</p>
      </div>
      <div id="eqArea"></div>`;

    $("eqFacilitySelect").addEventListener("change", (e) => loadEquipmentList(e.target.value));
    if (facilities.length) loadEquipmentList(facilities[0].id);
  } catch (err) {
    el.innerHTML = errorBox(err);
  }
}

async function loadEquipmentList(facilityId) {
  const eqArea = $("eqArea");
  eqArea.innerHTML = `<p class="loading">載入中…</p>`;
  try {
    const snap = await getDocs(collection(db, "facilities", facilityId, "equipment"));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    eqArea.innerHTML = `<div class="card">
      ${list.length === 0 ? `<p class="empty">此場地尚未登記任何設備</p>` : tableWrap(`
        <table><thead><tr><th>設備名稱</th><th>必要設備</th><th>狀態</th><th>備註</th><th></th></tr></thead>
        <tbody>${list.map((e) => `
          <tr class="${e.status === "maintenance" && e.essential ? "row-danger" : ""}">
            <td>${escapeHtml(e.name)}</td>
            <td><label class="chk"><input type="checkbox" id="eq-ess-${e.id}" ${e.essential ? "checked" : ""}><span class="sr-only">必要設備</span></label></td>
            <td><select id="eq-status-${e.id}">
              <option value="normal" ${e.status === "normal" ? "selected" : ""}>正常</option>
              <option value="maintenance" ${e.status === "maintenance" ? "selected" : ""}>維修中</option>
              <option value="retired" ${e.status === "retired" ? "selected" : ""}>已汰除</option>
            </select></td>
            <td><input type="text" id="eq-note-${e.id}" value="${escapeHtml(e.note || "")}" placeholder="故障說明"></td>
            <td><button type="button" class="btn small" data-save-eq="${escapeHtml(e.id)}">儲存</button></td>
          </tr>`).join("")}
        </tbody></table>`)}
      <div class="row add-row">
        <div><label for="newEqName">新增設備名稱</label><input type="text" id="newEqName" placeholder="例如 跑步機 #3"></div>
        <div class="btn-cell"><button type="button" class="btn secondary" id="addEqBtn">＋ 新增設備</button></div>
      </div>
      <div id="eqAlert" aria-live="polite"></div>
    </div>`;

    list.forEach((e) => document.querySelector(`[data-save-eq="${e.id}"]`)
      .addEventListener("click", () => saveEquipment(facilityId, e.id)));
    $("addEqBtn").addEventListener("click", () => addEquipment(facilityId));
  } catch (err) {
    eqArea.innerHTML = errorBox(err);
  }
}

async function saveEquipment(facilityId, eqId) {
  const data = {
    essential: $(`eq-ess-${eqId}`).checked,
    status: $(`eq-status-${eqId}`).value,
    note: $(`eq-note-${eqId}`).value.trim(),
    updatedAt: serverTimestamp(), updatedBy: actorTag(),
  };
  try {
    await updateDoc(doc(db, "facilities", facilityId, "equipment", eqId), data);
    logAction("equipment", eqId, "equipment_status_change", { facilityId, ...data, updatedAt: null });
    loadEquipmentList(facilityId);
  } catch (err) {
    $("eqAlert").innerHTML = errorBox(err);
  }
}

async function addEquipment(facilityId) {
  const name = $("newEqName").value.trim();
  if (!name) { $("eqAlert").innerHTML = `<div class="alert error">請輸入設備名稱</div>`; return; }
  try {
    const ref = await addDoc(collection(db, "facilities", facilityId, "equipment"), {
      name, essential: false, status: "normal", note: "",
      updatedAt: serverTimestamp(), updatedBy: actorTag(),
    });
    logAction("equipment", ref.id, "equipment_status_change", { facilityId, created: true, name });
    loadEquipmentList(facilityId);
  } catch (err) {
    $("eqAlert").innerHTML = errorBox(err);
  }
}

/* ---------- 預約管理 ---------- */

async function loadBookings() {
  $("view-bookings").innerHTML = `
    <div class="card">
      <div class="row">
        <div><label for="bkStatusFilter">狀態篩選</label>
          <select id="bkStatusFilter">
            <option value="">今天起的所有預約</option>
            <option value="pending_review">待審核</option>
            <option value="confirmed">已確認</option>
            <option value="cancelled">已取消</option>
            <option value="rejected">已拒絕</option>
          </select></div>
        <div class="btn-cell"><button type="button" class="btn secondary small" id="bkRefresh">重新整理</button></div>
      </div>
    </div>
    <div id="bkList"></div>`;
  $("bkRefresh").addEventListener("click", renderBookingList);
  $("bkStatusFilter").addEventListener("change", renderBookingList);
  renderBookingList();
}

async function renderBookingList() {
  const status = $("bkStatusFilter").value;
  const bkList = $("bkList");
  bkList.innerHTML = `<p class="loading">載入中…</p>`;
  try {
    const q = status
      ? query(collection(db, "bookings"), where("status", "==", status), orderBy("date", "desc"), limit(100))
      : query(collection(db, "bookings"), where("date", ">=", todayStr()), orderBy("date", "asc"), limit(100));
    const list = (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));

    if (list.length === 0) {
      bkList.innerHTML = `<div class="card"><p class="empty">沒有符合條件的預約</p></div>`;
      return;
    }

    bkList.innerHTML = `<div class="card">${tableWrap(`
      <table><thead><tr>
        <th>查詢碼</th><th>場地</th><th>日期/時段</th><th>申請人/門牌</th><th>電話</th><th>狀態</th><th>操作</th>
      </tr></thead><tbody>
        ${list.map((b) => `<tr>
          <td><code>${escapeHtml(b.id)}</code></td>
          <td>${escapeHtml(b.facilityName)}</td>
          <td>${fmtDateHuman(b.date)}<br><span class="sub">${escapeHtml(b.slotLabel || "")}</span></td>
          <td>${escapeHtml(b.applicantName)}<br><span class="sub">${escapeHtml(b.houseNumber)}</span></td>
          <td>${escapeHtml(b.phone || "—")}</td>
          <td><span class="badge ${b.status}">${fmtStatus(b.status)}</span></td>
          <td class="action-cell">${bookingActions(b)}</td>
        </tr>`).join("")}
      </tbody></table>`)}
      <div id="bkAlert" aria-live="polite"></div>
    </div>`;

    list.forEach((b) => {
      document.querySelector(`[data-approve="${b.id}"]`)?.addEventListener("click", () => setBookingStatus(b, "confirmed", "approve"));
      document.querySelector(`[data-reject="${b.id}"]`)?.addEventListener("click", () => setBookingStatus(b, "rejected", "reject"));
      document.querySelector(`[data-cancel="${b.id}"]`)?.addEventListener("click", () => setBookingStatus(b, "cancelled", "cancel"));
      document.querySelector(`[data-release="${b.id}"]`)?.addEventListener("click", () => releaseSlot(b));
    });
  } catch (err) {
    bkList.innerHTML = errorBox(err);
  }
}

function bookingActions(b) {
  const btns = [];
  if (b.status === "pending_review") {
    btns.push(`<button type="button" class="btn small" data-approve="${escapeHtml(b.id)}">核准</button>`);
    btns.push(`<button type="button" class="btn small danger" data-reject="${escapeHtml(b.id)}">拒絕</button>`);
  }
  if (b.status === "confirmed") {
    btns.push(`<button type="button" class="btn small danger" data-cancel="${escapeHtml(b.id)}">取消</button>`);
  }
  if (["cancelled", "rejected"].includes(b.status)) {
    btns.push(`<button type="button" class="btn small secondary" data-release="${escapeHtml(b.id)}">釋出時段</button>`);
  }
  return btns.join(" ") || "—";
}

async function setBookingStatus(b, newStatus, actionName) {
  const verb = { confirmed: "核准", rejected: "拒絕", cancelled: "取消" }[newStatus];
  if (!confirm(`確定要${verb}這筆預約嗎？（${b.facilityName}／${b.applicantName}）`)) return;
  try {
    const releasing = ["cancelled", "rejected"].includes(newStatus);
    await updateDoc(doc(db, "bookings", b.id), {
      status: newStatus, cancelledAt: releasing ? serverTimestamp() : null,
    });
    await setDoc(doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId)), {
      facilityId: b.facilityId, date: b.date, slotId: b.slotId,
      status: releasing ? "cancelled" : newStatus, bookingId: b.id, createdAt: serverTimestamp(),
    });
    // 取消或拒絕時退還該門牌的預約次數額度，否則住戶會被上限卡住卻查不出原因
    if (releasing) await refundUsage(b);
    logAction("booking", b.id, actionName, { facilityId: b.facilityId, date: b.date });
    renderBookingList();
  } catch (err) {
    $("bkAlert").innerHTML = errorBox(err);
  }
}

async function releaseSlot(b) {
  try {
    await setDoc(doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId)), {
      facilityId: b.facilityId, date: b.date, slotId: b.slotId,
      status: "cancelled", bookingId: b.id, createdAt: serverTimestamp(),
    });
    logAction("booking", b.id, "release_slot", { facilityId: b.facilityId, date: b.date });
    renderBookingList();
  } catch (err) {
    $("bkAlert").innerHTML = errorBox(err);
  }
}

async function refundUsage(b) {
  const refs = [
    doc(db, "unitDailyUsage", `${b.facilityId}__${b.houseNumber}__${b.date}`),
    doc(db, "unitWeeklyUsage", `${b.facilityId}__${b.houseNumber}__${weekStartOf(b.date)}`),
  ];
  await Promise.all(refs.map((ref) => runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists() && snap.data().count > 0) tx.set(ref, { count: snap.data().count - 1 });
  }).catch(() => {})));
}

/* ---------- 操作紀錄 ---------- */

async function loadLogs() {
  const el = $("view-logs");
  el.innerHTML = `<p class="loading">載入中…</p>`;
  const ACTION_LABEL = {
    create: "新增預約", cancel: "取消預約", approve: "核准", reject: "拒絕",
    release_slot: "釋出時段", equipment_status_change: "設備調整", config_change: "設定調整",
  };
  try {
    const snap = await getDocs(query(collection(db, "bookingLogs"), orderBy("timestamp", "desc"), limit(150)));
    const list = snap.docs.map((d) => d.data());

    if (list.length === 0) {
      el.innerHTML = `<div class="card"><p class="empty">尚無操作紀錄</p></div>`;
      return;
    }
    el.innerHTML = `<div class="card">
      <p class="hint">顯示最近 150 筆。紀錄一旦寫入即無法修改或刪除。</p>
      ${tableWrap(`<table><thead><tr><th>時間</th><th>操作者</th><th>動作</th><th>對象</th><th>細節</th></tr></thead>
      <tbody>${list.map((l) => `<tr>
        <td>${l.timestamp?.toDate ? escapeHtml(l.timestamp.toDate().toLocaleString("zh-TW")) : "—"}</td>
        <td>${escapeHtml(l.actor === "resident" ? "住戶" : (l.actor || "").replace("property:", ""))}</td>
        <td>${escapeHtml(ACTION_LABEL[l.action] || l.action)}</td>
        <td><code>${escapeHtml(l.targetId || "")}</code></td>
        <td class="detail-cell">${escapeHtml(JSON.stringify(l.detail || {}))}</td>
      </tr>`).join("")}</tbody></table>`)}
    </div>`;
  } catch (err) {
    el.innerHTML = errorBox(err);
  }
}
