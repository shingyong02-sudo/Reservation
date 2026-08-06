# 交接檔（handoff.md）

> 任何 Agent、任何電腦接手前**必讀**；收工時**必更新**。本檔只放交接必需的精簡資訊，詳細脈絡放 Obsidian（若有 L3）。

## ⏯️ 目前做到哪
RDQ 需求規格卡已**確認**（status: confirmed，路徑 `C:\Users\jnfa\NotebookLM\rdq\RDQ-spec-community-facility-booking-20260806.md`）。系統規劃藍圖已產出：`docs/system-blueprint.md`（架構圖、Firestore 資料模型、核心流程、頁面規劃、開發順序建議）。L1/L2/L3 三層級初始化全部完成。

## 🚦 目前狀態
- 尚無任何程式碼，只有 `agents.md`／`handoff.md`／`docs/system-blueprint.md`
- 藍圖裡列了 3 項「待補確認」（物業後台登入方式、設備必要性判斷、查詢碼格式），見 `docs/system-blueprint.md` 第 5 節，使用者尚未回覆

## ➡️ 下一步
1. 使用者確認或修改藍圖第 5 節「待補確認」項目（尤其物業後台登入方式，這會影響 Firebase Auth 設定）
2. 依藍圖第 6 節開發順序，從 Firebase 專案設定（Firestore 資料結構＋安全規則）開始動工

## ⚠️ 注意事項
- 專案資料夾在 Google 雲端硬碟（`G:\我的雲端硬碟\AI\Reservation`），換電腦前請確認同步完成
- 後端採用 Firebase 既有專案 `my-teaching-tools-87a6d`，非新建專案
- GitHub repo 目前是 **Public**（使用者尚未決定要不要轉 Private）

## 🕐 最後更新
- 時間：2026-08-06 11:20
- 更新者：Claude Code @ DESKTOP-0CFB6UK
- Git push：✅ 已推（main 分支）
