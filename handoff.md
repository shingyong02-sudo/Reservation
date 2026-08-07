# 交接檔（handoff.md）

> 任何 Agent、任何電腦接手前**必讀**；收工時**必更新**。本檔只放交接必需的精簡資訊，詳細脈絡放 Obsidian（若有 L3）。

## ⏯️ 目前做到哪

系統已上線並可運作：**https://reservation-98067.web.app**（後台 `/admin`）。社區名稱 **聯懋超綻**。

### 設計
已套用 Claude Design 茶館風設計稿（專案 `5d7d41d9-41a1-4437-9c91-340231fadca0`，設計系統「黃三郎 Tea House」）：暖紙感底、茶金主色、印泥朱紅、印章品牌標記、明體標題。

### 營運規則（依設計稿）
- 時段：**08:00–22:00 每 2 小時共 7 段**
- 預約流程：四步驟精靈（選場地 → 週曆選時段 → 確認資料 → 完成）
- **同一時段每戶限預約一項設施**（跨場地，靠 `unitSlotHolds` 佔位文件）
- 開放預約範圍 **14 天內**
- 查詢碼格式 **YX-8F2K6**，輸入時自動正規化（小寫、漏連字號都可查）

### 帳號與權限（最後一批需求）
- **住戶需登入才能預約**；姓名/門牌/電話取自帳號，無法冒名預約
- 三種角色：**系統管理員（最高權限）／後台管理員／一般住戶**
  - 系統管理員：後台七個功能全開，含帳號管理
  - 後台管理員：除帳號管理外六項
  - 一般住戶：完全進不了後台，首頁也看不到後台入口
- 後台「帳號管理」可建立帳號、改角色、停用/啟用、寄密碼重設信
- 操作紀錄：**全繁體中文、每 10 筆一頁**，記錄操作帳號、角色、動作、內容、**IP**、**使用載具**
- 場地可新增／修改／刪除；新增場地自動帶入 7 個時段
- 已移除場地照片；瀏覽器上一頁可退回上一個畫面（History API）

## 🚦 目前狀態
- 住戶端流程已在 production 完整驗證（含跨場地同時段規則實測擋下）
- 未登入滲透測試 8 項全數擋下，含「未登入自建管理員帳號」
- **後台登入後的功能仍未由 Agent 實測**——安全規則不允許 Agent 輸入密碼，需使用者自行點測
- 系統管理員帳號：`jnfakimo@gmail.com`（uid `9WAjh6E4OUebjWggHd2gwujBzd33`）

## ➡️ 下一步（使用者最後提出、尚未實作）
**在登入頁增加「忘記密碼」自助重設功能。**
- 現況：後台帳號管理已有「寄重設信」按鈕，但**只有系統管理員能觸發**；
  住戶端與後台的登入頁**沒有**自助的「忘記密碼」連結。
- 作法：在 `index.html` 與 `admin.html` 的登入卡片加一個「忘記密碼？」連結，
  呼叫 `sendPasswordResetEmail(auth, email)`（Firebase Auth 內建，不需 Cloud Functions）。
  注意：無論該 Email 是否存在都要回報相同訊息，避免被用來探測有效帳號。
- 另需在 Firebase Console → Authentication → Templates 確認密碼重設信的
  寄件者與中文內容。

其他待辦：
- 補場地實景照片（目前已移除照片區塊，要加回需改版面）
- LINE 通知（設計稿標為示意；需社區的 LINE 官方帳號與 Messaging API）
- 考慮把 GitHub repo 由 Public 改為 Private

## ⚠️ 注意事項
- 專案資料夾在 Google 雲端硬碟（`G:\我的雲端硬碟\AI\Reservation`），換電腦前確認同步完成
- Firebase 專案 `reservation-98067`（Firestore 位於 asia-east1），
  shingyong02@gmail.com 擁有，jnfakimo 為協作擁有者
- **改完 JS 一定要更新版本參數**：所有模組網址帶 `?v=YYYYMMDDx`（目前 `20260806d`），
  HTML、內部相對 import、style.css 都要一起改，否則會出現
  「新 HTML 配舊 JS」的混搭（曾因此讓帳號管理按鈕點了沒反應）
- 社區名稱與電話集中在 `public/js/shared.js` 的 `COMMUNITY`；
  HTML 裡的 `.contact-phone` 會被 JS 覆寫，只改 HTML 無效
- 公告、後台預約篩選、我的預約都需要複合索引，已寫進 `firestore.indexes.json`
- IP 由 `api.ipify.org` 取得（瀏覽器拿不到自己的連線 IP），查不到記為「未知」
- billing 未啟用（Spark 方案），架構刻意不依賴 Cloud Functions
- 本地測試：背景執行 `python -m http.server 8899`（cwd 為 `public/`），
  再用 `.claude/launch.json` 的 `reservation` 設定 attach

## 🕐 最後更新
- 時間：2026-08-06 收工
- 更新者：Claude Code @ DESKTOP-0CFB6UK
- Git push：✅ 已推
