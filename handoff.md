# 交接檔（handoff.md）

> 任何 Agent、任何電腦接手前**必讀**；收工時**必更新**。本檔只放交接必需的精簡資訊，詳細脈絡放 Obsidian（若有 L3）。

## ⏯️ 目前做到哪
已完成**全面網站優化**並部署上線（commit 9c5c0e0）。完整內容見 `docs/optimization-report.md`：
- 修掉 4 個真實 bug（時區導致週計數錯一天、儀表板設備警示靜默失效、查詢碼用 Math.random、時段標籤未跳脫）
- 補上 3 項產品缺口（住戶取消後自動釋出時段、自動退還次數額度、查詢碼一鍵複製）
- 安全規則收緊並通過滲透測試（8 項未登入攻擊嘗試全數擋下）
- 無障礙達 WCAG AA、行動裝置 375px 零水平溢出、觸控目標 44px
- production 實測：18KB、16 請求、約 1.85 秒載入、控制台零錯誤

## 🚦 目前狀態
- **住戶端已完整驗證**：預約 → 查詢碼 → 查詢 → 取消 → 時段自動釋出 → 額度退還，全部在 production 跑通
- **物業後台仍未實測登入後功能**：Agent 依安全規則不能替使用者輸入密碼，需由使用者自行登入點測
- 管理員帳號：`jnfakimo@gmail.com`（Authentication 已開通）
- 使用者留了一筆測試預約 `5JBQX3U6`（棋藝室／1111／11111／上午場）尚未清除
- GitHub repo `shingyong02-sudo/Reservation` 仍是 **Public**

## ➡️ 下一步
1. **使用者自行登入 `/admin` 點測後台六個模組**（先前已給過測試清單：儀表板 → 場地管理 → 設備管理 → 預約管理 → 操作紀錄），有錯誤或畫面異常回報給 Agent 修
2. 特別要驗的是**設備管理**：把 KTV室「點歌主機」標維修中，確認住戶端 KTV室 立刻停止開放；再把「無線麥克風」標維修中，確認住戶端不受影響（非必要設備）
3. 測完清掉測試預約 `5JBQX3U6`
4. 考慮把 GitHub repo 改為 Private
5. `docs/optimization-report.md` 第八節列了後續可做的項目（深色模式、住戶身分驗證、預約通知、場地照片）

## ⚠️ 注意事項
- 專案資料夾在 Google 雲端硬碟（`G:\我的雲端硬碟\AI\Reservation`），換電腦前請確認同步完成
- Firebase 專案 `reservation-98067` 由 **shingyong02@gmail.com** 擁有，jnfakimo 是協作擁有者。CLI 因 `FIREBASE_TOKEN` 環境變數存在，一律以 jnfakimo 身分認證（`--account` 會被覆蓋）
- billing 未啟用（Spark 方案），架構刻意不依賴 Cloud Functions，全部靠 Firestore client transaction + 安全規則
- **次數上限在免登入前提下無法真正強制**（換個門牌就繞過），這是刻意的取捨，理由寫在 `docs/optimization-report.md` 第三節
- 本地測試：背景執行 `python -m http.server 8899`（cwd 需為 `public/`），再用 `.claude/launch.json` 的 `reservation` 設定 attach 到 `http://localhost:8899`

## 🕐 最後更新
- 時間：2026-08-06 13:40
- 更新者：Claude Code @ DESKTOP-0CFB6UK
- Git push：✅ 已推（main 分支，commit 9c5c0e0）
