import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  runTransaction, addDoc, updateDoc, setDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  COMMUNITY, generateQueryCode, normalizeCode, todayStr, addDays, dateToStr, parseDate,
  isoWeekday, weekStartOf, slotLockId, escapeHtml, fmtStatus, fmtDateHuman, fmtDateFull,
  fmtSlot, friendlyError, WEEKDAY_LABEL,
} from "./shared.js";

const $ = (id) => document.getElementById(id);

/* ============================================================
   檢視切換
   ============================================================ */

const VIEWS = { home: "viewHome", booking: "viewBooking", lookup: "viewLookup" };

function showView(name) {
  Object.entries(VIEWS).forEach(([k, id]) => $(id).classList.toggle("hidden", k !== name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-goto]").forEach((el) => {
  el.addEventListener("click", () => {
    showView("home");
    setTimeout(() => $(el.dataset.goto)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  });
});
$("navLookup").addEventListener("click", () => showView("lookup"));
$("heroLookup").addEventListener("click", () => showView("lookup"));
$("brandLink").addEventListener("click", (e) => { e.preventDefault(); showView("home"); });

// 聯絡電話集中在 shared.js 設定，避免散落在各處難以更新
document.querySelectorAll(".contact-phone").forEach((el) => { el.textContent = COMMUNITY.phone; });
$("specWindow").textContent = `${COMMUNITY.bookingWindowDays} 天內`;

/* ============================================================
   公告
   ============================================================ */

async function loadNotices() {
  const box = $("noticeList");
  try {
    const snap = await getDocs(query(collection(db, "announcements"),
      where("published", "==", true), orderBy("date", "desc"), limit(5)));
    const list = snap.docs.map((d) => d.data());
    if (list.length === 0) {
      $("noticeSection").classList.add("hidden");
      return;
    }
    box.innerHTML = list.map((n) => `
      <div class="notice-row">
        <span class="badge ${["seal", "gold", "jade", "neutral"].includes(n.tone) ? n.tone : "neutral"}">${escapeHtml(n.tag || "公告")}</span>
        <span class="body">${escapeHtml(n.text)}</span>
        <span class="date">${escapeHtml((n.date || "").replace(/-/g, "/"))}</span>
      </div>`).join("");
  } catch (err) {
    // 公告載入失敗不該擋住預約主流程，只安靜地把整區收起來
    $("noticeSection").classList.add("hidden");
  }
}

/* ============================================================
   場地一覽
   ============================================================ */

const facilityGrid = $("facilityGrid");
let facilities = [];
const blockedCache = new Map(); // facilityId → 故障中的必要設備名稱，或 null

async function loadFacilities() {
  facilityGrid.innerHTML = Array.from({ length: 6 }, () =>
    `<div class="facility-card skeleton" aria-hidden="true"><div class="sk-photo"></div>
     <div class="facility-body"><div class="sk-line sk-title"></div><div class="sk-line"></div></div></div>`).join("");

  try {
    const snap = await getDocs(collection(db, "facilities"));
    facilities = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

    if (facilities.length === 0) {
      facilityGrid.innerHTML = `<p class="empty">目前尚未設定任何場地，請聯繫物業。</p>`;
      return;
    }

    // 各場地的必要設備狀態平行查詢一次並快取，後續進入預約流程時不再重查
    await Promise.all(facilities.map(async (f) => {
      blockedCache.set(f.id, f.status === "closed" ? null : await fetchBlockedReason(f.id));
    }));

    facilityGrid.innerHTML = facilities.map(facilityCard).join("");
    facilities.forEach((f) => {
      const el = $(`fac-${f.id}`);
      if (el && !el.disabled) el.addEventListener("click", () => startBooking(f.id));
    });
  } catch (err) {
    facilityGrid.innerHTML = `<div class="alert error" role="alert">場地載入失敗：${escapeHtml(friendlyError(err))}</div>`;
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

  let badge = `<span class="badge ${f.featured ? "gold" : "neutral"}">${f.capacity ? `${f.capacity} 人` : "不限"}</span>`;
  let note = "";
  if (closed) note = `<span class="badge seal">暫停開放</span>`;
  else if (blocked) note = `<span class="badge seal">設備保養</span>`;

  return `
    <button type="button" class="facility-card ${f.featured ? "featured" : ""}" id="fac-${escapeHtml(f.id)}" ${disabled ? "disabled" : ""}>
      <span class="facility-photo">場地照片</span>
      <span class="facility-body">
        <span class="facility-title-row">
          <span class="facility-title">${escapeHtml(f.name)}</span>
          ${badge}
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
    const dot = n < step ? "✓" : String(n);
    return `${i ? `<span class="step-line"></span>` : ""}
      <span class="step ${cls}"><span class="dot">${dot}</span><span class="lbl">${lbl}</span></span>`;
  }).join("");
}

function startBooking(facilityId) {
  picked = { facility: facilities.find((f) => f.id === facilityId), date: null, slot: null };
  // 若今天所在的那一週已經過去大半，直接從本週開始顯示即可；使用者可自行往後翻
  weekStart = weekStartOf(todayStr());
  step = 2;
  showView("booking");
  renderSteps();
  renderSlotPicker();
}

/* ---------- 步驟 2：週曆選時段 ---------- */

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
    // 一次抓整週的時段鎖：facilityId 等值 + date in 七天，只有一個 in 條件，
    // Firestore 可用單欄索引合併處理，不需要另外建複合索引
    const lockSnap = await getDocs(query(collection(db, "slotLocks"),
      where("facilityId", "==", f.id), where("date", "in", days)));
    const taken = new Set(lockSnap.docs
      .filter((d) => ["confirmed", "pending_review"].includes(d.data().status))
      .map((d) => `${d.data().date}__${d.data().slotId}`));

    const blocked = blockedCache.get(f.id);
    const today = todayStr();
    const maxDate = addDays(today, COMMUNITY.bookingWindowDays);
    const nowHM = new Date().toTimeString().slice(0, 5);

    const cells = [];
    cells.push(`<div></div>`);
    days.forEach((d) => {
      const [, , dd] = d.split("-");
      const mm = Number(d.split("-")[1]);
      cells.push(`<div class="cal-daylabel ${d === today ? "today" : ""}">${WEEKDAY_LABEL[isoWeekday(d) - 1]}
        <strong>${mm}/${Number(dd)}</strong></div>`);
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
    const wkEnd = addDays(weekStart, 6);

    body.innerHTML = `
      <div class="row" style="align-items:stretch">
        <div style="flex:0 1 300px">
          <div class="card" style="padding:0;overflow:hidden">
            <div class="facility-photo" style="height:120px">場地照片</div>
            <div style="padding:20px">
              <h3 style="font-size:var(--text-xl);margin-bottom:4px">${escapeHtml(f.name)}</h3>
              <p class="sub-text" style="margin:0 0 16px">${f.capacity ? `容納 ${f.capacity} 人` : "人數不限"}${f.description ? " · " + escapeHtml(f.description) : ""}</p>
              <div class="spec-list">
                <div><span class="k">開放時間</span><span class="v">08:00 – 22:00</span></div>
                <div><span class="k">每時段</span><span class="v">2 小時</span></div>
                <div><span class="k">同時段限制</span><span class="v">每戶一項設施</span></div>
              </div>
              <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border-hairline)">
                <button type="button" class="btn ghost sm" id="changeFacility">更換場地 →</button>
              </div>
            </div>
          </div>
        </div>

        <div style="flex:1 1 460px">
          <div class="card">
            <div class="cal-head">
              <div class="cal-title">
                <h3 style="margin:0">選擇日期與時段</h3>
                <span class="cal-range">${fmtDateFull(weekStart).slice(0, 10)} – ${fmtDateFull(wkEnd).slice(0, 10)}</span>
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

    $("changeFacility").addEventListener("click", () => { step = 1; showView("home"); setTimeout(() => $("facilities").scrollIntoView({ behavior: "smooth" }), 60); });
    $("prevWeek").addEventListener("click", () => { weekStart = addDays(weekStart, -7); renderSlotPicker(); });
    $("nextWeek").addEventListener("click", () => { weekStart = addDays(weekStart, 7); renderSlotPicker(); });
    $("toStep3").addEventListener("click", () => { step = 3; renderSteps(); renderForm(); });

    body.querySelectorAll(".cal-cell:not([disabled])").forEach((btn) => {
      btn.addEventListener("click", () => {
        picked.date = btn.dataset.date;
        picked.slot = slotTemplates.find((t) => t.id === btn.dataset.slot);
        body.querySelectorAll(".cal-cell").forEach((b) => {
          if (b.classList.contains("selected")) { b.classList.remove("selected"); b.textContent = "可預約"; }
        });
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

/* ---------- 步驟 3：填寫資料 ---------- */

function renderForm() {
  const f = picked.facility;
  $("bookingBody").innerHTML = `
    <div class="row" style="align-items:stretch;max-width:860px;margin:0 auto">
      <div class="card" style="flex:1 1 380px">
        <h3>住戶資料</h3>
        <div class="field">
          <label for="houseNumber">門牌號碼</label>
          <input type="text" id="houseNumber" autocomplete="off" placeholder="例：A 棟 12 樓之 3">
          <span class="helper">請填寫完整棟別與樓層，取消預約時需比對</span>
        </div>
        <div class="field">
          <label for="applicantName">住戶姓名</label>
          <input type="text" id="applicantName" autocomplete="name" placeholder="請填寫本人姓名">
        </div>
        <div class="field">
          <label for="phone">聯絡電話</label>
          <input type="tel" id="phone" autocomplete="tel" inputmode="tel" placeholder="09xx-xxx-xxx">
          <span class="helper">時段異動時物業將以此電話聯繫</span>
        </div>
        <div class="check-row">
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
        <p class="hint">送出後將產生查詢碼，請務必保存；查詢與取消預約皆須輸入查詢碼與門牌號碼。</p>
      </div>
    </div>`;

  $("backTo2").addEventListener("click", () => { step = 2; renderSteps(); renderSlotPicker(); });
  $("submitBooking").addEventListener("click", submitBooking);
  $("houseNumber").focus();
}

/* ---------- 送出 ---------- */

async function submitBooking() {
  const f = picked.facility;
  const houseNumber = $("houseNumber").value.trim();
  const applicantName = $("applicantName").value.trim();
  const phone = $("phone").value.trim();
  const agreed = $("agreeRules").checked;
  const box = $("bookAlert");
  box.innerHTML = "";

  const fail = (msg, focusId) => {
    box.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`;
    if (focusId) $(focusId).focus();
  };
  if (!houseNumber) return fail("請填寫門牌號碼", "houseNumber");
  if (!applicantName) return fail("請填寫住戶姓名", "applicantName");
  if (!phone) return fail("請填寫聯絡電話", "phone");
  if (!agreed) return fail("請先閱讀並同意預約規則", "agreeRules");

  const date = picked.date, slot = picked.slot;
  if (date > addDays(todayStr(), COMMUNITY.bookingWindowDays)) return fail(friendlyError({ message: "OUT_OF_WINDOW" }));

  const btn = $("submitBooking");
  btn.disabled = true;
  btn.textContent = "送出中…";

  const lockRef = doc(db, "slotLocks", slotLockId(f.id, date, slot.id));
  const holdRef = doc(db, "unitSlotHolds", `${houseNumber}__${date}__${slot.startTime}`);
  const dailyRef = doc(db, "unitDailyUsage", `${f.id}__${houseNumber}__${date}`);
  const weeklyRef = doc(db, "unitWeeklyUsage", `${f.id}__${houseNumber}__${weekStartOf(date)}`);

  try {
    const result = await runTransaction(db, async (tx) => {
      const fSnap = await tx.get(doc(db, "facilities", f.id));
      if (!fSnap.exists() || fSnap.data().status === "closed") throw new Error("FACILITY_CLOSED");
      const fd = fSnap.data();

      const lockSnap = await tx.get(lockRef);
      if (lockSnap.exists() && ["confirmed", "pending_review"].includes(lockSnap.data().status)) {
        throw new Error("SLOT_TAKEN");
      }

      // 「同一時段每戶限一項設施」：用一份以「門牌＋日期＋開始時間」為 id 的佔位文件
      // 來跨場地把關。Firestore 的 client transaction 不支援在交易內下查詢，
      // 而住戶端也不該有列出整個 bookings 集合的權限（那會洩漏其他住戶個資），
      // 因此改用這種單一文件的佔位法。
      const holdSnap = await tx.get(holdRef);
      if (holdSnap.exists() && holdSnap.data().facilityId !== f.id) {
        throw new Error("SAME_SLOT_OTHER_FACILITY");
      }
      if (holdSnap.exists() && holdSnap.data().facilityId === f.id) {
        throw new Error("SLOT_TAKEN");
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
        facilityId: f.id, facilityName: fd.name, date,
        slotId: slot.id, startTime: slot.startTime, endTime: slot.endTime,
        slotLabel: fmtSlot(slot), applicantName, houseNumber,
        phone, status, createdAt: serverTimestamp(), cancelledAt: null,
      });
      tx.set(lockRef, {
        facilityId: f.id, date, slotId: slot.id,
        status, bookingId: code, createdAt: serverTimestamp(),
      });
      tx.set(holdRef, { facilityId: f.id, date, startTime: slot.startTime, bookingId: code });
      if (fd.dailyLimitPerUnit) tx.set(dailyRef, { count: dailyCount + 1 });
      if (fd.weeklyLimitPerUnit) tx.set(weeklyRef, { count: weeklyCount + 1 });

      return { code, status };
    });

    addDoc(collection(db, "bookingLogs"), {
      targetType: "booking", targetId: result.code, action: "create", actor: "resident",
      detail: { facilityId: f.id, date, startTime: slot.startTime }, timestamp: serverTimestamp(),
    }).catch(() => {});

    step = 4;
    renderSteps();
    renderDone(result, { houseNumber });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "送出預約";
    box.innerHTML = `<div class="alert error">${escapeHtml(friendlyError(err))}</div>`;
    if (err.message === "SLOT_TAKEN") {
      // 時段剛被搶走：回到週曆讓住戶馬上看到最新狀態
      setTimeout(() => { step = 2; picked.slot = null; renderSteps(); renderSlotPicker(); }, 1600);
    }
  }
}

/* ---------- 步驟 4：完成 ---------- */

function renderDone({ code, status }, { houseNumber }) {
  const f = picked.facility;
  $("bookingBody").innerHTML = `
    <div class="done-wrap">
      <div class="done-icon" aria-hidden="true">✓</div>
      <h2>${status === "pending_review" ? "已送出，待物業審核" : "預約已成立"}</h2>
      <p class="sub">請保存下方查詢碼，查詢與取消預約時需要使用。</p>

      <div class="card ruled" style="text-align:left">
        <div style="text-align:center;margin-bottom:24px">
          <div class="code-label">您的查詢碼</div>
          <div class="query-code" id="codeText">${escapeHtml(code)}</div>
          <div style="margin-top:14px">
            <button type="button" class="btn secondary sm" id="copyCode">複製查詢碼</button>
          </div>
          <div id="copyResult" aria-live="polite"></div>
        </div>
        <div class="done-detail">
          <div><span class="k">場地</span><span class="v">${escapeHtml(f.name)}</span></div>
          <div><span class="k">日期</span><span class="v">${fmtDateFull(picked.date)}</span></div>
          <div><span class="k">時段</span><span class="v">${fmtSlot(picked.slot)}</span></div>
          <div><span class="k">門牌</span><span class="v">${escapeHtml(houseNumber)}</span></div>
        </div>
      </div>

      ${status === "pending_review" ? `<div class="alert warn">此場地需物業審核，審核通過後才算確定。</div>` : ""}

      <div style="display:flex;gap:12px;justify-content:center;margin-top:24px;flex-wrap:wrap">
        <button type="button" class="btn secondary" id="againBtn">再預約一筆</button>
        <button type="button" class="btn ghost" id="homeBtn">回首頁</button>
      </div>
    </div>`;

  $("copyCode").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      $("copyResult").innerHTML = `<div class="alert ok">已複製到剪貼簿</div>`;
    } catch {
      // iOS Safari 在部分情境會擋下剪貼簿，退而選取文字讓使用者自行長按複製
      const r = document.createRange();
      r.selectNodeContents($("codeText"));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      $("copyResult").innerHTML = `<div class="alert warn">請長按上方已選取的文字複製</div>`;
    }
  });
  $("againBtn").addEventListener("click", () => { step = 1; showView("home"); loadFacilities(); });
  $("homeBtn").addEventListener("click", () => { step = 1; showView("home"); loadFacilities(); });
}

/* ============================================================
   查詢 / 取消
   ============================================================ */

$("lookupBtn").addEventListener("click", doLookup);
["lookupCode", "lookupHouse"].forEach((id) =>
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doLookup(); }));

async function doLookup() {
  const code = normalizeCode($("lookupCode").value);
  const house = $("lookupHouse").value.trim();
  const out = $("lookupResult");
  const btn = $("lookupBtn");

  if (!code || !house) {
    out.innerHTML = `<div class="alert error">請輸入查詢碼與門牌號碼</div>`;
    return;
  }

  btn.disabled = true; btn.textContent = "查詢中…";
  out.innerHTML = "";
  try {
    const snap = await getDoc(doc(db, "bookings", code));
    // 查詢碼錯誤與門牌不符回報同一則訊息，避免被用來逐一試出哪些查詢碼有效
    if (!snap.exists() || snap.data().houseNumber !== house) {
      out.innerHTML = `<div class="card"><div class="alert error">查無符合的預約，請確認查詢碼與門牌號碼是否正確。</div></div>`;
      return;
    }
    const b = snap.data();
    const canCancel = ["confirmed", "pending_review"].includes(b.status) && b.date >= todayStr();

    out.innerHTML = `
      <div class="card ruled">
        <div class="result-head">
          <h3 style="margin:0">查詢結果</h3>
          <span class="badge ${b.status}">${fmtStatus(b.status)}</span>
        </div>
        <div class="spec-list">
          <div><span class="k">查詢碼</span><span class="v mono">${escapeHtml(code)}</span></div>
          <div><span class="k">場地</span><span class="v">${escapeHtml(b.facilityName)}</span></div>
          <div><span class="k">日期／時段</span><span class="v">${fmtDateFull(b.date)} ${escapeHtml(b.slotLabel || `${b.startTime} – ${b.endTime}`)}</span></div>
          <div><span class="k">門牌</span><span class="v">${escapeHtml(b.houseNumber)}</span></div>
          <div><span class="k">住戶姓名</span><span class="v">${escapeHtml(b.applicantName)}</span></div>
        </div>
        ${canCancel ? `<button type="button" class="btn danger block" id="cancelBtn" style="margin-top:20px">取消此預約</button>` : ""}
        <div id="cancelAlert" role="alert" aria-live="assertive"></div>
      </div>`;
    if (canCancel) $("cancelBtn").addEventListener("click", () => doCancel(code, b));
  } catch (err) {
    out.innerHTML = `<div class="card"><div class="alert error" role="alert">${escapeHtml(friendlyError(err))}</div></div>`;
  } finally {
    btn.disabled = false; btn.textContent = "查詢預約";
  }
}

async function doCancel(code, b) {
  if (!confirm("確定要取消此預約嗎？取消後這個時段會立即開放給其他住戶。")) return;
  const btn = $("cancelBtn");
  btn.disabled = true; btn.textContent = "取消中…";

  try {
    // 順序不可調換：安全規則要求「預約已是取消狀態」才允許釋出時段鎖與佔位
    await updateDoc(doc(db, "bookings", code), { status: "cancelled", cancelledAt: serverTimestamp() });

    await setDoc(doc(db, "slotLocks", slotLockId(b.facilityId, b.date, b.slotId)), {
      facilityId: b.facilityId, date: b.date, slotId: b.slotId,
      status: "cancelled", bookingId: code, createdAt: serverTimestamp(),
    }).catch(() => {});

    await deleteDoc(doc(db, "unitSlotHolds", `${b.houseNumber}__${b.date}__${b.startTime}`)).catch(() => {});
    await refundUsage(b).catch(() => {});

    addDoc(collection(db, "bookingLogs"), {
      targetType: "booking", targetId: code, action: "cancel", actor: "resident",
      detail: { facilityId: b.facilityId, date: b.date }, timestamp: serverTimestamp(),
    }).catch(() => {});

    $("lookupResult").innerHTML =
      `<div class="card"><div class="alert ok" role="status">已取消預約，該時段已重新開放預約。</div></div>`;
  } catch (err) {
    btn.disabled = false; btn.textContent = "取消此預約";
    $("cancelAlert").innerHTML = `<div class="alert error">${escapeHtml(friendlyError(err))}</div>`;
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

/* ============================================================ */

loadFacilities();
loadNotices();
renderSteps();
