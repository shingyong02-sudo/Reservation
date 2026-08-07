import { db, auth } from "./firebase-config.js?v=20260807d";
import {
  doc, getDoc, setDoc, collection, addDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { describeDevice, fetchClientIp, isStaffRole } from "./shared.js?v=20260807d";

/* 目前登入者的個人檔（users/{uid}），登入後填入 */
export let profile = null;

export function currentUid() { return auth.currentUser?.uid || null; }

/**
 * 監看登入狀態，並在登入時一併載入 users/{uid} 的角色資料。
 * 回呼會拿到 { user, profile }；未登入或查無個人檔時 profile 為 null。
 */
export function watchAuth(cb) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { profile = null; cb({ user: null, profile: null }); return; }
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      profile = snap.exists() ? { uid: user.uid, email: user.email, ...snap.data() } : null;
    } catch {
      profile = null;
    }
    cb({ user, profile });
  });
}

/** 登入並寫一筆登入軌跡（含 IP 與載具） */
export async function login(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  // 先確認個人檔存在，才有角色可判斷
  const snap = await getDoc(doc(db, "users", cred.user.uid));
  if (!snap.exists()) {
    await signOut(auth);
    throw new Error("NO_PROFILE");
  }
  const data = snap.data();
  if (data.disabled) {
    await signOut(auth);
    throw new Error("ACCOUNT_DISABLED");
  }
  profile = { uid: cred.user.uid, email: cred.user.email, ...data };
  // 稽核紀錄寫失敗（例如 IP 查詢逾時）不該讓人登不進系統，因此不 await、也吞掉錯誤
  writeLog("account", cred.user.uid, "login", { 角色: data.role }).catch(() => {});
  return profile;
}

export async function logout() {
  const uid = currentUid();
  if (uid) await writeLog("account", uid, "logout", {}).catch(() => {});
  profile = null;
  await signOut(auth);
}

/** 首次登入若沒有個人檔，可由本人補建（角色固定為一般住戶） */
export async function ensureProfile(user, { name, houseNumber, phone }) {
  await setDoc(doc(db, "users", user.uid), {
    email: user.email, name, houseNumber, phone,
    role: "resident", disabled: false,
    createdAt: serverTimestamp(),
  });
}

/**
 * 寫一筆操作紀錄。每筆都帶上操作帳號、IP 與載具，
 * 讓後台的「操作紀錄」能完整回溯是誰、在哪、用什麼裝置做的。
 */
export async function writeLog(targetType, targetId, action, detail = {}) {
  const ip = await fetchClientIp();
  return addDoc(collection(db, "bookingLogs"), {
    targetType, targetId, action,
    actorUid: currentUid(),
    actorEmail: auth.currentUser?.email || "",
    actorName: profile?.name || "",
    actorRole: profile?.role || "",
    ip,
    device: describeDevice(),
    userAgent: navigator.userAgent.slice(0, 300),
    detail,
    timestamp: serverTimestamp(),
  });
}

export const canEnterAdmin = (p) => !!p && !p.disabled && isStaffRole(p.role);
