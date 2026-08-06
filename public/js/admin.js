import { db, auth } from "./firebase-config.js";
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, query, where, orderBy, limit, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  todayStr, weekStartOf, slotLockId, escapeHtml, fmtStatus,
  fmtDateHuman, fmtDateFull, friendlyError, WEEKDAY_LABEL,
} from "./shared.js";

const $ = (id) => document.getElementById(id);

/* ============================================================
   登入
   ============================================================ */

const loginBtn = $("loginBtn");
loginBtn.addEventListener("click", doLogin);
$("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const email = $("loginEmail").value.trim();
  const pw = $("loginPassword").value;
  const box = $("loginAlert");
  box.innerHTML = "";
  if (!email || !pw) { box.innerHTML = `<div class="alert error">請輸入帳號與密碼</div>`; return; }

  loginBtn.disabled = true; loginBtn.textContent = "登入中…";
  try {
    await signInWithEmailAndPassword(auth, email, pw);
  } catch (err) {
    // 不區分「帳號不存在」與「密碼錯誤」，避免被用來探測有效的管理員帳號
    const msg = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"]
      .includes(err.code) ? "帳號或密碼錯誤"
      : err.code === "auth/too-many-requests" ? "嘗試次數過多，請稍後再試"
      : `登入失敗：${err.code || err.message}`;
    box.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`;
  } finally {
    loginBtn.disabled = false; loginBtn.textContent = "登入";
    $("loginPassword").value = "";
  }
}

$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  const authed = !!user;
  $("loginView").classList.toggle("hidden", authed);
  $("appView").classList.toggle("hidden", !authed);
  if (authed) { $("currentUserLabel").textContent = user.email; initApp(); }
});

const actorTag = () => `property:${auth.currentUser?.email || "unknown"}`;

function logAction(targetType, targetId, action, detail = {}) {
  addDoc(collection(db, "bookingLogs"), {
    targetType, targetId, action, actor: actorTag(), detail, timestamp: serverTimestamp(),
  }).catch(() => {});
}

/* ============================================================
   分頁
   ============================================================ */

const TABS = ["dashboard", "bookings", "facilities", "equipment", "notices", "logs"];
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
    equipment: loadEquipment, notices: loadNotices, logs: loadLogs,
  })[activeTab]();
}

// 多欄中文表格在手機上放不下，統一包一層可橫向捲動的容器
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

    // 逐場地平行查詢維修中的設備。先前用 collectionGroup 需要額外索引，
    // 一旦查詢失敗就會靜默顯示「沒有設備維修中」——那正是本系統最不能出錯的一項。
    const [todaySnap, pendingSnap, ...eqSnaps] = await Promise.all([
      getDocs(query(collection(db, "bookings"), where("date", "==", todayStr()))),
      getDocs(query(collection(db, "bookings"), where("status", "==", "pending_review"))),
      ...facs.map((f) => getDocs(query(collection(db, "facilities", f.id, "equipment"),
        where("status", "==", "maintenance")))),
    ]);

    const all = todaySnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const active = all.filter((b) => !["cancelled", "rejected"].includes(b.status))
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    const cancelledToday = all.length - active.length;

    const maint = [];
    eqSnaps.forEach((s, i) => s.docs.forEach((d) => maint.push({ facility: facs[i].name, ...d.data() })));
    const blockedFacilities = new Set(maint.filter((m) => m.essential).map((m) => m.facility));
    const closed = facs.filter((f) => f.status === "closed").length;

    // 使用率＝今日已被預約的時段數 ÷（場地數 × 每日時段數）
    const slotsPerDay = 7;
    const usage = facs.length ? Math.round(active.length / (facs.length * slotsPerDay) * 100) : 0;

    el.innerHTML = head("今日總覽", fmtDateFull(todayStr())) + `
      <div class="stat-row">
        <div class="card stat"><div class="k">今日預約</div><div class="v">${active.length}<span class="unit">筆</span></div></div>
        <div class="card stat gold"><div class="k">時段使用率</div><div class="v">${usage}<span class="unit">%</span></div></div>
        <div class="card stat"><div class="k">今日取消</div><div class="v">${cancelledToday}<span class="unit">筆</span></div></div>
        <div class="card stat ${blockedFacilities.size + closed ? "seal" : ""}"><div class="k">暫停開放場地</div><div class="v">${blockedFacilities.size + closed}<span class="unit">處</span></div></div>
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
            <td>${escapeHtml(b.slotLabel || `${b.startTime} – ${b.endTime}`)}</td>
            <td>${escapeHtml(b.facilityName)}</td>
            <td>${escapeHtml(b.houseNumber)}</td>
            <td>${escapeHtml(b.applicantName)}</td>
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
        <td class="action-cell">${actions(b)}</td>
      </tr>`).join("")}</tbody></table>`)}
      <div id="bkAlert" aria-live="polite"></div></div>`;

    list.forEach((b) => {
      document.querySelector(`[data-approve="${b.id}"]`)?.addEventListener("click", () => setStatus(b, "confirmed", "approve"));
      document.querySelector(`[data-reject="${b.id}"]`)?.addEventListener("click", () => setStatus(b, "rejected", "reject"));
      document.querySelector(`[data-cancel="${b.id}"]`)?.addEventListener("click", () => setStatus(b, "cancelled", "cancel"));
      document.querySelector(`[data-release="${b.id}"]`)?.addEventListener("click", () => releaseSlot(b));
    });
  } catch (err) {
    box.innerHTML = errorBox(err);
  }
}

function actions(b) {
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
      // 一併清掉跨場地佔位與次數額度，否則該戶會被自己的舊預約卡住卻查不出原因
      await deleteDoc(doc(db, "unitSlotHolds", `${b.houseNumber}__${b.date}__${b.startTime}`)).catch(() => {});
      await refundUsage(b);
    }
    logAction("booking", b.id, action, { facilityId: b.facilityId, date: b.date });
    renderBookings();
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
    await deleteDoc(doc(db, "unitSlotHolds", `${b.houseNumber}__${b.date}__${b.startTime}`)).catch(() => {});
    logAction("booking", b.id, "release_slot", { facilityId: b.facilityId, date: b.date });
    renderBookings();
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

    el.innerHTML = head("場地與時段設定", "", `<button type="button" class="btn primary sm" id="addFacilityBtn">＋ 新增場地</button>`)
      + list.map((f, i) => facilityEditor(f, slots[i].docs.map((d) => ({ id: d.id, ...d.data() })))).join("");
    $("addFacilityBtn").addEventListener("click", addFacility);
    list.forEach((f) => wireFacility(f.id));
  } catch (err) {
    el.innerHTML = head("場地與時段設定", "") + errorBox(err);
  }
}

function facilityEditor(f, slots) {
  const id = f.id;
  return `<div class="card">
    <h3>${escapeHtml(f.name)} <span class="doc-id">${escapeHtml(id)}</span></h3>
    <div class="row">
      <div class="field"><label for="f-name-${id}">名稱</label><input type="text" id="f-name-${id}" value="${escapeHtml(f.name)}"></div>
      <div class="field"><label for="f-capacity-${id}">容納人數（留空＝不限）</label><input type="number" min="0" id="f-capacity-${id}" value="${f.capacity ?? ""}"></div>
      <div class="field"><label for="f-desc-${id}">簡介</label><input type="text" id="f-desc-${id}" value="${escapeHtml(f.description || "")}" placeholder="例：棋藝對弈與靜態閱讀空間。"></div>
    </div>
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
      <div class="field"><label for="f-daily-${id}">同門牌單日上限（0＝不限）</label><input type="number" min="0" id="f-daily-${id}" value="${f.dailyLimitPerUnit ?? 0}"></div>
      <div class="field"><label for="f-weekly-${id}">同門牌單週上限（0＝不限）</label><input type="number" min="0" id="f-weekly-${id}" value="${f.weeklyLimitPerUnit ?? 0}"></div>
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

function wireFacility(id) {
  $(`f-save-${id}`).addEventListener("click", () => saveFacility(id));
  $(`ns-add-${id}`).addEventListener("click", () => addSlot(id));
  document.querySelectorAll(`[data-del-slot][data-fac="${id}"]`).forEach((b) =>
    b.addEventListener("click", () => delSlot(id, b.dataset.delSlot)));
}

async function saveFacility(id) {
  const v = (k) => $(`${k}-${id}`).value;
  const alertEl = $(`f-alert-${id}`);
  const name = v("f-name").trim();
  if (!name) { alertEl.innerHTML = `<div class="alert error">場地名稱不可空白</div>`; return; }
  const data = {
    name,
    description: v("f-desc").trim(),
    capacity: v("f-capacity") === "" ? null : Number(v("f-capacity")),
    status: v("f-status"), bookingMode: v("f-mode"),
    dailyLimitPerUnit: Number(v("f-daily")) || 0,
    weeklyLimitPerUnit: Number(v("f-weekly")) || 0,
    updatedAt: serverTimestamp(), updatedBy: actorTag(),
  };
  try {
    await updateDoc(doc(db, "facilities", id), data);
    logAction("facility", id, "config_change", { ...data, updatedAt: null });
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
      dailyLimitPerUnit: 1, weeklyLimitPerUnit: 0, order: 99,
      updatedAt: serverTimestamp(), updatedBy: actorTag(),
    });
    logAction("facility", id, "config_change", { created: true, name });
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
    await addDoc(collection(db, "facilities", id, "timeSlotTemplates"), { startTime, endTime, weekdays });
    logAction("facility", id, "config_change", { addSlot: { startTime, endTime, weekdays } });
    loadFacilities();
  } catch (err) { alertEl.innerHTML = errorBox(err); }
}

async function delSlot(facilityId, slotId) {
  if (!confirm("確定刪除此時段？已預約到這個時段的住戶不會被自動取消，需另行處理。")) return;
  try {
    await deleteDoc(doc(db, "facilities", facilityId, "timeSlotTemplates", slotId));
    logAction("facility", facilityId, "config_change", { deleteSlot: slotId });
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
          <td><button type="button" class="btn primary sm" data-save-eq="${escapeHtml(e.id)}">儲存</button></td>
        </tr>`).join("")}</tbody></table>`)}
      <div class="row" style="margin-top:16px">
        <div class="field" style="margin:0"><label for="newEqName">新增設備名稱</label><input type="text" id="newEqName" placeholder="例：跑步機 #3"></div>
        <div class="btn-cell"><button type="button" class="btn secondary" id="addEqBtn">＋ 新增設備</button></div>
      </div>
      <div id="eqAlert" aria-live="polite"></div>
    </div>`;
    list.forEach((e) => document.querySelector(`[data-save-eq="${e.id}"]`)
      .addEventListener("click", () => saveEq(facilityId, e.id)));
    $("addEqBtn").addEventListener("click", () => addEq(facilityId));
  } catch (err) { area.innerHTML = errorBox(err); }
}

async function saveEq(facilityId, eqId) {
  const data = {
    essential: $(`eq-ess-${eqId}`).checked,
    status: $(`eq-st-${eqId}`).value,
    note: $(`eq-note-${eqId}`).value.trim(),
    updatedAt: serverTimestamp(), updatedBy: actorTag(),
  };
  try {
    await updateDoc(doc(db, "facilities", facilityId, "equipment", eqId), data);
    logAction("equipment", eqId, "equipment_status_change", { facilityId, ...data, updatedAt: null });
    loadEqList(facilityId);
  } catch (err) { $("eqAlert").innerHTML = errorBox(err); }
}

async function addEq(facilityId) {
  const name = $("newEqName").value.trim();
  if (!name) { $("eqAlert").innerHTML = `<div class="alert error">請輸入設備名稱</div>`; return; }
  try {
    const ref = await addDoc(collection(db, "facilities", facilityId, "equipment"), {
      name, essential: false, status: "normal", note: "",
      updatedAt: serverTimestamp(), updatedBy: actorTag(),
    });
    logAction("equipment", ref.id, "equipment_status_change", { facilityId, created: true, name });
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
  } catch (err) {
    el.innerHTML = head("公告管理", "") + errorBox(err);
  }
}

async function addNotice() {
  const text = $("nText").value.trim();
  const box = $("nAlert");
  if (!text) { box.innerHTML = `<div class="alert error">請輸入公告內容</div>`; return; }
  try {
    await addDoc(collection(db, "announcements"), {
      tag: $("nTag").value.trim() || "公告",
      tone: $("nTone").value,
      date: $("nDate").value || todayStr(),
      text,
      published: $("nPublished").checked,
      createdAt: serverTimestamp(), updatedBy: actorTag(),
    });
    logAction("announcement", "new", "config_change", { text });
    loadNotices();
  } catch (err) { box.innerHTML = errorBox(err); }
}

async function toggleNotice(n) {
  try {
    await updateDoc(doc(db, "announcements", n.id), { published: !n.published, updatedBy: actorTag() });
    logAction("announcement", n.id, "config_change", { published: !n.published });
    loadNotices();
  } catch (err) { $("nAlert").innerHTML = errorBox(err); }
}

async function delNotice(n) {
  if (!confirm("確定刪除這則公告？")) return;
  try {
    await deleteDoc(doc(db, "announcements", n.id));
    logAction("announcement", n.id, "config_change", { deleted: true });
    loadNotices();
  } catch (err) { $("nAlert").innerHTML = errorBox(err); }
}

/* ============================================================
   操作紀錄
   ============================================================ */

const ACTION_LABEL = {
  create: "新增預約", cancel: "取消預約", approve: "核准", reject: "拒絕",
  release_slot: "釋出時段", equipment_status_change: "設備調整", config_change: "設定調整",
};

async function loadLogs() {
  const el = $("view-logs");
  el.innerHTML = head("操作紀錄", "顯示最近 150 筆；紀錄一旦寫入即無法修改或刪除") + `<p class="loading">載入中…</p>`;
  try {
    const snap = await getDocs(query(collection(db, "bookingLogs"), orderBy("timestamp", "desc"), limit(150)));
    const list = snap.docs.map((d) => d.data());
    el.innerHTML = head("操作紀錄", "顯示最近 150 筆；紀錄一旦寫入即無法修改或刪除") +
      (list.length === 0 ? `<div class="card"><p class="empty">尚無操作紀錄</p></div>` : `<div class="card">${tableWrap(`
        <table><thead><tr><th>時間</th><th>操作者</th><th>動作</th><th>對象</th><th>細節</th></tr></thead>
        <tbody>${list.map((l) => `<tr>
          <td>${l.timestamp?.toDate ? escapeHtml(l.timestamp.toDate().toLocaleString("zh-TW")) : "—"}</td>
          <td>${escapeHtml(l.actor === "resident" ? "住戶" : (l.actor || "").replace("property:", ""))}</td>
          <td>${escapeHtml(ACTION_LABEL[l.action] || l.action)}</td>
          <td><code>${escapeHtml(l.targetId || "")}</code></td>
          <td class="detail-cell">${escapeHtml(JSON.stringify(l.detail || {}))}</td>
        </tr>`).join("")}</tbody></table>`)}</div>`);
  } catch (err) {
    el.innerHTML = head("操作紀錄", "") + errorBox(err);
  }
}
