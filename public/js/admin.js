import { db, auth } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, query, where, orderBy, limit, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  todayStr, weekStartOf, slotLockId, escapeHtml, fmtStatus, fmtDateHuman, fmtDateFull,
  friendlyError, WEEKDAY_LABEL, ROLES, roleLabel, isStaffRole, ACTION_LABEL, describeDetail,
} from "./shared.js";
import { watchAuth, login, logout, writeLog, canEnterAdmin } from "./auth.js";

const $ = (id) => document.getElementById(id);
let me = null;

/* ============================================================
   登入與權限閘門
   ============================================================ */

$("loginBtn").addEventListener("click", doLogin);
$("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const email = $("loginEmail").value.trim();
  const pw = $("loginPassword").value;
  const box = $("loginAlert");
  const btn = $("loginBtn");
  box.innerHTML = "";
  if (!email || !pw) { box.innerHTML = `<div class="alert error">請輸入帳號與密碼</div>`; return; }

  btn.disabled = true; btn.textContent = "登入中…";
  try {
    const p = await login(email, pw);
    // 一般住戶不得進入後台
    if (!canEnterAdmin(p)) {
      await logout();
      box.innerHTML = `<div class="alert error">此帳號沒有後台權限。若需使用預約系統，請至<a href="/">住戶預約首頁</a>。</div>`;
    }
  } catch (err) {
    const msg = err.message === "NO_PROFILE" ? "此帳號尚未完成設定，請洽系統管理員。"
      : err.message === "ACCOUNT_DISABLED" ? "此帳號已停用。"
      : ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(err.code)
        ? "帳號或密碼錯誤"
      : err.code === "auth/too-many-requests" ? "嘗試次數過多，請稍後再試"
      : `登入失敗：${err.code || err.message}`;
    box.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = "登入";
    $("loginPassword").value = "";
  }
}

$("logoutBtn").addEventListener("click", () => logout());

watchAuth(({ user, profile }) => {
  me = profile;
  const ok = !!user && canEnterAdmin(profile);
  $("loginView").classList.toggle("hidden", ok);
  $("appView").classList.toggle("hidden", !ok);
  if (!ok) return;
  $("currentUserLabel").textContent = profile.name || profile.email;
  $("currentRoleLabel").textContent = roleLabel(profile.role);
  // 帳號管理僅系統管理員可用
  $("tab-accounts").classList.toggle("hidden", profile.role !== "system_admin");
  initApp();
});

const isSystemAdmin = () => me?.role === "system_admin";

/* ============================================================
   分頁
   ============================================================ */

const TABS = ["dashboard", "bookings", "facilities", "equipment", "notices", "accounts", "logs"];
let inited = false, activeTab = "dashboard";

function initApp() {
  if (inited) { refresh(); return; }
  inited = true;
  TABS.forEach((t) => $(`tab-${t}`).addEventListener("click", () => switchTab(t)));
  switchTab("dashboard");
}

function switchTab(name) {
  activeTab = name;
  TABS.forEach((t) => {
    $(`tab-${t}`).classList.toggle("active", t === name);
    $(`view-${t}`).classList.toggle("hidden", t !== name);
  });
  refresh();
}

function refresh() {
  ({
    dashboard: loadDashboard, bookings: loadBookings, facilities: loadFacilities,
    equipment: loadEquipment, notices: loadNotices, accounts: loadAccounts, logs: loadLogs,
  })[activeTab]();
}

const tableWrap = (html) => `<div class="table-wrap">${html}</div>`;
const errorBox = (err) => `<div class="alert error" role="alert">${escapeHtml(friendlyError(err))}</div>`;
const head = (title, sub, right = "") => `
  <div class="admin-head">
    <div><h2>${escapeHtml(title)}</h2>${sub ? `<div class="date">${escapeHtml(sub)}</div>` : ""}</div>
    ${right}
  </div>`;

/* ============================================================
   今日總覽
   ============================================================ */

async function loadDashboard() {
  const el = $("view-dashboard");
  el.innerHTML = head("今日總覽", fmtDateFull(todayStr())) + `<p class="loading">載入中…</p>`;
  try {
    const facSnap = await getDocs(collection(db, "facilities"));
    const facs = facSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const [todaySnap, pendingSnap, ...eqSnaps] = await Promise.all([
      getDocs(query(collection(db, "bookings"), where("date", "==", todayStr()))),
      getDocs(query(collection(db, "bookings"), where("status", "==", "pending_review"))),
      ...facs.map((f) => getDocs(query(collection(db, "facilities", f.id, "equipment"),
        where("status", "==", "maintenance")))),
    ]);

    const all = todaySnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const active = all.filter((b) => !["cancelled", "rejected"].includes(b.status))
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));

    const maint = [];
    eqSnaps.forEach((s, i) => s.docs.forEach((d) => maint.push({ facility: facs[i].name, ...d.data() })));
    const blocked = new Set(maint.filter((m) => m.essential).map((m) => m.facility));
    const closed = facs.filter((f) => f.status === "closed").length;
    const usage = facs.length ? Math.round(active.length / (facs.length * 7) * 100) : 0;

    el.innerHTML = head("今日總覽", fmtDateFull(todayStr())) + `
      <div class="stat-row">
        <div class="card stat"><div class="k">今日預約</div><div class="v">${active.length}<span class="unit">筆</span></div></div>
        <div class="card stat gold"><div class="k">時段使用率</div><div class="v">${usage}<span class="unit">%</span></div></div>
        <div class="card stat"><div class="k">今日取消</div><div class="v">${all.length - active.length}<span class="unit">筆</span></div></div>
        <div class="card stat ${blocked.size + closed ? "seal" : ""}"><div class="k">暫停開放場地</div><div class="v">${blocked.size + closed}<span class="unit">處</span></div></div>
      </div>
      <div class="card">
        <h3>設備維修中警示</h3>
        ${maint.length === 0 ? `<p class="empty">目前沒有設備標記維修中</p>` : tableWrap(`
          <table><thead><tr><th>場地</th><th>設備</th><th>必要設備</th><th>備註</th></tr></thead>
          <tbody>${maint.map((e) => `<tr class="${e.essential ? "row-danger" : ""}">
            <td>${escapeHtml(e.facility)}</td><td>${escapeHtml(e.name)}</td>
            <td>${e.essential ? "是（場地停訂）" : "否"}</td><td>${escapeHtml(e.note || "")}</td></tr>`).join("")}
          </tbody></table>`)}
      </div>
      <div class="card">
        <h3>今日預約名單</h3>
        ${active.length === 0 ? `<p class="empty">今天目前沒有預約</p>` : tableWrap(`
          <table><thead><tr><th>時段</th><th>場地</th><th>門牌</th><th>住戶</th><th>電話</th><th>狀態</th></tr></thead>
          <tbody>${active.map((b) => `<tr>
            <td>${escapeHtml(b.slotLabel || "")}</td><td>${escapeHtml(b.facilityName)}</td>
            <td>${escapeHtml(b.houseNumber)}</td><td>${escapeHtml(b.applicantName)}</td>
            <td>${escapeHtml(b.phone || "—")}</td>
            <td><span class="badge ${b.status}">${fmtStatus(b.status)}</span></td></tr>`).join("")}
          </tbody></table>`)}
      </div>`;
  } catch (err) {
    el.innerHTML = head("今日總覽", "") + errorBox(err);
  }
}

/* ============================================================
   預約管理
   ============================================================ */

async function loadBookings() {
  $("view-bookings").innerHTML = head("預約管理", "") + `
    <div class="card">
      <div class="row">
        <div class="field" style="margin:0">
          <label for="bkStatusFilter">狀態篩選</label>
          <select id="bkStatusFilter">
            <option value="">今天起的所有預約</option>
            <option value="pending_review">待審核</option>
            <option value="confirmed">預約成立</option>
            <option value="cancelled">已取消</option>
            <option value="rejected">已拒絕</option>
          </select>
        </div>
        <div class="btn-cell"><button type="button" class="btn secondary sm" id="bkRefresh">重新整理</button></div>
      </div>
    </div>
    <div id="bkList"></div>`;
  $("bkRefresh").addEventListener("click", renderBookings);
  $("bkStatusFilter").addEventListener("change", renderBookings);
  renderBookings();
}

async function renderBookings() {
  const status = $("bkStatusFilter").value;
  const box = $("bkList");
  box.innerHTML = `<p class="loading">載入中…</p>`;
  try {
    const q = status
      ? query(collection(db, "bookings"), where("status", "==", status), orderBy("date", "desc"), limit(100))
      : query(collection(db, "bookings"), where("date", ">=", todayStr()), orderBy("date", "asc"), limit(100));
    const list = (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!list.length) { box.innerHTML = `<div class="card"><p class="empty">沒有符合條件的預約</p></div>`; return; }

    box.innerHTML = `<div class="card">${tableWrap(`
      <table><thead><tr>
        <th>查詢碼</th><th>場地</th><th>日期／時段</th><th>門牌</th><th>住戶／電話</th><th>狀態</th><th>操作</th>
      </tr></thead><tbody>${list.map((b) => `<tr>
        <td><code>${escapeHtml(b.id)}</code></td>
        <td>${escapeHtml(b.facilityName)}</td>
        <td>${fmtDateHuman(b.date)}<br><span class="sub-text">${escapeHtml(b.slotLabel || "")}</span></td>
        <td>${escapeHtml(b.houseNumber)}</td>
        <td>${escapeHtml(b.applicantName)}<br><span class="sub-text">${escapeHtml(b.phone || "—")}</span></td>
        <td><span class="badge ${b.status}">${fmtStatus(b.status)}</span></td>
        <td class="action-cell">${bookingActions(b)}</td>
      </tr>`).join("")}</tbody></table>`)}
      <div id="bkAlert" aria-live="polite"></div></div>`;

    list.forEach((b) => {
      document.querySelector(`[data-approve="${b.id}"]`)?.addEventListener("click", () => setStatus(b, "confirmed", "approve"));
      document.querySelector(`[data-reject="${b.id}"]`)?.addEventListener("click", () => setStatus(b, "rejected", "reject"));
      document.querySelector(`[data-cancel="${b.id}"]`)?.addEventListener("click", () => setStatus(b, "cancelled", "cancel"));
      document.querySelector(`[data-release="${b.id}"]`)?.addEventListener("click", () => releaseSlot(b));
    });
  } catch (err) { box.innerHTML = errorBox(err); }
}

function bookingActions(b) {
  const out = [];
  if (b.status === "pending_review") {
    out.push(`<button type="button" class="btn primary sm" data-approve="${escapeHtml(b.id)}">核准</button>`);
    out.push(`<button type="button" class="btn danger sm" data-reject="${escapeHtml(b.id)}">拒絕</button>`);
  }
  if (b.status === "confirmed") out.push(`<button type="button" class="btn danger sm" data-cancel="${escapeHtml(b.id)}">取消</button>`);
  if (["cancelled", "rejected"].includes(b.status)) out.push(`<button type="button" class="btn secondary sm" data-release="${escapeHtml(b.id)}">釋出時段</button>`);
  return out.join(" ") || "—";
}

async function setStatus(b, newStatus, action) {
  const verb = { confirmed: "核准", rejected: "拒絕", cancelled: "取消" }[newStatus];
  if (!confirm(`確定要${verb}這筆預約嗎？（${b.facilityName}／${b.houseNumber}）`)) return;
  try {
    const releasing = ["cancelled", "rejected"].includes(newStatus);
    await updateDoc(doc(db, "bookings", b.id), {
      status: newStatus, cancelledAt: releasing ? serverTimestamp() : null,
    });
    await setDoc(doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId)), {
      facilityId: b.facilityId, date: b.date, slotId: b.slotId,
      status: releasing ? "cancelled" : newStatus, bookingId: b.id, createdAt: serverTimestamp(),
    });
    if (releasing) {
      await deleteDoc(doc(db, "unitSlotHolds", `${b.uid}__${b.date}__${b.startTime}`)).catch(() => {});
      await refundUsage(b);
    }
    writeLog("booking", b.id, action, { 場地: b.facilityName, 日期: b.date, 門牌: b.houseNumber });
    renderBookings();
  } catch (err) { $("bkAlert").innerHTML = errorBox(err); }
}

async function releaseSlot(b) {
  try {
    await setDoc(doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId)), {
      facilityId: b.facilityId, date: b.date, slotId: b.slotId,
      status: "cancelled", bookingId: b.id, createdAt: serverTimestamp(),
    });
    await deleteDoc(doc(db, "unitSlotHolds", `${b.uid}__${b.date}__${b.startTime}`)).catch(() => {});
    writeLog("booking", b.id, "release_slot", { 場地: b.facilityName, 日期: b.date });
    renderBookings();
  } catch (err) { $("bkAlert").innerHTML = errorBox(err); }
}

async function refundUsage(b) {
  if (!b.uid) return;
  const refs = [
    doc(db, "unitDailyUsage", `${b.facilityId}__${b.uid}__${b.date}`),
    doc(db, "unitWeeklyUsage", `${b.facilityId}__${b.uid}__${weekStartOf(b.date)}`),
  ];
  await Promise.all(refs.map((ref) => runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (s.exists() && s.data().count > 0) tx.set(ref, { count: s.data().count - 1 });
  }).catch(() => {})));
}

/* ============================================================
   場地與時段設定
   ============================================================ */

async function loadFacilities() {
  const el = $("view-facilities");
  el.innerHTML = head("場地與時段設定", "") + `<p class="loading">載入中…</p>`;
  try {
    const snap = await getDocs(collection(db, "facilities"));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    const slots = await Promise.all(list.map((f) => getDocs(collection(db, "facilities", f.id, "timeSlotTemplates"))));

    el.innerHTML = head("場地與時段設定", `共 ${list.length} 個場地`,
      `<button type="button" class="btn primary sm" id="addFacilityBtn">＋ 新增場地</button>`)
      + list.map((f, i) => facilityEditor(f, slots[i].docs.map((d) => ({ id: d.id, ...d.data() })))).join("");
    $("addFacilityBtn").addEventListener("click", addFacility);
    list.forEach((f) => wireFacility(f));
  } catch (err) { el.innerHTML = head("場地與時段設定", "") + errorBox(err); }
}

function facilityEditor(f, slots) {
  const id = f.id;
  return `<div class="card">
    <div class="result-head">
      <h3 style="margin:0">${escapeHtml(f.name)} <span class="doc-id">${escapeHtml(id)}</span></h3>
      <button type="button" class="btn danger sm" data-del-fac="${escapeHtml(id)}">刪除場地</button>
    </div>
    <div class="row">
      <div class="field"><label for="f-name-${id}">名稱</label><input type="text" id="f-name-${id}" value="${escapeHtml(f.name)}"></div>
      <div class="field"><label for="f-capacity-${id}">容納人數（留空＝不限）</label><input type="number" min="0" id="f-capacity-${id}" value="${f.capacity ?? ""}"></div>
      <div class="field"><label for="f-order-${id}">顯示順序</label><input type="number" min="1" id="f-order-${id}" value="${f.order ?? 99}"></div>
    </div>
    <div class="field"><label for="f-desc-${id}">簡介</label><input type="text" id="f-desc-${id}" value="${escapeHtml(f.description || "")}" placeholder="例：棋藝對弈與靜態閱讀空間。"></div>
    <div class="row">
      <div class="field"><label for="f-status-${id}">開放狀態</label>
        <select id="f-status-${id}">
          <option value="open" ${f.status === "open" ? "selected" : ""}>開放</option>
          <option value="closed" ${f.status === "closed" ? "selected" : ""}>暫停開放</option>
        </select></div>
      <div class="field"><label for="f-mode-${id}">審核方式</label>
        <select id="f-mode-${id}">
          <option value="auto" ${f.bookingMode !== "review" ? "selected" : ""}>自動確認</option>
          <option value="review" ${f.bookingMode === "review" ? "selected" : ""}>需物業審核</option>
        </select></div>
      <div class="field"><label for="f-daily-${id}">同帳號單日上限（0＝不限）</label><input type="number" min="0" id="f-daily-${id}" value="${f.dailyLimitPerUnit ?? 0}"></div>
      <div class="field"><label for="f-weekly-${id}">同帳號單週上限（0＝不限）</label><input type="number" min="0" id="f-weekly-${id}" value="${f.weeklyLimitPerUnit ?? 0}"></div>
    </div>
    <button type="button" class="btn primary sm" id="f-save-${id}">儲存場地設定</button>
    <div id="f-alert-${id}" aria-live="polite"></div>

    <h4 style="margin-top:24px;font-family:var(--font-body);font-size:var(--text-sm);color:var(--ink-500)">可預約時段</h4>
    ${slots.length === 0 ? `<p class="empty">尚未設定時段，住戶將無法預約此場地</p>` : tableWrap(`
      <table><thead><tr><th>開始</th><th>結束</th><th>開放星期</th><th></th></tr></thead>
      <tbody>${slots.sort((a, b) => a.startTime.localeCompare(b.startTime)).map((s) => `<tr>
        <td>${escapeHtml(s.startTime)}</td><td>${escapeHtml(s.endTime)}</td>
        <td>${(s.weekdays || []).map((w) => WEEKDAY_LABEL[w - 1]).join("")}</td>
        <td><button type="button" class="btn danger sm" data-del-slot="${escapeHtml(s.id)}" data-fac="${escapeHtml(id)}">刪除</button></td>
      </tr>`).join("")}</tbody></table>`)}
    <div class="row">
      <div class="field"><label for="ns-start-${id}">開始時間</label><input type="time" id="ns-start-${id}" value="08:00" step="1800"></div>
      <div class="field"><label for="ns-end-${id}">結束時間</label><input type="time" id="ns-end-${id}" value="10:00" step="1800"></div>
    </div>
    <fieldset class="weekday-set">
      <legend>開放星期</legend>
      ${[1, 2, 3, 4, 5, 6, 7].map((w) => `<label class="chk"><input type="checkbox" class="ns-wd-${id}" value="${w}" checked>${WEEKDAY_LABEL[w - 1]}</label>`).join("")}
    </fieldset>
    <button type="button" class="btn secondary sm" id="ns-add-${id}" style="margin-top:12px">新增時段</button>
  </div>`;
}

function wireFacility(f) {
  const id = f.id;
  $(`f-save-${id}`).addEventListener("click", () => saveFacility(id));
  $(`ns-add-${id}`).addEventListener("click", () => addSlot(id));
  document.querySelector(`[data-del-fac="${id}"]`)?.addEventListener("click", () => delFacility(f));
  document.querySelectorAll(`[data-del-slot][data-fac="${id}"]`).forEach((b) =>
    b.addEventListener("click", () => delSlot(id, b.dataset.delSlot)));
}

async function saveFacility(id) {
  const v = (k) => $(`${k}-${id}`).value;
  const alertEl = $(`f-alert-${id}`);
  const name = v("f-name").trim();
  if (!name) { alertEl.innerHTML = `<div class="alert error">場地名稱不可空白</div>`; return; }
  const data = {
    name, description: v("f-desc").trim(),
    capacity: v("f-capacity") === "" ? null : Number(v("f-capacity")),
    order: Number(v("f-order")) || 99,
    status: v("f-status"), bookingMode: v("f-mode"),
    dailyLimitPerUnit: Number(v("f-daily")) || 0,
    weeklyLimitPerUnit: Number(v("f-weekly")) || 0,
    updatedAt: serverTimestamp(),
  };
  try {
    await updateDoc(doc(db, "facilities", id), data);
    writeLog("facility", id, "config_change", { name, 容納人數: data.capacity, 狀態: data.status, 審核方式: data.bookingMode });
    alertEl.innerHTML = `<div class="alert ok">已儲存</div>`;
    setTimeout(() => { alertEl.innerHTML = ""; }, 3000);
  } catch (err) { alertEl.innerHTML = errorBox(err); }
}

async function addFacility() {
  const id = prompt("請輸入場地代號（英文或數字，例如 yoga-room，建立後不能更改）：");
  if (!id) return;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) { alert("代號只能使用英文、數字與連字號，且需以英數開頭。"); return; }
  const name = prompt("請輸入場地顯示名稱：", id);
  if (!name) return;
  try {
    await setDoc(doc(db, "facilities", id), {
      name, description: "", capacity: null, status: "open", bookingMode: "auto",
      dailyLimitPerUnit: 1, weeklyLimitPerUnit: 0, order: 99, updatedAt: serverTimestamp(),
    });
    // 新場地預設補上 08:00–22:00 每 2 小時共 7 段，省去逐一手動建立
    const slots = ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"];
    await Promise.all(slots.map((s) => {
      const end = String(Number(s.slice(0, 2)) + 2).padStart(2, "0") + ":00";
      return setDoc(doc(db, "facilities", id, "timeSlotTemplates", `t${s.replace(":", "")}`),
        { startTime: s, endTime: end, weekdays: [1, 2, 3, 4, 5, 6, 7] });
    }));
    writeLog("facility", id, "config_change", { 新增: true, name });
    loadFacilities();
  } catch (err) { alert(friendlyError(err)); }
}

async function delFacility(f) {
  if (!confirm(`確定刪除場地「${f.name}」？\n此動作會一併刪除其時段與設備設定，已存在的預約不會自動取消。`)) return;
  if (!confirm(`再次確認：刪除「${f.name}」後無法復原。`)) return;
  try {
    const [slots, eq] = await Promise.all([
      getDocs(collection(db, "facilities", f.id, "timeSlotTemplates")),
      getDocs(collection(db, "facilities", f.id, "equipment")),
    ]);
    await Promise.all([
      ...slots.docs.map((d) => deleteDoc(d.ref)),
      ...eq.docs.map((d) => deleteDoc(d.ref)),
    ]);
    await deleteDoc(doc(db, "facilities", f.id));
    writeLog("facility", f.id, "facility_delete", { name: f.name });
    loadFacilities();
  } catch (err) { alert(friendlyError(err)); }
}

async function addSlot(id) {
  const startTime = $(`ns-start-${id}`).value;
  const endTime = $(`ns-end-${id}`).value;
  const weekdays = [...document.querySelectorAll(`.ns-wd-${id}:checked`)].map((c) => Number(c.value));
  const alertEl = $(`f-alert-${id}`);
  if (!startTime || !endTime || !weekdays.length) {
    alertEl.innerHTML = `<div class="alert error">請填寫起訖時間並至少勾選一個星期</div>`; return;
  }
  if (endTime <= startTime) { alertEl.innerHTML = `<div class="alert error">結束時間必須晚於開始時間</div>`; return; }
  try {
    await setDoc(doc(db, "facilities", id, "timeSlotTemplates", `t${startTime.replace(":", "")}`),
      { startTime, endTime, weekdays });
    writeLog("facility", id, "config_change", { 新增時段: `${startTime}–${endTime}` });
    loadFacilities();
  } catch (err) { alertEl.innerHTML = errorBox(err); }
}

async function delSlot(facilityId, slotId) {
  if (!confirm("確定刪除此時段？已預約到這個時段的住戶不會被自動取消，需另行處理。")) return;
  try {
    await deleteDoc(doc(db, "facilities", facilityId, "timeSlotTemplates", slotId));
    writeLog("facility", facilityId, "config_change", { 刪除時段: slotId });
    loadFacilities();
  } catch (err) { $(`f-alert-${facilityId}`).innerHTML = errorBox(err); }
}

/* ============================================================
   設備管理
   ============================================================ */

async function loadEquipment() {
  const el = $("view-equipment");
  el.innerHTML = head("設備管理", "") + `<p class="loading">載入中…</p>`;
  try {
    const snap = await getDocs(collection(db, "facilities"));
    const facs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    el.innerHTML = head("設備管理", "") + `
      <div class="card">
        <div class="field" style="margin:0">
          <label for="eqFacility">選擇場地</label>
          <select id="eqFacility">${facs.map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join("")}</select>
        </div>
        <p class="hint">勾選「必要設備」的項目一旦標記為維修中，該場地會立即停止開放預約。</p>
      </div>
      <div id="eqArea"></div>`;
    $("eqFacility").addEventListener("change", (e) => loadEqList(e.target.value));
    if (facs.length) loadEqList(facs[0].id);
  } catch (err) { el.innerHTML = head("設備管理", "") + errorBox(err); }
}

async function loadEqList(facilityId) {
  const area = $("eqArea");
  area.innerHTML = `<p class="loading">載入中…</p>`;
  try {
    const snap = await getDocs(collection(db, "facilities", facilityId, "equipment"));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    area.innerHTML = `<div class="card">
      ${list.length === 0 ? `<p class="empty">此場地尚未登記任何設備</p>` : tableWrap(`
        <table><thead><tr><th>設備名稱</th><th>必要設備</th><th>狀態</th><th>備註</th><th></th></tr></thead>
        <tbody>${list.map((e) => `<tr class="${e.status === "maintenance" && e.essential ? "row-danger" : ""}">
          <td>${escapeHtml(e.name)}</td>
          <td><label class="chk"><input type="checkbox" id="eq-ess-${e.id}" ${e.essential ? "checked" : ""}><span class="sr-only">必要設備</span></label></td>
          <td><select id="eq-st-${e.id}">
            <option value="normal" ${e.status === "normal" ? "selected" : ""}>正常</option>
            <option value="maintenance" ${e.status === "maintenance" ? "selected" : ""}>維修中</option>
            <option value="retired" ${e.status === "retired" ? "selected" : ""}>已汰除</option>
          </select></td>
          <td><input type="text" id="eq-note-${e.id}" value="${escapeHtml(e.note || "")}" placeholder="故障說明"></td>
          <td class="action-cell">
            <button type="button" class="btn primary sm" data-save-eq="${escapeHtml(e.id)}">儲存</button>
            <button type="button" class="btn danger sm" data-del-eq="${escapeHtml(e.id)}">刪除</button>
          </td>
        </tr>`).join("")}</tbody></table>`)}
      <div class="row" style="margin-top:16px">
        <div class="field" style="margin:0"><label for="newEqName">新增設備名稱</label><input type="text" id="newEqName" placeholder="例：跑步機 #3"></div>
        <div class="btn-cell"><button type="button" class="btn secondary" id="addEqBtn">＋ 新增設備</button></div>
      </div>
      <div id="eqAlert" aria-live="polite"></div>
    </div>`;
    list.forEach((e) => {
      document.querySelector(`[data-save-eq="${e.id}"]`).addEventListener("click", () => saveEq(facilityId, e.id, e.name));
      document.querySelector(`[data-del-eq="${e.id}"]`).addEventListener("click", () => delEq(facilityId, e));
    });
    $("addEqBtn").addEventListener("click", () => addEq(facilityId));
  } catch (err) { area.innerHTML = errorBox(err); }
}

async function saveEq(facilityId, eqId, name) {
  const data = {
    essential: $(`eq-ess-${eqId}`).checked,
    status: $(`eq-st-${eqId}`).value,
    note: $(`eq-note-${eqId}`).value.trim(),
    updatedAt: serverTimestamp(),
  };
  try {
    await updateDoc(doc(db, "facilities", facilityId, "equipment", eqId), data);
    writeLog("equipment", eqId, "equipment_status_change", {
      場地: facilityId, 設備: name, 狀態: data.status, 必要設備: data.essential, 備註: data.note,
    });
    loadEqList(facilityId);
  } catch (err) { $("eqAlert").innerHTML = errorBox(err); }
}

async function addEq(facilityId) {
  const name = $("newEqName").value.trim();
  if (!name) { $("eqAlert").innerHTML = `<div class="alert error">請輸入設備名稱</div>`; return; }
  try {
    const ref = await addDoc(collection(db, "facilities", facilityId, "equipment"), {
      name, essential: false, status: "normal", note: "", updatedAt: serverTimestamp(),
    });
    writeLog("equipment", ref.id, "equipment_status_change", { 場地: facilityId, 新增: true, 設備: name });
    loadEqList(facilityId);
  } catch (err) { $("eqAlert").innerHTML = errorBox(err); }
}

async function delEq(facilityId, e) {
  if (!confirm(`確定刪除設備「${e.name}」？`)) return;
  try {
    await deleteDoc(doc(db, "facilities", facilityId, "equipment", e.id));
    writeLog("equipment", e.id, "equipment_status_change", { 場地: facilityId, 刪除: true, 設備: e.name });
    loadEqList(facilityId);
  } catch (err) { $("eqAlert").innerHTML = errorBox(err); }
}

/* ============================================================
   公告管理
   ============================================================ */

async function loadNotices() {
  const el = $("view-notices");
  el.innerHTML = head("公告管理", "住戶端首頁最多顯示 5 則已發布的公告") + `<p class="loading">載入中…</p>`;
  try {
    const snap = await getDocs(query(collection(db, "announcements"), orderBy("date", "desc"), limit(50)));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    el.innerHTML = head("公告管理", "住戶端首頁最多顯示 5 則已發布的公告") + `
      <div class="card">
        <h3>新增公告</h3>
        <div class="row">
          <div class="field"><label for="nTag">標籤文字</label><input type="text" id="nTag" placeholder="例：暫停開放" maxlength="8"></div>
          <div class="field"><label for="nTone">標籤顏色</label>
            <select id="nTone">
              <option value="seal">朱紅（暫停／警示）</option>
              <option value="gold">茶金（規則更新）</option>
              <option value="jade">青瓷（服務資訊）</option>
              <option value="neutral">中性</option>
            </select></div>
          <div class="field"><label for="nDate">日期</label><input type="date" id="nDate" value="${todayStr()}"></div>
        </div>
        <div class="field"><label for="nText">公告內容</label><input type="text" id="nText" placeholder="例：宴會廳 8/15（六）全日設備保養，暫停開放預約。"></div>
        <div class="check-row"><input type="checkbox" id="nPublished" checked><label for="nPublished">立即發布到住戶端首頁</label></div>
        <button type="button" class="btn primary" id="addNotice" style="margin-top:16px">新增公告</button>
        <div id="nAlert" aria-live="polite"></div>
      </div>
      <div class="card">
        <h3>公告列表</h3>
        ${list.length === 0 ? `<p class="empty">尚無公告</p>` : tableWrap(`
          <table><thead><tr><th>日期</th><th>標籤</th><th>內容</th><th>狀態</th><th></th></tr></thead>
          <tbody>${list.map((n) => `<tr>
            <td>${escapeHtml(n.date || "")}</td>
            <td><span class="badge ${["seal","gold","jade","neutral"].includes(n.tone) ? n.tone : "neutral"}">${escapeHtml(n.tag || "公告")}</span></td>
            <td>${escapeHtml(n.text || "")}</td>
            <td>${n.published ? `<span class="badge jade">已發布</span>` : `<span class="badge neutral">草稿</span>`}</td>
            <td class="action-cell">
              <button type="button" class="btn secondary sm" data-toggle-n="${escapeHtml(n.id)}">${n.published ? "下架" : "發布"}</button>
              <button type="button" class="btn danger sm" data-del-n="${escapeHtml(n.id)}">刪除</button>
            </td></tr>`).join("")}</tbody></table>`)}
      </div>`;
    $("addNotice").addEventListener("click", addNotice);
    list.forEach((n) => {
      document.querySelector(`[data-toggle-n="${n.id}"]`)?.addEventListener("click", () => toggleNotice(n));
      document.querySelector(`[data-del-n="${n.id}"]`)?.addEventListener("click", () => delNotice(n));
    });
  } catch (err) { el.innerHTML = head("公告管理", "") + errorBox(err); }
}

async function addNotice() {
  const text = $("nText").value.trim();
  const box = $("nAlert");
  if (!text) { box.innerHTML = `<div class="alert error">請輸入公告內容</div>`; return; }
  try {
    const ref = await addDoc(collection(db, "announcements"), {
      tag: $("nTag").value.trim() || "公告", tone: $("nTone").value,
      date: $("nDate").value || todayStr(), text, published: $("nPublished").checked,
      createdAt: serverTimestamp(),
    });
    writeLog("announcement", ref.id, "config_change", { 新增: true, 內容: text });
    loadNotices();
  } catch (err) { box.innerHTML = errorBox(err); }
}

async function toggleNotice(n) {
  try {
    await updateDoc(doc(db, "announcements", n.id), { published: !n.published });
    writeLog("announcement", n.id, "config_change", { 發布: !n.published, 內容: n.text });
    loadNotices();
  } catch (err) { $("nAlert").innerHTML = errorBox(err); }
}

async function delNotice(n) {
  if (!confirm("確定刪除這則公告？")) return;
  try {
    await deleteDoc(doc(db, "announcements", n.id));
    writeLog("announcement", n.id, "config_change", { 刪除: true, 內容: n.text });
    loadNotices();
  } catch (err) { $("nAlert").innerHTML = errorBox(err); }
}

/* ============================================================
   帳號管理（僅系統管理員）
   ============================================================ */

async function loadAccounts() {
  const el = $("view-accounts");
  if (!isSystemAdmin()) {
    el.innerHTML = head("帳號管理", "") + `<div class="card"><p class="empty">僅系統管理員可管理帳號。</p></div>`;
    return;
  }
  el.innerHTML = head("帳號管理", "住戶需有帳號才能預約設施") + `<p class="loading">載入中…</p>`;
  try {
    const snap = await getDocs(query(collection(db, "users"), orderBy("houseNumber")));
    const list = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));

    el.innerHTML = head("帳號管理", `共 ${list.length} 個帳號`) + `
      <div class="card">
        <h3>建立帳號</h3>
        <div class="row">
          <div class="field"><label for="acEmail">帳號（Email）</label><input type="email" id="acEmail" autocomplete="off"></div>
          <div class="field"><label for="acPassword">初始密碼（至少 6 碼）</label><input type="text" id="acPassword" autocomplete="off" placeholder="請告知住戶後請其自行更改"></div>
        </div>
        <div class="row">
          <div class="field"><label for="acName">姓名</label><input type="text" id="acName"></div>
          <div class="field"><label for="acHouse">門牌號碼</label><input type="text" id="acHouse" placeholder="例：A 棟 12 樓之 3"></div>
          <div class="field"><label for="acPhone">聯絡電話</label><input type="tel" id="acPhone"></div>
          <div class="field"><label for="acRole">角色</label>
            <select id="acRole">
              ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === "resident" ? "selected" : ""}>${v}</option>`).join("")}
            </select></div>
        </div>
        <p class="hint">建立後系統會保持您目前的登入狀態；初始密碼請透過其他管道告知住戶，並請其登入後自行更改。</p>
        <button type="button" class="btn primary" id="createAccount" style="margin-top:12px">建立帳號</button>
        <div id="acAlert" aria-live="polite"></div>
      </div>

      <div class="card">
        <h3>帳號列表</h3>
        ${list.length === 0 ? `<p class="empty">尚無帳號</p>` : tableWrap(`
          <table><thead><tr><th>門牌</th><th>姓名</th><th>帳號</th><th>電話</th><th>角色</th><th>狀態</th><th>操作</th></tr></thead>
          <tbody>${list.map((u) => `<tr class="${u.disabled ? "row-danger" : ""}">
            <td>${escapeHtml(u.houseNumber || "—")}</td>
            <td>${escapeHtml(u.name || "—")}</td>
            <td class="sub-text">${escapeHtml(u.email || "")}</td>
            <td>${escapeHtml(u.phone || "—")}</td>
            <td><select id="ur-${u.uid}" ${u.uid === me.uid ? "disabled" : ""}>
              ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${v}</option>`).join("")}
            </select></td>
            <td>${u.disabled ? `<span class="badge seal">已停用</span>` : `<span class="badge jade">啟用中</span>`}</td>
            <td class="action-cell">
              <button type="button" class="btn primary sm" data-save-u="${escapeHtml(u.uid)}" ${u.uid === me.uid ? "disabled" : ""}>儲存</button>
              <button type="button" class="btn secondary sm" data-toggle-u="${escapeHtml(u.uid)}" ${u.uid === me.uid ? "disabled" : ""}>${u.disabled ? "啟用" : "停用"}</button>
              <button type="button" class="btn ghost sm" data-reset-u="${escapeHtml(u.email || "")}">寄重設信</button>
            </td></tr>`).join("")}</tbody></table>`)}
        <p class="hint">為避免把自己鎖在系統外，無法修改或停用目前登入中的帳號。</p>
      </div>`;

    $("createAccount").addEventListener("click", createAccount);
    list.forEach((u) => {
      document.querySelector(`[data-save-u="${u.uid}"]`)?.addEventListener("click", () => saveUserRole(u));
      document.querySelector(`[data-toggle-u="${u.uid}"]`)?.addEventListener("click", () => toggleUser(u));
      document.querySelector(`[data-reset-u="${u.email}"]`)?.addEventListener("click", () => sendReset(u));
    });
  } catch (err) { el.innerHTML = head("帳號管理", "") + errorBox(err); }
}

async function createAccount() {
  const box = $("acAlert");
  const email = $("acEmail").value.trim();
  const pw = $("acPassword").value;
  const name = $("acName").value.trim();
  const house = $("acHouse").value.trim();
  const phone = $("acPhone").value.trim();
  const role = $("acRole").value;

  if (!email || !pw) { box.innerHTML = `<div class="alert error">請填寫帳號與初始密碼</div>`; return; }
  if (pw.length < 6) { box.innerHTML = `<div class="alert error">密碼至少需 6 碼</div>`; return; }
  if (role === "resident" && !house) { box.innerHTML = `<div class="alert error">住戶帳號必須填寫門牌號碼</div>`; return; }

  const btn = $("createAccount");
  btn.disabled = true; btn.textContent = "建立中…";
  // 用第二個 Firebase App 實例建立帳號，
  // 否則 createUserWithEmailAndPassword 會把目前登入的管理員換成新帳號
  let secondary = null;
  try {
    secondary = initializeApp(db.app.options, `acct-${Date.now()}`);
    const cred = await createUserWithEmailAndPassword(getAuth(secondary), email, pw);
    await setDoc(doc(db, "users", cred.user.uid), {
      email, name, houseNumber: house, phone, role, disabled: false,
      createdAt: serverTimestamp(), createdBy: me.email,
    });
    writeLog("account", cred.user.uid, "account_create", { 帳號: email, 姓名: name, 門牌: house, 角色: roleLabel(role) });
    ["acEmail", "acPassword", "acName", "acHouse", "acPhone"].forEach((i) => { $(i).value = ""; });
    box.innerHTML = `<div class="alert ok">帳號已建立：${escapeHtml(email)}</div>`;
    loadAccounts();
  } catch (err) {
    const msg = err.code === "auth/email-already-in-use" ? "此 Email 已被註冊"
      : err.code === "auth/weak-password" ? "密碼強度不足"
      : err.code === "auth/invalid-email" ? "Email 格式不正確"
      : friendlyError(err);
    box.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = "建立帳號";
    if (secondary) await deleteApp(secondary).catch(() => {});
  }
}

async function saveUserRole(u) {
  const role = $(`ur-${u.uid}`).value;
  try {
    await updateDoc(doc(db, "users", u.uid), { role, updatedAt: serverTimestamp() });
    writeLog("account", u.uid, "account_update", { 帳號: u.email, 角色: roleLabel(role) });
    loadAccounts();
  } catch (err) { $("acAlert").innerHTML = errorBox(err); }
}

async function toggleUser(u) {
  const next = !u.disabled;
  if (!confirm(`確定要${next ? "停用" : "啟用"}帳號「${u.email}」？${next ? "\n停用後該帳號將無法登入與預約。" : ""}`)) return;
  try {
    await updateDoc(doc(db, "users", u.uid), { disabled: next, updatedAt: serverTimestamp() });
    writeLog("account", u.uid, "account_update", { 帳號: u.email, 停用: next });
    loadAccounts();
  } catch (err) { $("acAlert").innerHTML = errorBox(err); }
}

async function sendReset(u) {
  if (!u.email) return;
  if (!confirm(`寄送密碼重設信到 ${u.email}？`)) return;
  try {
    await sendPasswordResetEmail(auth, u.email);
    writeLog("account", u.uid, "account_update", { 帳號: u.email, 寄送密碼重設信: true });
    $("acAlert").innerHTML = `<div class="alert ok">已寄出密碼重設信至 ${escapeHtml(u.email)}</div>`;
  } catch (err) { $("acAlert").innerHTML = errorBox(err); }
}

/* ============================================================
   操作紀錄（每 10 筆一頁）
   ============================================================ */

const LOG_PAGE_SIZE = 10;
let logCache = [];
let logPage = 1;

async function loadLogs() {
  const el = $("view-logs");
  el.innerHTML = head("操作紀錄", "紀錄一旦寫入即無法修改或刪除") + `<p class="loading">載入中…</p>`;
  try {
    const snap = await getDocs(query(collection(db, "bookingLogs"), orderBy("timestamp", "desc"), limit(300)));
    logCache = snap.docs.map((d) => d.data());
    logPage = 1;
    renderLogs();
  } catch (err) {
    el.innerHTML = head("操作紀錄", "") + errorBox(err);
  }
}

function renderLogs() {
  const el = $("view-logs");
  const total = logCache.length;
  const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
  logPage = Math.min(Math.max(1, logPage), pages);
  const slice = logCache.slice((logPage - 1) * LOG_PAGE_SIZE, logPage * LOG_PAGE_SIZE);

  el.innerHTML = head("操作紀錄", `共 ${total} 筆，每頁 ${LOG_PAGE_SIZE} 筆`) +
    (total === 0 ? `<div class="card"><p class="empty">尚無操作紀錄</p></div>` : `
    <div class="card">
      ${tableWrap(`<table><thead><tr>
        <th>時間</th><th>操作帳號</th><th>角色</th><th>動作</th><th>內容</th><th>IP</th><th>使用載具</th>
      </tr></thead><tbody>${slice.map((l) => `<tr>
        <td>${l.timestamp?.toDate ? escapeHtml(l.timestamp.toDate().toLocaleString("zh-TW", { hour12: false })) : "—"}</td>
        <td>${escapeHtml(l.actorName || "")}<br><span class="sub-text">${escapeHtml(l.actorEmail || l.actor || "—")}</span></td>
        <td>${escapeHtml(roleLabel(l.actorRole))}</td>
        <td>${escapeHtml(ACTION_LABEL[l.action] || l.action || "—")}</td>
        <td class="detail-cell">${escapeHtml(describeDetail(l.detail))}</td>
        <td class="mono">${escapeHtml(l.ip || "未知")}</td>
        <td>${escapeHtml(l.device || "未知")}</td>
      </tr>`).join("")}</tbody></table>`)}
      <div class="pager">
        <button type="button" class="btn secondary sm" id="logPrev" ${logPage === 1 ? "disabled" : ""}>‹ 上一頁</button>
        <span class="pager-info">第 ${logPage} / ${pages} 頁</span>
        <button type="button" class="btn secondary sm" id="logNext" ${logPage === pages ? "disabled" : ""}>下一頁 ›</button>
      </div>
    </div>`);

  if (total) {
    $("logPrev").addEventListener("click", () => { logPage--; renderLogs(); });
    $("logNext").addEventListener("click", () => { logPage++; renderLogs(); });
  }
}
