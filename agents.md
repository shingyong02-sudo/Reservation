# 社區設施預約系統（專案藍圖）

> 本檔為跨 Agent 通用的專案藍圖（AGENTS.md 開放標準）。任何 Agent 的每個 session 都應先讀本檔＋`handoff.md`。

## 專案簡介
社區六類設施的線上預約系統：棋藝室(1間)、KTV室(1間)、健身室/健身房、親子育樂室、宴會廳(1間)、SPA室（容納人數皆由物業後台設定）。住戶免登入、以姓名＋房號預約，固定時段制，送出即自動確認。後端採 Firebase（沿用既有專案 my-teaching-tools-87a6d）。核心原則：場地/設備/人數等設定全部資料化、不寫死，物業（管理人員）可隨時在後台調整；設備故障時可標記「維修中」並自動擋掉受影響時段。前端需支援電腦、手機、平板多載具。
詳細需求規格見：原始 RDQ 訪談產出的規格卡，存放於 `C:\Users\jnfa\NotebookLM\rdq\RDQ-spec-community-facility-booking-20260806.md`（後續建議複製一份到本專案 `rdq/` 目錄）

## 關鍵時程
<!-- 尚未提供具體時程 -->

## 目標與路線圖
- [x] 階段一：需求確認（RDQ 規格卡，status: confirmed）
- [x] 階段二：資料模型與系統架構規劃藍圖（見 `docs/system-blueprint.md`）
- [ ] 階段三：Firebase 專案設定（Firestore 資料結構、安全規則）
- [ ] 階段四：住戶端預約頁面（多載具響應式）
- [ ] 階段五：物業後台管理介面（場地/設備/人數/審核開關/操作紀錄）
- [ ] 階段六：測試與上線

## 資料夾結構
<!-- 初始化時掃描為空資料夾，之後新增檔案要更新 -->
- `docs/system-blueprint.md`：系統規劃藍圖（架構圖、資料模型、頁面規劃、開發順序）

## 同步層級（本專案初始化至第 3 層級）

| 層級 | 平台 | 位置 | 讀取時機 |
|------|------|------|---------|
| L1 | 本地（GDrive） | `agents.md`＋`handoff.md` | 每個 session |
| L2 | GitHub | [shingyong02-sudo/Reservation](https://github.com/shingyong02-sudo/Reservation)（Public，jnfakimo 已加為 collaborator） | 指定時 |
| L3 | Obsidian | `secondbrain` vault → `Reservation/專案工作流程.md`（已建立） | 有需要時 |

## 工作約定
- 任何 Agent、任何電腦：**開工先讀 `handoff.md`，收工必更新 `handoff.md`**
- 修改共用檔案前先讀最新內容，避免覆蓋其他 Agent 的變更
- 所有回應與文件使用繁體中文
- 修改前先確認計畫，優先保留原有資料結構
- 需求變更一律先更新 RDQ 規格卡（`rdq/` 目錄），不要邊做邊改需求
