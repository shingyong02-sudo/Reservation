# 交接檔（handoff.md）

> 任何 Agent、任何電腦接手前**必讀**；收工時**必更新**。本檔只放交接必需的精簡資訊，詳細脈絡放 Obsidian（若有 L3）。

## ⏯️ 目前做到哪

系統已上線：**https://reservation-98067.web.app**（後台 `/admin`）。社區名稱 **聯懋超綻**。

本次（2026-08-07）完成 P0/P1 安全規則補強與邏輯錯誤修補，全部已部署並更新：

1. **Firestore 安全規則強化 (P0/P1)**：
   - 限制 `slotLocks` 與 `unitSlotHolds` 寫入，強迫比對 `bookingId` 且確認預約人與當前登入者 UID 相符（使用 wildcard 變數替代不支援的 `request.resource.id`）。
   - 限制 `unitDailyUsage` 與 `unitWeeklyUsage` 僅限本人或後台人員讀寫，防止任意篡改他人使用上限（使用 `matches` 正規表示式替代不支援的 `String.split()` 語法）。
   - 限制 `bookings` 建立，比對 `applicantName` 與 `houseNumber` 必須完全吻合 `users/{uid}` 中記錄的個人資訊，防堵惡意冒名預約。
2. **取消預約流程交易事務化 (P2)**：
   - 將住戶取消（`app.js` `doCancel`）與管理員變更審核狀態/釋出時段（`admin.js` `setStatus`/`releaseSlot`）所涉的資料庫更新包裝為 Firestore `runTransaction`，確保 Booking 狀態變更、時段鎖釋放、Holds 佔位刪除與 Usage 扣回具備 ACID 原子性。
3. **後台按鈕 Double-Click 鎖定防護 (P2)**：
   - 場地設定、設備管理、公告發布、帳號管理中的所有儲存與新增按鈕均加上 click 鎖定（`disabled = true`），防堵因連點造成的多重寫入或寫入衝突。
4. **細項優化 (P3)**：
   - 今日總覽的「時段使用率」分母改為平行讀取並加總所有場地當前時段範本數，不再寫死為場地數乘以 7。
   - 修正 `fetchClientIp` 計時器資源洩漏，將 `clearTimeout` 移至 `finally` 區塊，保證不論超時與否均會清空。
5. **快取失效管理、排版優化與導覽外鏈 (v=20260807h)**：
   - 將所有相對載入之靜態資源版本號戳記統一升級至 **`?v=20260807h`**。
   - 修正後台 `.admin-aside` 的 CSS 佈局，為側邊欄加上 `position: sticky; top: 0; height: 100vh;`，並在 `.admin-nav` 加入 `overflow-y: auto;`，使個人資訊與「登出」按鈕永遠置底固定不隨頁面滾動。
   - 在後台左側導覽選單的最下方新增一個「線上預約 ↗」的外部連結按鈕，連結至前台的 `https://reservation-98067.web.app/#`，並使用 `target="_blank"` 另開新分頁；透過 CSS 為該按鈕設計了 dashed 分隔線，且同步相容桌機（border-top）與手機（border-left）版型。
   - 修正前台「預約規則」區塊下方到頁尾的留白：將 `#rules` 的 `margin-bottom` 縮減為 `var(--space-4)`，並將 `.site-footer` 的 `margin-top` 縮減為 `var(--space-4)`，使下方多餘留空剛好減半。

## 🚦 目前狀態

- 住戶端與安全防護規則皆已在 production 完整驗證。
- **後台管理端已加入雙點擊防護及動態預約率，但多帳號測試尚待物業實際操作。**
- 系統管理員帳號：`jnfakimo@gmail.com`（uid `9WAjh6E4OUebjWggHd2gwujBzd33`）

## ➡️ 下一步

1. **照 `docs/admin-test-checklist.md` 把後台點過一遍**，完成功能點實測。
2. **Firebase Console → Authentication → Templates**：密碼重設信目前很可能還是英文預設範本，需改寄件者名稱與中文內文。
3. **請 owner `shingyong02` 把 GitHub repo 改為 Private**——jnfakimo 只有 push 權限，沒有 admin 權限無法直接修改可見性。

## ⚠️ 注意事項

- 專案資料夾在 Google 雲端硬碟（`G:\我的雲端硬碟\AI\Reservation`），換電腦前確認同步完成。
- **改完 JS/CSS 一定要更新版本參數**：所有模組網址帶 `?v=YYYYMMDDx`（目前 **`20260807h`**），HTML、內部相對 import、style.css 都要一起改。
- IP 由 `api.ipify.org` 取得，查不到記為「未知」，計時器已由 `finally` 安全釋放。
- 本機測試用 `py -m http.server 8899`（cwd 為 `public/`），不要用 `python`（PATH 問題）。

## 🕐 最後更新
- 時間：2026-08-07 收工
- 更新者：Antigravity @ DESKTOP-0CFB6UK
- Git push：待推 (L2 同步進行中)
