# 交接檔（handoff.md）

> 任何 Agent、任何電腦接手前**必讀**；收工時**必更新**。本檔只放交接必需的精簡資訊，詳細脈絡放 Obsidian（若有 L3）。

## ⏯️ 目前做到哪
已從 `my-teaching-tools-87a6d` **遷移到杏永自己的 Firebase 專案 `reservation-98067`**（Firestore 位於 asia-east1）並完成部署：
- Firestore 資料庫、安全規則、6 個場地種子資料（含時段範本與示範設備）全部就緒
- 新 Web App 已註冊，`public/js/firebase-config.js` 已指向新專案
- 已部署 Hosting：https://reservation-98067.web.app
- 在新專案上已實測住戶端「預約→取得查詢碼→查詢」流程，成功（測試資料已清除）
- 物業後台程式碼完成，**Authentication 尚未開通、無管理員帳號，無法登入測試**

## 🚦 目前狀態
- 可運行：住戶端已在新專案驗證可用
- 未驗證：物業後台登入後的所有功能（場地/設備/時段 CRUD、預約審核、操作紀錄）
- GitHub repo `shingyong02-sudo/Reservation` 目前仍是 **Public**
- 舊專案 `my-teaching-tools-87a6d` 裡還留著先前的測試資料與 Hosting（未清除，如不需要可自行刪除）

## ➡️ 下一步
1. **使用者需在 Firebase Console 開通 Authentication 並建立管理員帳號**（我不經手密碼）：
   - https://console.firebase.google.com/project/reservation-98067/authentication/providers
   - 「開始使用」→ 啟用「電子郵件/密碼」→ 到 Users 分頁新增使用者
2. 建好後回報，由 Agent 用該帳號登入 `/admin` 實測後台全部功能並抓 bug
3. 已知限制待確認是否要修：住戶自行取消預約後，時段鎖不會自動釋出（需物業在後台按「釋出時段」）；同門牌次數上限的用量計數器在取消後不會退還額度
4. 若功能驗證無誤，考慮把 GitHub repo 改為 Private

## ⚠️ 注意事項
- 專案資料夾在 Google 雲端硬碟（`G:\我的雲端硬碟\AI\Reservation`），換電腦前請確認同步完成
- Firebase 專案 `reservation-98067` 由 **shingyong02@gmail.com** 擁有，jnfakimo 是被邀請的協作擁有者。CLI 端因 `FIREBASE_TOKEN` 環境變數存在，一律以 jnfakimo 身分認證（`--account` 參數會被該變數覆蓋）
- billing 未啟用（Spark 方案），架構刻意設計為不需要 Cloud Functions，全部靠 Firestore client transaction + 安全規則
- 本地測試：背景執行 `python -m http.server 8899`（cwd 需為 `public/`），再用 `.claude/launch.json` 的 `reservation` 設定 attach 到 `http://localhost:8899`

## 🕐 最後更新
- 時間：2026-08-06 12:20
- 更新者：Claude Code @ DESKTOP-0CFB6UK
- Git push：待推送
