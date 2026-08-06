# 交接檔（handoff.md）

> 任何 Agent、任何電腦接手前**必讀**；收工時**必更新**。本檔只放交接必需的精簡資訊，詳細脈絡放 Obsidian（若有 L3）。

## ⏯️ 目前做到哪
前後台功能已建置完成並部署：
- Firestore 資料結構＋安全規則已部署到 `my-teaching-tools-87a6d`（rules 檔：`firestore.rules`）
- 已灌入 6 個場地種子資料（棋藝室/KTV室/健身室/親子育樂室/宴會廳/SPA室），含時段範本與示範設備
- 住戶端 `public/index.html`：已在瀏覽器實測「預約→取得查詢碼→查詢→取消」全流程，成功
- 物業後台 `public/admin.html`：程式碼完成（登入/場地管理/設備管理/預約審核/操作紀錄），**尚未建立管理員帳號，無法實測登入後功能**
- 已部署 Firebase Hosting：https://my-teaching-tools-87a6d.web.app （住戶端）／ `/admin`（後台）
- 已 push 到 GitHub（commit f7765b3）

## 🚦 目前狀態
- 可運行：住戶端已驗證可用
- 未驗證：物業後台登入後的所有功能（場地/設備/時段 CRUD、預約審核、操作紀錄）都還沒有實際跑過，因為沒有管理員帳號
- GitHub repo `shingyong02-sudo/Reservation` 目前仍是 **Public**

## ➡️ 下一步
1. **使用者需自行到 Firebase Console 建立第一個管理員帳號**：
   - 網址：https://console.firebase.google.com/project/my-teaching-tools-87a6d/authentication/providers
   - 先確認 Authentication 的 Email/Password 登入方式已啟用（若未啟用先啟用）
   - 到 Users 分頁 → Add user，輸入 email/密碼（我不會經手密碼）
2. 使用者建好帳號後回報，由 Agent 用該帳號登入 `/admin` 實測後台全部功能，抓 bug
3. 已知限制待確認是否要修：住戶自行取消預約後，時段鎖不會自動釋出，需物業在後台按「釋出時段」；同門牌次數上限用量計數器取消後不會退還額度
4. 若功能驗證無誤，考慮把 GitHub repo 改為 Private

## ⚠️ 注意事項
- 專案資料夾在 Google 雲端硬碟（`G:\我的雲端硬碟\AI\Reservation`），換電腦前請確認同步完成
- 後端採用 Firebase 既有專案 `my-teaching-tools-87a6d`（billing 未啟用，架構刻意設計為不需要 Cloud Functions，全部靠 Firestore client transaction + 安全規則）
- 本地測試用 `.claude/launch.json` 的 `reservation` 設定（attach 到 `http://localhost:8899`），背景執行 `python -m http.server 8899`（cwd: `public/`）才能連上

## 🕐 最後更新
- 時間：2026-08-06 11:30
- 更新者：Claude Code @ DESKTOP-0CFB6UK
- Git push：✅ 已推（main 分支，commit f7765b3）
