import { db, auth } from "./firebase-config.js?v=20260807l";
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
} from "./shared.js?v=20260807l";
import { watchAuth, login, logout, writeLog, canEnterAdmin } from "./auth.js?v=20260807l";

const $ = (id) => document.getElementById(id);
let me = null;

/* ============================================================
   登入與權限閘門
   ============================================================ */

$("loginBtn").addEventListener("click", doLogin);
$("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("forgotPwdLink").addEventListener("click", doForgotPwd);

async function doForgotPwd(e) {
  e.preventDefault();
  const email = $("loginEmail").value.trim();
  const box = $("loginAlert");
  box.innerHTML = "";
  if (!email) {
    box.innerHTML = `<div class="alert error">請先在 Email 欄位輸入您的信箱，再點擊忘記密碼。</div>`;
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    box.innerHTML = `<div class="alert ok">已寄送重設密碼信至 ${escapeHtml(email)}，請至信箱收取。</div>`;
  } catch (err) {
    const msg = ["auth/invalid-email", "auth/user-not-found"].includes(err.code)
      ? "請輸入正確的帳號 Email"
      : friendlyError(err);
    box.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`;
  }
}

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
  // 窄螢幕的分頁列會左右捲動，把選中的那顆捲進可視範圍，否則點完看不到自己在哪一頁
  $(`tab-${name}`).scrollIntoView({ inline: "nearest", block: "nearest" });
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
    const [todaySnap, pendingSnap, slotSnaps, ...eqSnaps] = await Promise.all([
      getDocs(query(collection(db, "bookings"), where("date", "==", todayStr()))),
      getDocs(query(collection(db, "bookings"), where("status", "==", "pending_review"))),
      Promise.all(facs.map((f) => getDocs(collection(db, "facilities", f.id, "timeSlotTemplates")))),
      ...facs.map((f) => getDocs(query(collection(db, "facilities", f.id, "equipment"),
        where("status", "==", "maintenance")))),
    ]);

    const totalSlots = slotSnaps.reduce((sum, s) => sum + s.size, 0);

    const all = todaySnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const active = all.filter((b) => !["cancelled", "rejected"].includes(b.status))
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));

    const maint = [];
    eqSnaps.forEach((s, i) => s.docs.forEach((d) => maint.push({ facility: facs[i].name, ...d.data() })));
    const blocked = new Set(maint.filter((m) => m.essential).map((m) => m.facility));
    const closed = facs.filter((f) => f.status === "closed").length;
    const usage = totalSlots ? Math.round(active.length / totalSlots * 100) : 0;

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

  const bookingRef = doc(db, "bookings", b.id);
  const lockRef = doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId));
  const holdRef = doc(db, "unitSlotHolds", `${b.uid}__${b.date}__${b.startTime}`);
  const dailyRef = doc(db, "unitDailyUsage", `${b.facilityId}__${b.uid}__${b.date}`);
  const weeklyRef = doc(db, "unitWeeklyUsage", `${b.facilityId}__${b.uid}__${weekStartOf(b.date)}`);

  try {
    const releasing = ["cancelled", "rejected"].includes(newStatus);
    await runTransaction(db, async (tx) => {
      // 讀取操作（必須放在所有寫入之前）
      const bkSnap = await tx.get(bookingRef);
      const dailySnap = releasing ? await tx.get(dailyRef) : null;
      const weeklySnap = releasing ? await tx.get(weeklyRef) : null;

      if (!bkSnap.exists()) throw new Error("not-found");

      // 寫入操作
      tx.update(bookingRef, {
        status: newStatus, cancelledAt: releasing ? serverTimestamp() : null,
      });

      tx.set(lockRef, {
        facilityId: b.facilityId, date: b.date, slotId: b.slotId,
        status: releasing ? "cancelled" : newStatus, bookingId: b.id, createdAt: serverTimestamp(),
      });

      if (releasing) {
        tx.delete(holdRef);

        if (dailySnap && dailySnap.exists() && dailySnap.data().count > 0) {
          tx.set(dailyRef, { count: dailySnap.data().count - 1, facilityId: b.facilityId, uid: b.uid, date: b.date });
        }
        if (weeklySnap && weeklySnap.exists() && weeklySnap.data().count > 0) {
          tx.set(weeklyRef, { count: weeklySnap.data().count - 1, facilityId: b.facilityId, uid: b.uid, date: weekStartOf(b.date) });
        }
      }
    });

    writeLog("booking", b.id, action, { 場地: b.facilityName, 日期: b.date, 門牌: b.houseNumber }).catch(() => {});
    renderBookings();
  } catch (err) { $("bkAlert").innerHTML = errorBox(err); }
}

async function releaseSlot(b) {
  const lockRef = doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId));
  const holdRef = doc(db, "unitSlotHolds", `${b.uid}__${b.date}__${b.startTime}`);
  try {
    await runTransaction(db, async (tx) => {
      tx.set(lockRef, {
        facilityId: b.facilityId, date: b.date, slotId: b.slotId,
        status: "cancelled", bookingId: b.id, createdAt: serverTimestamp(),
      });
      tx.delete(holdRef);
    });
    writeLog("booking", b.id, "release_slot", { 場地: b.facilityName, 日期: b.date }).catch(() => {});
    renderBookings();
  } catch (err) { $("bkAlert").innerHTML = errorBox(err); }
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
  const btn = $(`f-save-${id}`);
  btn.disabled = true;
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
    writeLog("facility", id, "config_change", { name, 容納人數: data.capacity, 狀態: data.status, 審核方式: data.bookingMode }).catch(() => {});
    alertEl.innerHTML = `<div class="alert ok">已儲存</div>`;
    setTimeout(() => { alertEl.innerHTML = ""; }, 3000);
  } catch (err) { alertEl.innerHTML = errorBox(err); }
  finally { btn.disabled = false; }
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
  const btn = $(`ns-add-${id}`);
  btn.disabled = true;
  try {
    await setDoc(doc(db, "facilities", id, "timeSlotTemplates", `t${startTime.replace(":", "")}`),
      { startTime, endTime, weekdays });
    writeLog("facility", id, "config_change", { 新增時段: `${startTime}–${endTime}` }).catch(() => {});
    loadFacilities();
  } catch (err) { alertEl.innerHTML = errorBox(err); }
  finally { btn.disabled = false; }
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
  const btn = document.querySelector(`[data-save-eq="${eqId}"]`);
  if (btn) btn.disabled = true;
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
    }).catch(() => {});
    loadEqList(facilityId);
  } catch (err) { $("eqAlert").innerHTML = errorBox(err); }
  finally { if (btn) btn.disabled = false; }
}

async function addEq(facilityId) {
  const name = $("newEqName").value.trim();
  if (!name) { $("eqAlert").innerHTML = `<div class="alert error">請輸入設備名稱</div>`; return; }
  const btn = $("addEqBtn");
  btn.disabled = true;
  try {
    const ref = await addDoc(collection(db, "facilities", facilityId, "equipment"), {
      name, essential: false, status: "normal", note: "", updatedAt: serverTimestamp(),
    });
    writeLog("equipment", ref.id, "equipment_status_change", { 場地: facilityId, 新增: true, 設備: name }).catch(() => {});
    loadEqList(facilityId);
  } catch (err) { $("eqAlert").innerHTML = errorBox(err); }
  finally { btn.disabled = false; }
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
  const btn = $("addNotice");
  btn.disabled = true;
  try {
    const ref = await addDoc(collection(db, "announcements"), {
      tag: $("nTag").value.trim() || "公告", tone: $("nTone").value,
      date: $("nDate").value || todayStr(), text, published: $("nPublished").checked,
      createdAt: serverTimestamp(),
    });
    writeLog("announcement", ref.id, "config_change", { 新增: true, 內容: text }).catch(() => {});
    loadNotices();
  } catch (err) { box.innerHTML = errorBox(err); }
  finally { btn.disabled = false; }
}

async function toggleNotice(n) {
  const btn = document.querySelector(`[data-toggle-n="${n.id}"]`);
  if (btn) btn.disabled = true;
  try {
    await updateDoc(doc(db, "announcements", n.id), { published: !n.published });
    writeLog("announcement", n.id, "config_change", { 發布: !n.published, 內容: n.text }).catch(() => {});
    loadNotices();
  } catch (err) { $("nAlert").innerHTML = errorBox(err); }
  finally { if (btn) btn.disabled = false; }
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

const AC_PAGE_SIZE = 10;
let acCache = [];        // 全部帳號，搜尋與分頁都在前端做
let acPage = 1;
let acQuery = "";
let acImportRows = null; // 預覽通過、等待確認建立的列

// 匯出／匯入共用的欄位定義。順序即是 XLSX 的欄序。
const AC_COLUMNS = [
  { header: "門牌", key: "houseNumber", width: 22 },
  { header: "姓名", key: "name", width: 14 },
  { header: "帳號（Email）", key: "email", width: 30 },
  { header: "聯絡電話", key: "phone", width: 16 },
  { header: "角色", key: "role", width: 14 },
  { header: "狀態", key: "status", width: 10 },
];

async function loadAccounts() {
  const el = $("view-accounts");
  if (!isSystemAdmin()) {
    // 把實際讀到的角色一併顯示，否則遇到權限問題時完全無從判斷是哪裡出錯
    el.innerHTML = head("帳號管理", "") + `<div class="card">
      <p class="empty">僅系統管理員可管理帳號。</p>
      <div class="spec-list" style="margin-top:12px">
        <div><span class="k">目前登入帳號</span><span class="v">${escapeHtml(me?.email || "（未取得）")}</span></div>
        <div><span class="k">偵測到的角色</span><span class="v">${escapeHtml(me?.role || "（未設定）")}</span></div>
        <div><span class="k">帳號編號</span><span class="v mono">${escapeHtml(me?.uid || "—")}</span></div>
      </div>
      <p class="hint">若角色不是 system_admin，請系統管理員至 Firestore 的 <code>users</code> 集合，
      把此帳號編號對應文件的 <code>role</code> 欄位改為 <code>system_admin</code>。</p>
    </div>`;
    return;
  }
  el.innerHTML = head("帳號管理", "住戶需有帳號才能預約設施") + `<p class="loading">載入中…</p>`;
  try {
    // 不用 orderBy：Firestore 會把缺少排序欄位的文件整筆略過，
    // 沒填門牌的管理員帳號就會憑空從列表消失。改成全部取回後在前端排序。
    const snap = await getDocs(collection(db, "users"));
    acCache = snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (a.houseNumber || "").localeCompare(b.houseNumber || "", "zh-Hant"));
    acPage = 1; acQuery = ""; acImportRows = null;
    const list = acCache;

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
        <h3>批次匯入／匯出</h3>
        <div class="row">
          <div class="btn-cell"><button type="button" class="btn secondary" id="acExport">匯出 XLSX</button></div>
          <div class="btn-cell"><button type="button" class="btn ghost sm" id="acTemplate">下載空白範本</button></div>
        </div>
        <p class="hint">匯出的是目前搜尋條件下的清單；未搜尋時即為全部帳號。</p>
        <div class="row" style="margin-top:16px;border-top:1px dotted var(--border-strong);padding-top:16px">
          <div class="field"><label for="acFile">選擇要匯入的 XLSX</label><input type="file" id="acFile" accept=".xlsx"></div>
          <div class="field"><label for="acBulkPw">統一初始密碼（至少 6 碼）</label><input type="text" id="acBulkPw" autocomplete="off" placeholder="所有新帳號共用"></div>
        </div>
        <p class="hint">匯入<strong>只會建立新帳號</strong>；Email 已存在的列一律略過，不會覆寫既有資料。
          所有新帳號套用同一組初始密碼，請務必要求住戶首次登入後立即更改。</p>
        <button type="button" class="btn secondary" id="acPreview">讀取檔案並預覽</button>
        <div id="acImportInfo" aria-live="polite"></div>
      </div>

      <div class="card">
        <div class="result-head">
          <h3 style="margin:0">帳號列表</h3>
          <input type="search" id="acSearch" class="ac-search" placeholder="搜尋門牌／姓名／Email／電話／角色" aria-label="搜尋帳號">
        </div>
        <div id="acTable"></div>
        <p class="hint">為避免把自己鎖在系統外，無法修改或停用目前登入中的帳號。</p>
      </div>`;

    $("createAccount").addEventListener("click", createAccount);
    $("acSearch").addEventListener("input", (e) => { acQuery = e.target.value; acPage = 1; renderAccounts(); });
    $("acExport").addEventListener("click", exportAccounts);
    $("acTemplate").addEventListener("click", exportTemplate);
    $("acPreview").addEventListener("click", previewImport);
    renderAccounts();
  } catch (err) { el.innerHTML = head("帳號管理", "") + errorBox(err); }
}

/* ---------- 列表：搜尋 + 每頁 10 筆 ---------- */

function filteredAccounts() {
  const q = acQuery.trim().toLowerCase();
  if (!q) return acCache;
  return acCache.filter((u) => [u.houseNumber, u.name, u.email, u.phone, roleLabel(u.role)]
    .some((v) => String(v || "").toLowerCase().includes(q)));
}

function renderAccounts() {
  const box = $("acTable");
  if (!box) return;
  const list = filteredAccounts();
  const total = list.length;

  if (!total) {
    box.innerHTML = `<p class="empty">${acQuery.trim() ? "沒有符合搜尋條件的帳號" : "尚無帳號"}</p>`;
    updateExportLabel(0);
    return;
  }

  const pages = Math.max(1, Math.ceil(total / AC_PAGE_SIZE));
  acPage = Math.min(Math.max(1, acPage), pages);
  const slice = list.slice((acPage - 1) * AC_PAGE_SIZE, acPage * AC_PAGE_SIZE);

  box.innerHTML = tableWrap(`
    <table><thead><tr><th>門牌</th><th>姓名</th><th>帳號</th><th>電話</th><th>角色</th><th>狀態</th><th>操作</th></tr></thead>
    <tbody>${slice.map((u) => `<tr class="${u.disabled ? "row-danger" : ""}">
      <td><input type="text" id="uh-${u.uid}" value="${escapeHtml(u.houseNumber || "")}" placeholder="門牌" class="table-input" style="width:110px" ${u.uid === me.uid ? "disabled" : ""}></td>
      <td><input type="text" id="un-${u.uid}" value="${escapeHtml(u.name || "")}" placeholder="姓名" class="table-input" style="width:90px" ${u.uid === me.uid ? "disabled" : ""}></td>
      <td class="sub-text">${escapeHtml(u.email || "")}</td>
      <td><input type="text" id="up-${u.uid}" value="${escapeHtml(u.phone || "")}" placeholder="電話" class="table-input" style="width:125px" ${u.uid === me.uid ? "disabled" : ""}></td>
      <td><select id="ur-${u.uid}" ${u.uid === me.uid ? "disabled" : ""}>
        ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${v}</option>`).join("")}
      </select></td>
      <td>${u.disabled ? `<span class="badge seal">已停用</span>` : `<span class="badge jade">啟用中</span>`}</td>
      <td class="action-cell">
        <button type="button" class="btn primary sm" data-save-u="${escapeHtml(u.uid)}" ${u.uid === me.uid ? "disabled" : ""}>儲存</button>
        <button type="button" class="btn secondary sm" data-toggle-u="${escapeHtml(u.uid)}" ${u.uid === me.uid ? "disabled" : ""}>${u.disabled ? "啟用" : "停用"}</button>
        <button type="button" class="btn ghost sm" data-reset-u="${escapeHtml(u.uid)}">重設密碼</button>
      </td></tr>`).join("")}</tbody></table>`) + `
    <div class="pager">
      <button type="button" class="btn secondary sm" id="acPrev" ${acPage === 1 ? "disabled" : ""}>‹ 上一頁</button>
      <span class="pager-info">第 ${acPage} / ${pages} 頁・共 ${total} 筆${acQuery.trim() ? `（已篩選，全部 ${acCache.length} 筆）` : ""}</span>
      <button type="button" class="btn secondary sm" id="acNext" ${acPage === pages ? "disabled" : ""}>下一頁 ›</button>
    </div>
    <div id="acAlert2" aria-live="polite"></div>`;

  // 只掛當頁這 10 筆的事件
  slice.forEach((u) => {
    document.querySelector(`[data-save-u="${u.uid}"]`)?.addEventListener("click", () => saveUserInfo(u));
    document.querySelector(`[data-toggle-u="${u.uid}"]`)?.addEventListener("click", () => toggleUser(u));
    // 用 uid 而非 email 當選擇器：兩個帳號都沒填 email 時，
    // [data-reset-u=""] 會撞在一起，只有第一筆掛得到事件
    document.querySelector(`[data-reset-u="${u.uid}"]`)?.addEventListener("click", () => sendReset(u));
  });
  $("acPrev").addEventListener("click", () => { acPage--; renderAccounts(); });
  $("acNext").addEventListener("click", () => { acPage++; renderAccounts(); });
  updateExportLabel(total);
}

function updateExportLabel(n) {
  const btn = $("acExport");
  if (btn) btn.textContent = `匯出 XLSX（${n} 筆）`;
}

/* ---------- XLSX 匯出 ---------- */

// ExcelJS 有 947 KB，只在真的要匯出／匯入時才載入，不拖慢後台其他分頁。
// 後台是敏感頁面，第三方程式碼一律加 SRI，被竄改就不會執行。
const EXCELJS_SRC = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
const EXCELJS_SRI = "sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz";
let excelPromise = null;

function loadExcel() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (excelPromise) return excelPromise;
  excelPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = EXCELJS_SRC;
    s.integrity = EXCELJS_SRI;
    s.crossOrigin = "anonymous";
    s.onload = () => window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error("ExcelJS 載入後找不到物件"));
    s.onerror = () => { excelPromise = null; reject(new Error("無法載入試算表元件，請確認網路連線")); };
    document.head.appendChild(s);
  });
  return excelPromise;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function thinBorder(argb) {
  const s = { style: "thin", color: { argb } };
  return { top: s, left: s, bottom: s, right: s };
}

function buildAccountsWorkbook(ExcelJS, users, { note = "" } = {}) {
  const now = new Date();
  const wb = new ExcelJS.Workbook();
  wb.creator = "聯懋超綻公共設施預約系統";
  wb.created = now;

  const ws = wb.addWorksheet("帳號列表", {
    views: [{ state: "frozen", ySplit: 2 }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.mergeCells(1, 1, 1, AC_COLUMNS.length);
  const banner = ws.getCell(1, 1);
  banner.value = `聯懋超綻 帳號列表（匯出時間 ${stamp(now)}，共 ${users.length} 筆${note}）`;
  banner.font = { name: "Microsoft JhengHei", size: 13, bold: true, color: { argb: "FF1C1814" } };
  banner.alignment = { vertical: "middle", horizontal: "left" };
  banner.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F0E4" } };
  ws.getRow(1).height = 26;

  ws.columns = AC_COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  const headRow = ws.getRow(2);
  AC_COLUMNS.forEach((c, i) => { headRow.getCell(i + 1).value = c.header; });
  headRow.height = 20;
  headRow.eachCell((cell) => {
    cell.font = { name: "Microsoft JhengHei", bold: true, color: { argb: "FFFBF8F1" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC8A04A" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = thinBorder("FFB08A3E");
  });

  users.forEach((u, idx) => {
    const row = ws.addRow({
      houseNumber: u.houseNumber || "",
      name: u.name || "",
      email: u.email || "",
      phone: u.phone || "",
      role: roleLabel(u.role),
      status: u.disabled ? "已停用" : "啟用中",
    });
    row.eachCell((cell) => {
      cell.font = { name: "Microsoft JhengHei", size: 11 };
      cell.alignment = { vertical: "middle" };
      cell.border = thinBorder("FFE7DFCF");
    });
    // 電話一定要存成文字，否則 09 開頭會被 Excel 當數字吃掉前導零
    row.getCell("phone").numFmt = "@";
    row.getCell("status").alignment = { vertical: "middle", horizontal: "center" };
    const fill = u.disabled ? "FFFAF0EE" : (idx % 2 === 1 ? "FFFBF9F4" : null);
    if (fill) row.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } }; });
  });

  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: AC_COLUMNS.length } };
  return wb;
}

async function downloadWorkbook(wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportAccounts() {
  const btn = $("acExport");
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "產生中…";
  try {
    const ExcelJS = await loadExcel();
    const list = filteredAccounts();
    const q = acQuery.trim();
    const wb = buildAccountsWorkbook(ExcelJS, list, { note: q ? `，搜尋條件「${q}」` : "" });
    await downloadWorkbook(wb, `聯懋超綻_帳號列表_${stamp().replace(/[ :]/g, "")}.xlsx`);
  } catch (err) {
    $("acImportInfo").innerHTML = errorBox(err);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function exportTemplate() {
  const btn = $("acTemplate");
  btn.disabled = true;
  try {
    const ExcelJS = await loadExcel();
    // 範本用兩筆範例列示範格式，管理者照著改就好
    const wb = buildAccountsWorkbook(ExcelJS, [
      { houseNumber: "A 棟 12 樓之 3", name: "王小明", email: "wang@example.com", phone: "0912345678", role: "resident" },
      { houseNumber: "B 棟 8 樓之 1", name: "陳美麗", email: "chen@example.com", phone: "0922333444", role: "resident" },
    ], { note: "，範本" });
    await downloadWorkbook(wb, "聯懋超綻_帳號匯入範本.xlsx");
  } catch (err) {
    $("acImportInfo").innerHTML = errorBox(err);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- XLSX 匯入 ---------- */

// ExcelJS 的 cell.value 型別很雜：字串、數字、Date、
// {text,hyperlink}（Excel 會把 Email 自動變超連結）、{richText}、{formula,result}。
// 一律先攤平成純文字再處理。
function cellText(cell) {
  const v = cell?.value;
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("").trim();
  if (v.text != null) return String(v.text).trim();
  if (v.result != null) return String(v.result).trim();
  return String(v).trim();
}

// 標題文字 → 欄位。必須用「整格精確比對」而非包含比對：
// 匯出檔第 1 列的橫幅是「聯懋超綻 帳號列表（匯出時間…）」，
// 用包含比對會把橫幅誤判成標題列，欄位對應整個錯掉。
const HEADER_ALIASES = {
  houseNumber: ["門牌", "門牌號碼"],
  name: ["姓名", "住戶姓名"],
  email: ["帳號(email)", "帳號", "email", "電子郵件", "信箱"],
  phone: ["聯絡電話", "電話", "手機"],
  role: ["角色", "權限"],
};

function normHeader(s) {
  return (s || "").replace(/\s/g, "").replace(/（/g, "(").replace(/）/g, ")").toLowerCase();
}

// 從前 10 列裡找出真正的標題列：必須有 Email 欄，且至少對應到 2 個已知欄位
function findHeaderRow(ws) {
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    const colOf = {};
    ws.getRow(r).eachCell({ includeEmpty: true }, (cell, c) => {
      const s = normHeader(cellText(cell));
      if (!s) return;
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (colOf[key] === undefined && aliases.includes(s)) { colOf[key] = c; return; }
      }
    });
    if (colOf.email !== undefined && Object.keys(colOf).length >= 2) return { headerRow: r, colOf };
  }
  return null;
}

function parseRoleCell(s) {
  const t = (s || "").trim();
  if (!t) return "resident";              // 留空預設為一般住戶
  if (ROLES[t]) return t;                 // 直接寫代碼
  const hit = Object.entries(ROLES).find(([, label]) => label === t);
  return hit ? hit[0] : null;             // null 代表無法辨識
}

// Excel 把 0912345678 存成數字時前導零會消失，補回來
function normalizePhone(s) {
  const t = (s || "").trim();
  return /^9\d{8}$/.test(t) ? `0${t}` : t;
}

async function previewImport() {
  const info = $("acImportInfo");
  const file = $("acFile").files?.[0];
  const pw = $("acBulkPw").value;
  acImportRows = null;

  if (!file) { info.innerHTML = `<div class="alert error">請先選擇要匯入的 XLSX 檔</div>`; return; }
  if (pw.length < 6) { info.innerHTML = `<div class="alert error">請先填寫統一初始密碼，至少 6 碼</div>`; return; }

  const btn = $("acPreview");
  btn.disabled = true; btn.textContent = "讀取中…";
  try {
    const ExcelJS = await loadExcel();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("這個檔案裡沒有任何工作表");

    const found = findHeaderRow(ws);
    if (!found) {
      throw new Error("找不到欄位標題列。請確認檔案裡有「帳號（Email）」這一欄，建議先下載空白範本");
    }
    const { headerRow, colOf } = found;

    const existing = new Set(acCache.map((u) => (u.email || "").toLowerCase()).filter(Boolean));
    const seen = new Set();
    const ok = [], skipped = [], bad = [];

    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (k) => (colOf[k] ? cellText(row.getCell(colOf[k])) : "");
      const email = get("email").toLowerCase();
      const name = get("name");
      const houseNumber = get("houseNumber");
      const phone = normalizePhone(get("phone"));
      const roleRaw = get("role");

      if (!email && !name && !houseNumber && !phone) continue;   // 整列空白，跳過

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { bad.push({ r, email: email || "（空白）", why: "Email 格式不正確" }); continue; }
      if (seen.has(email)) { bad.push({ r, email, why: "檔案內重複出現" }); continue; }
      seen.add(email);

      const role = parseRoleCell(roleRaw);
      if (!role) { bad.push({ r, email, why: `無法辨識的角色「${roleRaw}」` }); continue; }
      if (role === "resident" && !houseNumber) { bad.push({ r, email, why: "住戶帳號必須填門牌" }); continue; }

      if (existing.has(email)) { skipped.push({ r, email }); continue; }
      ok.push({ r, email, name, houseNumber, phone, role });
    }

    acImportRows = ok;
    info.innerHTML = `
      <div class="alert ${ok.length ? "ok" : "error"}" style="margin-top:12px">
        讀取完成：可建立 <strong>${ok.length}</strong> 筆、
        略過 <strong>${skipped.length}</strong> 筆（Email 已存在）、
        錯誤 <strong>${bad.length}</strong> 筆
      </div>
      ${bad.length ? `<div class="card" style="margin-top:12px">
        <h3 style="font-size:var(--text-base)">需要修正的列</h3>
        ${tableWrap(`<table><thead><tr><th>列號</th><th>Email</th><th>原因</th></tr></thead><tbody>
          ${bad.slice(0, 50).map((b) => `<tr><td>${b.r}</td><td>${escapeHtml(b.email)}</td><td>${escapeHtml(b.why)}</td></tr>`).join("")}
        </tbody></table>`)}
        ${bad.length > 50 ? `<p class="hint">僅顯示前 50 筆。</p>` : ""}
      </div>` : ""}
      ${skipped.length ? `<p class="hint">略過的 Email：${escapeHtml(skipped.slice(0, 20).map((s) => s.email).join("、"))}${skipped.length > 20 ? ` … 等 ${skipped.length} 筆` : ""}</p>` : ""}
      ${ok.length ? `<button type="button" class="btn primary" id="acDoImport" style="margin-top:12px">確認建立這 ${ok.length} 筆帳號</button>` : ""}`;
    if (ok.length) $("acDoImport").addEventListener("click", runImport);
  } catch (err) {
    info.innerHTML = errorBox(err);
  } finally {
    btn.disabled = false; btn.textContent = "讀取檔案並預覽";
  }
}

async function runImport() {
  if (!acImportRows?.length) return;
  const pw = $("acBulkPw").value;
  if (pw.length < 6) { $("acImportInfo").innerHTML = `<div class="alert error">初始密碼至少 6 碼</div>`; return; }
  if (!confirm(`確定要建立 ${acImportRows.length} 個帳號嗎？\n所有帳號的初始密碼都會是你填寫的那一組。`)) return;

  const btn = $("acDoImport");
  btn.disabled = true;
  const info = $("acImportInfo");
  const done = [], failed = [];

  // 整批共用一個第二 Firebase 實例，避免每筆都 initializeApp／deleteApp。
  // 用第二實例才不會把目前登入的管理員換成剛建立的帳號。
  let secondary = null;
  try {
    secondary = initializeApp(db.app.options, `bulk-${Date.now()}`);
    const sAuth = getAuth(secondary);
    for (const row of acImportRows) {
      btn.textContent = `建立中… ${done.length + failed.length + 1} / ${acImportRows.length}`;
      try {
        const cred = await createUserWithEmailAndPassword(sAuth, row.email, pw);
        await setDoc(doc(db, "users", cred.user.uid), {
          email: row.email, name: row.name, houseNumber: row.houseNumber,
          phone: row.phone, role: row.role, disabled: false,
          createdAt: serverTimestamp(), createdBy: me.email,
        });
        writeLog("account", cred.user.uid, "account_create", {
          帳號: row.email, 姓名: row.name, 門牌: row.houseNumber,
          角色: roleLabel(row.role), 批次匯入: true,
        });
        done.push(row.email);
      } catch (err) {
        const msg = err.code === "auth/email-already-in-use" ? "此 Email 已被註冊"
          : err.code === "auth/weak-password" ? "密碼強度不足"
          : err.code === "auth/invalid-email" ? "Email 格式不正確"
          : friendlyError(err);
        failed.push({ email: row.email, msg });
      }
    }
  } catch (err) {
    info.innerHTML = errorBox(err);
  } finally {
    if (secondary) await deleteApp(secondary).catch(() => {});
  }

  acImportRows = null;
  info.innerHTML = `
    <div class="alert ${failed.length ? "error" : "ok"}" style="margin-top:12px">
      匯入完成：成功 <strong>${done.length}</strong> 筆${failed.length ? `、失敗 <strong>${failed.length}</strong> 筆` : ""}
    </div>
    ${failed.length ? tableWrap(`<table><thead><tr><th>Email</th><th>失敗原因</th></tr></thead><tbody>
      ${failed.map((f) => `<tr><td>${escapeHtml(f.email)}</td><td>${escapeHtml(f.msg)}</td></tr>`).join("")}
    </tbody></table>`) : ""}`;
  $("acFile").value = "";
  loadAccounts();
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

async function saveUserInfo(u) {
  const btn = document.querySelector(`[data-save-u="${u.uid}"]`);
  if (btn) btn.disabled = true;
  const role = $(`ur-${u.uid}`).value;
  const houseNumber = $(`uh-${u.uid}`).value.trim();
  const name = $(`un-${u.uid}`).value.trim();
  const phone = $(`up-${u.uid}`).value.trim();

  if (role === "resident" && !houseNumber) {
    $("acAlert").innerHTML = `<div class="alert error">住戶帳號必須填寫門牌號碼</div>`;
    if (btn) btn.disabled = false;
    return;
  }

  try {
    await updateDoc(doc(db, "users", u.uid), {
      role, houseNumber, name, phone,
      updatedAt: serverTimestamp(),
    });
    writeLog("account", u.uid, "account_update", {
      帳號: u.email, 姓名: name, 門牌: houseNumber, 電話: phone, 角色: roleLabel(role),
    }).catch(() => {});
    $("acAlert").innerHTML = `<div class="alert ok">帳號資料已儲存：${escapeHtml(u.email)}</div>`;
    loadAccounts();
  } catch (err) { $("acAlert").innerHTML = errorBox(err); }
  finally { if (btn) btn.disabled = false; }
}

async function toggleUser(u) {
  const next = !u.disabled;
  if (!confirm(`確定要${next ? "停用" : "啟用"}帳號「${u.email}」？${next ? "\n停用後該帳號將無法登入與預約。" : ""}`)) return;
  const btn = document.querySelector(`[data-toggle-u="${u.uid}"]`);
  if (btn) btn.disabled = true;
  try {
    await updateDoc(doc(db, "users", u.uid), { disabled: next, updatedAt: serverTimestamp() });
    writeLog("account", u.uid, "account_update", { 帳號: u.email, 停用: next }).catch(() => {});
    loadAccounts();
  } catch (err) { $("acAlert").innerHTML = errorBox(err); }
  finally { if (btn) btn.disabled = false; }
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
