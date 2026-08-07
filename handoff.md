# 交接檔（handoff.md）

> 任何 Agent、任何電腦接手前**必讀**；收工時**必更新**。本檔只放交接必需的精簡資訊，詳細脈絡放 Obsidian（若有 L3）。

## ⏯️ 目前做到哪

系統已上線：**https://reservation-98067.web.app**（後台 `/admin`）。社區名稱 **聯懋超綻**。

本次（2026-08-07）完成四件事，全部已 push 並部署到 production：

1. **住戶端登入頁補上「忘記密碼？」**（後台原本就有）。刻意**不比照後台**的錯誤訊息：
   成功與查無帳號都回同一句中性訊息，避免被用來逐一探測有效 Email，
   與 `doLogin()` 不區分「帳號不存在／密碼錯誤」的既有作法一致。
2. **手機／平板版型修正**（見下方「已知細節」）。
3. **首頁背景圖 5.96 MB → 81 KB**（WebP 1920x1080 q78），並移除兩張已無引用的 PNG，
   `public/` 從 11.64 MB 降到 0.21 MB。
4. **後台實測清單**：`docs/admin-test-checklist.md`。

### 營運規則（未變動）
- 時段：**08:00–22:00 每 2 小時共 7 段**；開放預約範圍 **14 天內**
- **同一時段每戶限預約一項設施**（跨場地，靠 `unitSlotHolds` 佔位文件）
- 查詢碼格式 **YX-8F2K6**，輸入時自動正規化
- 三種角色：系統管理員／後台管理員／一般住戶；住戶需登入才能預約

## 🚦 目前狀態

- 住戶端流程已在 production 完整驗證；未登入滲透測試 8 項全數擋下
- 版型已在 **375 / 768 / 1280** 三種寬度實測，住戶端與後台皆無橫向溢出
- **後台登入後的功能仍未由 Agent 實測**——安全規則不允許 Agent 輸入密碼
- 系統管理員帳號：`jnfakimo@gmail.com`（uid `9WAjh6E4OUebjWggHd2gwujBzd33`）

## ➡️ 下一步

1. **照 `docs/admin-test-checklist.md` 把後台點過一遍**，收尾階段七。
   清單依「唯讀 → 可復原 → 破壞性」排序，每項附預期結果與復原方式。
   最關鍵一項：建立帳號後**你自己不該被踢出登入**（程式刻意開第二個 Firebase 實例避免這件事）。
2. **Firebase Console → Authentication → Templates**：密碼重設信目前很可能還是英文預設範本，
   需改寄件者名稱與中文內文。順便用真帳號點一次「忘記密碼」確認信收得到。
3. **請 owner `shingyong02` 把 GitHub repo 改為 Private**——jnfakimo 只有 push 權限、
   沒有 admin，改可見性 API 直接回 404，這件事本機做不到。

其他待辦：補場地實景照片、LINE 通知（需社區的 LINE 官方帳號與 Messaging API）。

### 讀程式碼時發現、刻意沒動的兩處
- **今日總覽使用率分母寫死 7**（`admin.js` `loadDashboard()`）：`active.length / (facs.length * 7)`。
  目前每場地剛好 7 段所以正確，一旦有場地時段數不是 7 就會失真。
- **新增時段會靜默覆蓋同開始時間的舊時段**（`admin.js` `addSlot()`）：
  文件代號是 `t{HHMM}`，`setDoc` 不擋既有文件，連確認框都沒有。

## ⚠️ 注意事項

- 專案資料夾在 Google 雲端硬碟（`G:\我的雲端硬碟\AI\Reservation`），換電腦前確認同步完成
- Firebase 專案 `reservation-98067`（Firestore 位於 asia-east1），
  shingyong02@gmail.com 擁有，jnfakimo 為協作擁有者
- **改完 JS/CSS 一定要更新版本參數**：所有模組網址帶 `?v=YYYYMMDDx`（目前 **`20260807c`**），
  HTML、內部相對 import、style.css 都要一起改。**改 CSS 內容但不換版本號，瀏覽器不會重抓**
  （本次除錯就卡在這裡：CSS 明明改了，量到的版型卻毫無變化）
- 社區名稱與電話集中在 `public/js/shared.js` 的 `COMMUNITY`；
  HTML 裡的 `.contact-phone` 會被 JS 覆寫，只改 HTML 無效
- 公告、後台預約篩選、我的預約都需要複合索引，已寫進 `firestore.indexes.json`
- IP 由 `api.ipify.org` 取得，查不到記為「未知」
- billing 未啟用（Spark 方案），架構刻意不依賴 Cloud Functions
- **本機測試用 `py -m http.server 8899`（cwd 為 `public/`），不要用 `python`**
  ——這台機器的 Git Bash 下 `python` 不在 PATH，會 exit 127。再用 `.claude/launch.json`
  的 `reservation` 設定 attach
- **`git add -A` 在這個專案要小心**：`public/images/` 底下常有使用者手動放的大圖，
  會被一起掃進 commit（本次就誤收了一張 5.47 MB 的未追蹤 PNG）。建議明確列出檔案

### 已知細節：本次版型修正動了什麼
- `.admin-shell` 補 `grid-template-rows: auto 1fr`（原本頂列被撐成 530px）
- `.admin-nav` 補 `min-width: 0`（原本整條列 658px 撐破 375px 畫面）
- `.admin-main` 覆寫全域 `main` 的 `max-width` / `margin: 0 auto`（原本主區不吃滿欄寬）
- 住戶端版首手機版**收起「場地一覽／預約規則」兩個錨點捷徑**，
  讓「我的預約」與「登出」不必左右捲就看得見。**若要改回來，代價是選單需左右捲動**
- `#authArea` 改 `inline-flex`（全尺寸生效，原本姓名與登出折成兩行）
- 背景圖只出 WebP、**沒有 JPEG 備援**。舊裝置（iOS 14 以前）的失敗方式是
  「沒有背景照片、只剩米色底」，頁面完全可用

## 🕐 最後更新
- 時間：2026-08-07 收工
- 更新者：Claude Code @ DESKTOP-0CFB6UK
- Git push：✅ 已推（`a790a47`）；本次收工的文件更新見下一個 commit
