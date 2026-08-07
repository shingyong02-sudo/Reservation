import { db, auth } from "./firebase-config.js?v=20260807k";
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  runTransaction, updateDoc, setDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  COMMUNITY, generateQueryCode, todayStr, addDays, isoWeekday, weekStartOf,
  slotLockId, escapeHtml, fmtStatus, fmtDateHuman, fmtDateFull, fmtSlot,
  friendlyError, WEEKDAY_LABEL,
} from "./shared.js?v=20260807k";
import { watchAuth, login, logout, writeLog, canEnterAdmin } from "./auth.js?v=20260807k";

const $ = (id) => document.getElementById(id);

let me = null;            // 目前登入者的個人檔
let facilities = [];
const blockedCache = new Map();

/* ============================================================
   檢視切換 + 瀏覽器上一頁
   ============================================================ */

const VIEWS = { login: "viewLogin", home: "viewHome", booking: "viewBooking", mine: "viewMine" };

/**
 * 切換檢視。預設會 pushState，讓瀏覽器的「上一頁」能退回上一個畫面
 * （例如從預約流程按上一頁會回到首頁）。
 */
function navigate(view, state = {}, push = true) {
  Object.entries(VIEWS).forEach(([k, id]) => $(id).classList.toggle("hidden", k !== view));
  document.body.classList.toggle("page-home", view === "home");
  if (push) history.pushState({ view, ...state }, "", view === "home" ? "#" : `#${view}`);
  window.scrollTo({ top: 0, behavior: "instant" });
}

window.addEventListener("popstate", (e) => {
  const s = e.state || { view: me ? "home" : "login" };
  if (!me) { navigate("login", {}, false); return; }
  if (s.view === "booking" && s.step && picked.facility) {
    step = s.step;
    navigate("booking", {}, false);
    renderSteps();
    (step === 3 ? renderForm : renderSlotPicker)();
  } else {
    navigate(s.view === "booking" ? "home" : (s.view || "home"), {}, false);
    if (s.view === "mine") loadMine();
  }
});

document.querySelectorAll("[data-goto]").forEach((el) => {
  el.addEventListener("click", () => {
    navigate("home");
    setTimeout(() => $(el.dataset.goto)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  });
});
$("navMine").addEventListener("click", () => { navigate("mine"); loadMine(); });
$("heroMine").addEventListener("click", () => { navigate("mine"); loadMine(); });
$("brandLink").addEventListener("click", (e) => { e.preventDefault(); navigate("home"); });

document.querySelectorAll(".contact-phone").forEach((el) => { el.textContent = COMMUNITY.phone; });
$("specWindow").textContent = `${COMMUNITY.bookingWindowDays} 天內`;

/* ============================================================
   登入
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
    box.innerHTML = `<div class="alert error">請先在「帳號（Email）」欄位輸入您的信箱，再點擊忘記密碼。</div>`;
    return;
  }
  // 與登入同樣不透露帳號是否存在，避免被用來探測有效帳號
  const ok = `<div class="alert ok">若 ${escapeHtml(email)} 是本社區的住戶帳號，重設密碼信已寄出，請至信箱收取（含垃圾信匣）。</div>`;
  try {
    await sendPasswordResetEmail(auth, email);
    box.innerHTML = ok;
  } catch (err) {
    const msg = err.code === "auth/invalid-email" ? "Email 格式不正確，請重新輸入"
      : err.code === "auth/too-many-requests" ? "嘗試次數過多，請稍後再試"
      : null;
    box.innerHTML = msg ? `<div class="alert error">${escapeHtml(msg)}</div>` : ok;
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
    await login(email, pw);
  } catch (err) {
    // 不區分「帳號不存在」與「密碼錯誤」，避免被用來探測有效帳號
    const msg = err.message === "NO_PROFILE" ? "此帳號尚未完成設定，請洽物業管理中心。"
      : err.message === "ACCOUNT_DISABLED" ? "此帳號已停用，請洽物業管理中心。"
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

/* ============================================================
   問候列（日期／姓名／花蓮市天氣）
   ============================================================ */

// 花蓮市。座標寫死，不用瀏覽器定位——Permissions-Policy 已停用 geolocation，
// 且社區位置固定，問住戶要定位權限沒有意義。
const WEATHER = {
  lat: 23.9769,
  lon: 121.6044,
  cacheKey: "wx-hualien",
  cacheMinutes: 30,
};

// WMO weather code → 中文說明與符號。
// 符號一律加 U+FE0E（文字表示選擇器），避免被渲染成彩色 emoji。
const WMO = [
  [[0], "晴天", "☀︎"],
  [[1], "晴時多雲", "☀︎"],
  [[2], "多雲", "☁︎"],
  [[3], "陰天", "☁︎"],
  [[45, 48], "有霧", "☁︎"],
  [[51, 53, 55, 56, 57], "毛毛雨", "☂︎"],
  [[61, 63, 65, 66, 67], "雨天", "☂︎"],
  [[71, 73, 75, 77, 85, 86], "下雪", "❄︎"],
  [[80, 81, 82], "陣雨", "☂︎"],
  [[95, 96, 99], "雷雨", "⚡︎"],
];

function describeWeather(code) {
  const hit = WMO.find(([codes]) => codes.includes(code));
  return hit ? { text: hit[1], icon: hit[2] } : { text: "—", icon: "☁︎" };
}

function renderGreeting(profile) {
  const today = todayStr();
  const [, m, d] = today.split("-");
  $("greetDate").textContent =
    `星期${WEEKDAY_LABEL[isoWeekday(today) - 1]}・${Number(m)} 月 ${Number(d)} 日`;
  const name = (profile?.name || "").trim();
  $("greetHi").textContent = name ? `${name} 您好` : "住戶您好";
}

async function loadWeather() {
  const box = $("greetWeather");
  try {
    const cached = readWeatherCache();
    const wx = cached || await fetchWeather();
    const { text, icon } = describeWeather(wx.code);
    $("wxIcon").textContent = icon;
    $("wxText").textContent = text;
    $("wxTemp").textContent = `${Math.round(wx.temp)}°`;
    box.title = `花蓮市 ${text} ${Math.round(wx.temp)}°C`;
    box.classList.remove("hidden");
  } catch {
    // 天氣只是附加資訊，抓不到就整塊不顯示，不要拿錯誤訊息打擾住戶
    box.classList.add("hidden");
  }
}

function readWeatherCache() {
  try {
    const raw = sessionStorage.getItem(WEATHER.cacheKey);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (Date.now() - c.at > WEATHER.cacheMinutes * 60 * 1000) return null;
    return c;
  } catch { return null; }
}

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER.lat}`
    + `&longitude=${WEATHER.lon}&current=temperature_2m,weather_code&timezone=Asia%2FTaipei`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`weather ${res.status}`);
    const j = await res.json();
    const wx = { temp: j.current.temperature_2m, code: j.current.weather_code, at: Date.now() };
    if (typeof wx.temp !== "number" || typeof wx.code !== "number") throw new Error("weather shape");
    try { sessionStorage.setItem(WEATHER.cacheKey, JSON.stringify(wx)); } catch { /* 無痕模式會擋，忽略 */ }
    return wx;
  } finally {
    clearTimeout(timer);
  }
}

watchAuth(({ user, profile }) => {
  me = profile;
  if (!user || !profile) {
    $("authArea").innerHTML = "";
    $("adminLink").classList.add("hidden");
    document.querySelectorAll(".topbar nav button").forEach(btn => btn.classList.add("hidden"));
    navigate("login", {}, false);
    return;
  }
  document.querySelectorAll(".topbar nav button").forEach(btn => btn.classList.remove("hidden"));
  $("authArea").innerHTML = `
    <span class="who">${escapeHtml(profile.name || profile.email)}
      <span class="who-sub">${escapeHtml(profile.houseNumber || "")}</span></span>
    <button type="button" class="linklike" id="logoutBtn">登出</button>`;
  $("logoutBtn").addEventListener("click", async () => { await logout(); location.hash = ""; });
  // 後台入口只對有後台權限的人顯示，一般住戶看不到
  $("adminLink").classList.toggle("hidden", !canEnterAdmin(profile));

  navigate("home", {}, false);
  history.replaceState({ view: "home" }, "", "#");
  renderGreeting(profile);
  loadWeather();
  loadFacilities();
  loadNotices();
  renderSteps();
});

/* ============================================================
   公告
   ============================================================ */

async function loadNotices() {
  try {
    const snap = await getDocs(query(collection(db, "announcements"),
      where("published", "==", true), orderBy("date", "desc"), limit(5)));
    const list = snap.docs.map((d) => d.data());
    if (!list.length) { $("noticeSection").classList.add("hidden"); return; }
    $("noticeSection").classList.remove("hidden");
    $("noticeList").innerHTML = list.map((n) => `
      <div class="notice-row">
        <span class="badge ${["seal", "gold", "jade", "neutral"].includes(n.tone) ? n.tone : "neutral"}">${escapeHtml(n.tag || "公告")}</span>
        <span class="body">${escapeHtml(n.text)}</span>
        <span class="date">${escapeHtml((n.date || "").replace(/-/g, "/"))}</span>
      </div>`).join("");
  } catch {
    $("noticeSection").classList.add("hidden");
  }
}

/* ============================================================
   場地一覽
   ============================================================ */

async function loadFacilities() {
  const grid = $("facilityGrid");
  grid.innerHTML = Array.from({ length: 6 }, () =>
    `<div class="facility-card skeleton" aria-hidden="true"><div class="facility-body">
      <div class="sk-line sk-title"></div><div class="sk-line"></div></div></div>`).join("");
  try {
    const snap = await getDocs(collection(db, "facilities"));
    facilities = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    if (!facilities.length) { grid.innerHTML = `<p class="empty">目前尚未設定任何場地，請聯繫物業。</p>`; return; }

    await Promise.all(facilities.map(async (f) => {
      blockedCache.set(f.id, f.status === "closed" ? null : await fetchBlockedReason(f.id));
    }));

    grid.innerHTML = facilities.map(facilityCard).join("");
    facilities.forEach((f) => {
      const el = $(`fac-${f.id}`);
      if (el && !el.disabled) el.addEventListener("click", () => startBooking(f.id));
    });
  } catch (err) {
    grid.innerHTML = `<div class="alert error" role="alert">場地載入失敗：${escapeHtml(friendlyError(err))}</div>`;
  }
}

async function fetchBlockedReason(facilityId) {
  const snap = await getDocs(query(collection(db, "facilities", facilityId, "equipment"),
    where("essential", "==", true), where("status", "==", "maintenance")));
  return snap.empty ? null : snap.docs.map((d) => d.data().name).join("、");
}

function facilityCard(f) {
  const blocked = blockedCache.get(f.id);
  const closed = f.status === "closed";
  const disabled = closed || !!blocked;
  const note = closed ? `<span class="badge seal">暫停開放</span>`
    : blocked ? `<span class="badge seal">設備保養</span>` : "";

  return `
    <button type="button" class="facility-card ${f.featured ? "featured" : ""}" id="fac-${escapeHtml(f.id)}" ${disabled ? "disabled" : ""}>
      <span class="facility-body">
        <span class="facility-title-row">
          <span class="facility-title">${escapeHtml(f.name)}</span>
          <span class="badge ${f.featured ? "gold" : "neutral"}">${f.capacity ? `${f.capacity} 人` : "不限"}</span>
        </span>
        <span class="facility-desc">${escapeHtml(f.description || "")}</span>
        <span class="facility-foot">
          <span>08:00 – 22:00 · 每時段 2 小時</span>
          ${disabled ? note : `<span class="go">預約 →</span>`}
        </span>
      </span>
    </button>`;
}

/* ============================================================
   預約流程（四步驟）
   ============================================================ */

const STEP_LABELS = ["選擇場地", "選擇時段", "填寫資料", "完成"];
let step = 1;
let picked = { facility: null, date: null, slot: null };
let weekStart = weekStartOf(todayStr());
let slotTemplates = [];

function renderSteps() {
  $("stepBar").innerHTML = STEP_LABELS.map((lbl, i) => {
    const n = i + 1;
    const cls = n < step ? "done" : n === step ? "active" : "";
    return `${i ? `<span class="step-line"></span>` : ""}
      <span class="step ${cls}"><span class="dot">${n < step ? "✓" : n}</span><span class="lbl">${lbl}</span></span>`;
  }).join("");
}

function startBooking(facilityId) {
  picked = { facility: facilities.find((f) => f.id === facilityId), date: null, slot: null };
  weekStart = weekStartOf(todayStr());
  step = 2;
  navigate("booking", { step: 2 });
  renderSteps();
  renderSlotPicker();
}

async function renderSlotPicker() {
  const f = picked.facility;
  const body = $("bookingBody");
  body.innerHTML = `<div class="card"><p class="loading">載入時段中…</p></div>`;
  try {
    if (slotTemplates.facilityId !== f.id) {
      const snap = await getDocs(collection(db, "facilities", f.id, "timeSlotTemplates"));
      slotTemplates = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      slotTemplates.facilityId = f.id;
    }

    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const lockSnap = await getDocs(query(collection(db, "slotLocks"),
      where("facilityId", "==", f.id), where("date", "in", days)));
    const taken = new Set(lockSnap.docs
      .filter((d) => ["confirmed", "pending_review"].includes(d.data().status))
      .map((d) => `${d.data().date}__${d.data().slotId}`));

    const blocked = blockedCache.get(f.id);
    const today = todayStr();
    const maxDate = addDays(today, COMMUNITY.bookingWindowDays);
    const nowHM = new Date().toTimeString().slice(0, 5);

    const cells = [`<div></div>`];
    days.forEach((d) => {
      const [, m, dd] = d.split("-");
      cells.push(`<div class="cal-daylabel ${d === today ? "today" : ""}">${WEEKDAY_LABEL[isoWeekday(d) - 1]}
        <strong>${Number(m)}/${Number(dd)}</strong></div>`);
    });

    slotTemplates.forEach((t) => {
      cells.push(`<div class="cal-timelabel">${fmtSlot(t)}</div>`);
      days.forEach((d) => {
        const open = (t.weekdays || []).includes(isoWeekday(d));
        const isPast = d < today || (d === today && t.endTime <= nowHM);
        const outOfWindow = d > maxDate;
        const isTaken = taken.has(`${d}__${t.id}`);
        const isSel = picked.date === d && picked.slot?.id === t.id;

        let cls = "cal-cell", label = "可預約", dis = "";
        if (!open || isPast || outOfWindow) { cls += " past"; label = "—"; dis = "disabled"; }
        else if (blocked) { cls += " blocked"; label = "保養"; dis = "disabled"; }
        else if (isTaken) { cls += " taken"; label = "已預約"; dis = "disabled"; }
        else if (isSel) { cls += " selected"; label = "✓ 已選"; }

        cells.push(`<button type="button" class="${cls}" ${dis}
          data-date="${d}" data-slot="${escapeHtml(t.id)}"
          aria-label="${fmtDateHuman(d)} ${fmtSlot(t)} ${label}">${label}</button>`);
      });
    });

    const canPrev = weekStart > weekStartOf(today);
    const canNext = weekStart < weekStartOf(maxDate);

    body.innerHTML = `
      <div class="row" style="align-items:stretch">
        <div style="flex:0 1 280px">
          <div class="card">
            <h3 style="font-size:var(--text-xl);margin-bottom:4px">${escapeHtml(f.name)}</h3>
            <p class="sub-text" style="margin:0 0 16px">${f.capacity ? `容納 ${f.capacity} 人` : "人數不限"}${f.description ? " · " + escapeHtml(f.description) : ""}</p>
            <div class="spec-list">
              <div><span class="k">開放時間</span><span class="v">08:00 – 22:00</span></div>
              <div><span class="k">每時段</span><span class="v">2 小時</span></div>
              <div><span class="k">同時段限制</span><span class="v">每戶一項設施</span></div>
            </div>
            <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border-hairline)">
              <button type="button" class="btn ghost sm" id="changeFacility">← 更換場地</button>
            </div>
          </div>
        </div>
        <div style="flex:1 1 460px">
          <div class="card">
            <div class="cal-head">
              <div class="cal-title">
                <h3 style="margin:0">選擇日期與時段</h3>
                <span class="cal-range">${fmtDateFull(weekStart).slice(0, 10)} – ${fmtDateFull(addDays(weekStart, 6)).slice(0, 10)}</span>
              </div>
              <div class="cal-nav">
                <button type="button" class="btn secondary sm" id="prevWeek" ${canPrev ? "" : "disabled"}>‹ 上一週</button>
                <button type="button" class="btn secondary sm" id="nextWeek" ${canNext ? "" : "disabled"}>下一週 ›</button>
              </div>
            </div>
            ${blocked ? `<div class="alert warn">「${escapeHtml(blocked)}」維修中，此場地暫停開放預約。</div>` : ""}
            <div class="cal-scroll"><div class="cal-grid">${cells.join("")}</div></div>
            <div class="cal-legend">
              <span><span class="swatch free"></span>可預約</span>
              <span><span class="swatch sel"></span>已選擇</span>
              <span><span class="swatch taken"></span>已預約</span>
              <span><span class="swatch blocked"></span>暫停開放</span>
            </div>
            <div class="cal-foot">
              <div class="picked" id="pickedLabel">${picked.slot
                ? `已選擇：<strong>${escapeHtml(f.name)} · ${fmtDateHuman(picked.date)} ${fmtSlot(picked.slot)}</strong>`
                : "請點選一個可預約的時段"}</div>
              <button type="button" class="btn primary" id="toStep3" ${picked.slot ? "" : "disabled"}>下一步：填寫資料 →</button>
            </div>
          </div>
        </div>
      </div>`;

    $("changeFacility").addEventListener("click", () => history.back());
    $("prevWeek").addEventListener("click", () => { weekStart = addDays(weekStart, -7); renderSlotPicker(); });
    $("nextWeek").addEventListener("click", () => { weekStart = addDays(weekStart, 7); renderSlotPicker(); });
    $("toStep3").addEventListener("click", () => {
      step = 3; navigate("booking", { step: 3 }); renderSteps(); renderForm();
    });

    body.querySelectorAll(".cal-cell:not([disabled])").forEach((btn) => {
      btn.addEventListener("click", () => {
        picked.date = btn.dataset.date;
        picked.slot = slotTemplates.find((t) => t.id === btn.dataset.slot);
        body.querySelectorAll(".cal-cell.selected").forEach((b) => { b.classList.remove("selected"); b.textContent = "可預約"; });
        btn.classList.add("selected");
        btn.textContent = "✓ 已選";
        $("pickedLabel").innerHTML = `已選擇：<strong>${escapeHtml(f.name)} · ${fmtDateHuman(picked.date)} ${fmtSlot(picked.slot)}</strong>`;
        $("toStep3").disabled = false;
      });
    });
  } catch (err) {
    body.innerHTML = `<div class="card"><div class="alert error" role="alert">${escapeHtml(friendlyError(err))}</div></div>`;
  }
}

/* ---------- 步驟 3：確認資料 ---------- */

function renderForm() {
  const f = picked.facility;
  // 姓名／門牌／電話直接取自登入帳號，住戶不需重打，也無法冒名預約
  $("bookingBody").innerHTML = `
    <div class="row" style="align-items:stretch;max-width:860px;margin:0 auto">
      <div class="card" style="flex:1 1 380px">
        <h3>確認預約資料</h3>
        <p class="sub-text" style="margin:0 0 16px">以下資料取自您的帳號，如需更正請洽物業管理中心。</p>
        <div class="spec-list">
          <div><span class="k">門牌號碼</span><span class="v">${escapeHtml(me.houseNumber || "—")}</span></div>
          <div><span class="k">住戶姓名</span><span class="v">${escapeHtml(me.name || "—")}</span></div>
          <div><span class="k">聯絡電話</span><span class="v">${escapeHtml(me.phone || "—")}</span></div>
        </div>
        <div class="check-row" style="margin-top:20px">
          <input type="checkbox" id="agreeRules">
          <label for="agreeRules">我已閱讀並同意預約規則：每時段 2 小時、同一時段每戶限預約一項設施、使用後恢復場地原狀。</label>
        </div>
        <div id="bookAlert" role="alert" aria-live="assertive"></div>
        <div style="display:flex;justify-content:space-between;gap:12px;margin-top:24px;padding-top:20px;border-top:1px solid var(--border-hairline)">
          <button type="button" class="btn ghost" id="backTo2">← 上一步</button>
          <button type="button" class="btn primary" id="submitBooking">送出預約</button>
        </div>
      </div>
      <div class="card ruled" style="flex:0 1 320px;align-self:flex-start">
        <div class="code-label">預約摘要</div>
        <div class="spec-list">
          <div><span class="k">場地</span><span class="v">${escapeHtml(f.name)}</span></div>
          <div><span class="k">日期</span><span class="v">${fmtDateFull(picked.date)}</span></div>
          <div><span class="k">時段</span><span class="v">${fmtSlot(picked.slot)}</span></div>
          <div><span class="k">容納人數</span><span class="v">${f.capacity ? `${f.capacity} 人` : "不限"}</span></div>
        </div>
      </div>
    </div>`;

  $("backTo2").addEventListener("click", () => history.back());
  $("submitBooking").addEventListener("click", submitBooking);
}

async function submitBooking() {
  const f = picked.facility;
  const box = $("bookAlert");
  box.innerHTML = "";
  if (!$("agreeRules").checked) {
    box.innerHTML = `<div class="alert error">請先閱讀並同意預約規則</div>`;
    return $("agreeRules").focus();
  }
  if (!me.houseNumber) {
    box.innerHTML = `<div class="alert error">您的帳號尚未設定門牌號碼，請洽物業管理中心。</div>`;
    return;
  }

  const date = picked.date, slot = picked.slot;
  if (date > addDays(todayStr(), COMMUNITY.bookingWindowDays)) {
    box.innerHTML = `<div class="alert error">${escapeHtml(friendlyError({ message: "OUT_OF_WINDOW" }))}</div>`;
    return;
  }

  const btn = $("submitBooking");
  btn.disabled = true; btn.textContent = "送出中…";

  const uid = me.uid;
  const lockRef = doc(db, "slotLocks", slotLockId(f.id, date, slot.id));
  const holdRef = doc(db, "unitSlotHolds", `${uid}__${date}__${slot.startTime}`);
  const dailyRef = doc(db, "unitDailyUsage", `${f.id}__${uid}__${date}`);
  const weeklyRef = doc(db, "unitWeeklyUsage", `${f.id}__${uid}__${weekStartOf(date)}`);

  try {
    const result = await runTransaction(db, async (tx) => {
      const fSnap = await tx.get(doc(db, "facilities", f.id));
      if (!fSnap.exists() || fSnap.data().status === "closed") throw new Error("FACILITY_CLOSED");
      const fd = fSnap.data();

      const lockSnap = await tx.get(lockRef);
      if (lockSnap.exists() && ["confirmed", "pending_review"].includes(lockSnap.data().status)) {
        throw new Error("SLOT_TAKEN");
      }

      // 「同一時段每戶限一項設施」：以帳號為主鍵的佔位文件跨場地把關。
      // 住戶登入後帳號無法偽造，這條限制才真正擋得住。
      const holdSnap = await tx.get(holdRef);
      if (holdSnap.exists()) {
        throw new Error(holdSnap.data().facilityId === f.id ? "SLOT_TAKEN" : "SAME_SLOT_OTHER_FACILITY");
      }

      const dailySnap = fd.dailyLimitPerUnit ? await tx.get(dailyRef) : null;
      const weeklySnap = fd.weeklyLimitPerUnit ? await tx.get(weeklyRef) : null;
      const dailyCount = dailySnap?.exists() ? dailySnap.data().count : 0;
      const weeklyCount = weeklySnap?.exists() ? weeklySnap.data().count : 0;
      if (fd.dailyLimitPerUnit && dailyCount >= fd.dailyLimitPerUnit) throw new Error("DAILY_LIMIT");
      if (fd.weeklyLimitPerUnit && weeklyCount >= fd.weeklyLimitPerUnit) throw new Error("WEEKLY_LIMIT");

      const status = fd.bookingMode === "review" ? "pending_review" : "confirmed";
      const code = generateQueryCode();

      tx.set(doc(db, "bookings", code), {
        uid, facilityId: f.id, facilityName: fd.name, date,
        slotId: slot.id, startTime: slot.startTime, endTime: slot.endTime,
        slotLabel: fmtSlot(slot), applicantName: me.name || "", houseNumber: me.houseNumber,
        phone: me.phone || "", status, createdAt: serverTimestamp(), cancelledAt: null,
      });
      tx.set(lockRef, { facilityId: f.id, date, slotId: slot.id, status, bookingId: code, createdAt: serverTimestamp() });
      tx.set(holdRef, { uid, facilityId: f.id, date, startTime: slot.startTime, bookingId: code });
      if (fd.dailyLimitPerUnit) {
        tx.set(dailyRef, { count: dailyCount + 1, facilityId: f.id, uid, date });
      }
      if (fd.weeklyLimitPerUnit) {
        tx.set(weeklyRef, { count: weeklyCount + 1, facilityId: f.id, uid, date: weekStartOf(date) });
      }

      return { code, status };
    });

    writeLog("booking", result.code, "create", {
      場地: f.name, 日期: date, 時段: fmtSlot(slot), 門牌: me.houseNumber,
    }).catch(() => {});

    step = 4;
    navigate("booking", { step: 4 });
    renderSteps();
    renderDone(result);
  } catch (err) {
    btn.disabled = false; btn.textContent = "送出預約";
    box.innerHTML = `<div class="alert error">${escapeHtml(friendlyError(err))}</div>`;
    if (err.message === "SLOT_TAKEN") {
      setTimeout(() => { step = 2; picked.slot = null; renderSteps(); renderSlotPicker(); }, 1600);
    }
  }
}

function renderDone({ code, status }) {
  const f = picked.facility;
  $("bookingBody").innerHTML = `
    <div class="done-wrap">
      <div class="done-icon" aria-hidden="true">✓</div>
      <h2>${status === "pending_review" ? "已送出，待物業審核" : "預約已成立"}</h2>
      <p class="sub">預約明細已存入「我的預約」，可隨時查詢或取消。</p>
      <div class="card ruled" style="text-align:left">
        <div style="text-align:center;margin-bottom:24px">
          <div class="code-label">預約查詢碼</div>
          <div class="query-code" id="codeText">${escapeHtml(code)}</div>
          <div style="margin-top:14px"><button type="button" class="btn secondary sm" id="copyCode">複製查詢碼</button></div>
          <div id="copyResult" aria-live="polite"></div>
        </div>
        <div class="done-detail">
          <div><span class="k">場地</span><span class="v">${escapeHtml(f.name)}</span></div>
          <div><span class="k">日期</span><span class="v">${fmtDateFull(picked.date)}</span></div>
          <div><span class="k">時段</span><span class="v">${fmtSlot(picked.slot)}</span></div>
          <div><span class="k">門牌</span><span class="v">${escapeHtml(me.houseNumber)}</span></div>
        </div>
      </div>
      ${status === "pending_review" ? `<div class="alert warn">此場地需物業審核，審核通過後才算確定。</div>` : ""}
      <div style="display:flex;gap:12px;justify-content:center;margin-top:24px;flex-wrap:wrap">
        <button type="button" class="btn secondary" id="mineBtn">我的預約</button>
        <button type="button" class="btn ghost" id="homeBtn">回首頁</button>
      </div>
    </div>`;

  $("copyCode").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      $("copyResult").innerHTML = `<div class="alert ok">已複製到剪貼簿</div>`;
    } catch {
      const r = document.createRange();
      r.selectNodeContents($("codeText"));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      $("copyResult").innerHTML = `<div class="alert warn">請長按上方已選取的文字複製</div>`;
    }
  });
  $("mineBtn").addEventListener("click", () => { navigate("mine"); loadMine(); });
  $("homeBtn").addEventListener("click", () => { navigate("home"); loadFacilities(); });
}

/* ============================================================
   我的預約
   ============================================================ */

async function loadMine() {
  const box = $("mineBody");
  box.innerHTML = `<div class="card"><p class="loading">載入中…</p></div>`;
  if (!me) {
    navigate("login");
    return;
  }
  try {
    const snap = await getDocs(query(collection(db, "bookings"),
      where("uid", "==", me.uid), orderBy("date", "desc"), limit(50)));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!list.length) {
      box.innerHTML = `<div class="card"><p class="empty">您目前沒有任何預約紀錄。</p>
        <button type="button" class="btn primary" data-goto="facilities">立即預約場地</button></div>`;
      box.querySelector("[data-goto]").addEventListener("click", () => {
        navigate("home");
        setTimeout(() => $("facilities").scrollIntoView({ behavior: "smooth" }), 60);
      });
      return;
    }

    const today = todayStr();
    box.innerHTML = list.map((b) => {
      const canCancel = ["confirmed", "pending_review"].includes(b.status) && b.date >= today;
      return `<div class="card ${canCancel ? "ruled" : ""}">
        <div class="result-head">
          <h3 style="margin:0">${escapeHtml(b.facilityName)}</h3>
          <span class="badge ${b.status}">${fmtStatus(b.status)}</span>
        </div>
        <div class="spec-list">
          <div><span class="k">日期／時段</span><span class="v">${fmtDateFull(b.date)} ${escapeHtml(b.slotLabel || "")}</span></div>
          <div><span class="k">查詢碼</span><span class="v mono">${escapeHtml(b.id)}</span></div>
          <div><span class="k">門牌</span><span class="v">${escapeHtml(b.houseNumber)}</span></div>
        </div>
        ${canCancel ? `<button type="button" class="btn danger" data-cancel="${escapeHtml(b.id)}" style="margin-top:16px">取消此預約</button>` : ""}
      </div>`;
    }).join("");

    list.forEach((b) => {
      box.querySelector(`[data-cancel="${b.id}"]`)?.addEventListener("click", () => doCancel(b.id, b));
    });
  } catch (err) {
    box.innerHTML = `<div class="card"><div class="alert error" role="alert">${escapeHtml(friendlyError(err))}</div></div>`;
  }
}

async function doCancel(code, b) {
  if (!confirm("確定要取消此預約嗎？取消後這個時段會立即開放給其他住戶。")) return;
  const bookingRef = doc(db, "bookings", code);
  const lockRef = doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId));
  const holdRef = doc(db, "unitSlotHolds", `${me.uid}__${b.date}__${b.startTime}`);
  const dailyRef = doc(db, "unitDailyUsage", `${b.facilityId}__${me.uid}__${b.date}`);
  const weeklyRef = doc(db, "unitWeeklyUsage", `${b.facilityId}__${me.uid}__${weekStartOf(b.date)}`);

  try {
    await runTransaction(db, async (tx) => {
      // 讀取操作（必須放在所有寫入之前）
      const bkSnap = await tx.get(bookingRef);
      const dailySnap = await tx.get(dailyRef);
      const weeklySnap = await tx.get(weeklyRef);

      if (!bkSnap.exists()) throw new Error("not-found");
      if (bkSnap.data().status === "cancelled") return;

      // 寫入操作
      tx.update(bookingRef, { status: "cancelled", cancelledAt: serverTimestamp() });
      tx.set(lockRef, {
        facilityId: b.facilityId, date: b.date, slotId: b.slotId,
        status: "cancelled", bookingId: code, createdAt: serverTimestamp(),
      });
      tx.delete(holdRef);

      if (dailySnap.exists() && dailySnap.data().count > 0) {
        tx.set(dailyRef, { count: dailySnap.data().count - 1, facilityId: b.facilityId, uid: me.uid, date: b.date });
      }
      if (weeklySnap.exists() && weeklySnap.data().count > 0) {
        tx.set(weeklyRef, { count: weeklySnap.data().count - 1, facilityId: b.facilityId, uid: me.uid, date: weekStartOf(b.date) });
      }
    });

    writeLog("booking", code, "cancel", { 場地: b.facilityName, 日期: b.date, 時段: b.slotLabel }).catch(() => {});
    loadMine();
  } catch (err) {
    alert(friendlyError(err));
  }
}
