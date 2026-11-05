# 優碼數位辨識系統 — 給 Claude 的專案筆記

**2026-11-03 開資料夾。** 優碼數位（U-CODE）自己用的 AI 收款單據辨識系統。程式是從 `../ai辨識貨單系統`（永進米行專案）**複製**來的，功能一模一樣，但**不含 LINE 採購機器人**。這份只放「現在要遵守的規則」跟現況。

## 從哪裡來、改了什麼

- 來源：`../ai辨識貨單系統` commit `b03ec10`（2026-10-31，辨識 prompt v6），用 `git archive` 只匯出有進版控的程式碼——**沒有帶永進的樣本、報價單、合約、金鑰、`supabase/.temp`（雲端連結）、上傳程式設定**。
- 拿掉：LINE 採購機器人（網頁 `/purchasing`、Edge Functions `purchase`／`line-webhook`、migration `0011_purchasing.sql`、`PURCHASE_PROMPT`、maintenance 裡清進貨單影像、測試 4d）；永進的碰面清單、給業主看的 demo、`eval/`（用永進樣本的評估腳本）。migration 編號因此從 0010 跳到 0012，正常。
- 改名：畫面、手機 App、推播標題「優碼數位AI辨識系統」；logo 與 App 圖示用 `../優碼數位/0497FF8E-….PNG`（U-CODE 標誌，圖示只取方塊標誌）；裝置金鑰前綴 `uc_up_`／`uc_bk_`；上傳程式「優碼收款單據上傳」、單一執行 mutex `UCodeReceiptUploader`、開機排程 `UCode-Receipt-Uploader`（跟永進的不同，同一台電腦裝兩套也不會互卡）、`VERSION` 從 1.0.0 重新起算。
- prompt 與測試裡永進客戶的真實名稱（連鎖客戶、分店名、測試資料的客戶名）都換成虛構的；prompt 不再寫死「永進米行」。
- **還是照永進的單據與 ERP 設計的**：prompt 假設是「業主 ERP 印的送貨單／應收帳款對帳單＋手寫收款註記」；匯出的收款單 Excel 是永進 ERP 的匯入格式（日期 8 碼、存摺帳號 0001、科目 1141、手續費 0，系統設定可改帳號／科目／手續費）。要用在別的單據或 ERP，prompt 與 `excel.ts` 要跟著改，改完要用新樣本驗證。

## 現況（2026-11-03）

- **還沒部署、還沒 git commit**：要自己開 Supabase 專案、Vercel 專案、GitHub repo、Gemini 金鑰（優碼自己的帳號）。步驟照 `docs/部署.md`、`docs/金鑰設定.md`。
- `scripts/publish_uploader.sh` 的 `PROJECT_REF` 還是佔位字，建好 Supabase 專案後要填，不然腳本會拒絕執行。
- `npm run validate`、`scripts/run_batch.ts` 需要 `samples/`（真實樣本與標準答案），這裡沒有，要自己準備。

## 規則（不要碰到永進米行）

- **完全獨立**：不共用永進（`../ai辨識貨單系統`）的 Supabase 專案（ref `zxxvrdilwjplbahsshag`）、Vercel 專案、GitHub repo、Gemini 金鑰、裝置金鑰。同一個 Supabase 帳號底下有永進與多租戶系統的正式專案，**任何 Supabase CLI 指令前確認 `supabase/.temp/project-ref` 是本專案**。
- 不要去改 `../ai辨識貨單系統` 裡的任何檔案；需要參考那邊的踩坑紀錄可以讀它的 CLAUDE.md，但那份含永進的客戶資訊，不要抄進這裡。
- 真實樣本放 `samples/`、商務文件放 `報價單/`，都不進 git（`.gitignore` 已設）。金鑰不要貼在對話裡。
- commit／push 等使用者要求才做。套件版本一律用發布超過兩週的。

## 沿用的技術規則（從永進專案帶過來，仍然適用）

- 程式結構：`supabase/functions/_shared/` 是辨識與規則唯一一份程式（雲端 Deno 與網頁 `@shared/*` 共用）；`process-queue`、`device-api`、`maintenance` 三個 Edge Functions；`web/` 是 Next.js 16（關掉 Cache Components，middleware 叫 `proxy.ts`），Vercel Root Directory 設 `web`；`uploader/` 是常駐電腦上傳程式（Python，GitHub Actions 在 Windows 測試＋打包＋自動更新實測，`.github/workflows/uploader.yml`）。
- 測試：`npm test`、`./scripts/test_db.sh`（本機暫時 PostgreSQL，`brew install postgresql@17`）、`uploader/test_uploader.py`。改上傳程式一定要等 Windows 測試通過。
- Supabase 建專案：Data API 勾、**Automatically expose new tables 不勾**、**automatic RLS 勾**；每張新表的 migration 要有 create table＋grant（含 service_role）＋RLS policy；資料庫改動一律寫 migration、`npx supabase db push`，不在後台手改。
- Gemini 批次要用舊版 `responseSchema`（`gemini.ts` 的 `toOpenApiSchema()`）；Supabase 雲端不能做影像處理（翻轉圖由上傳程式產生）；透字頁要「原圖＋翻轉圖」先判斷再轉錄，不然 AI 會編造內容。
- 會被漏掉、沒人看到的路徑一律導向複核（送貨單沒讀到收款、寫了作廢、跨頁合併、客戶編號手改…）；改 prompt 後要用樣本回歸驗證。
- Vercel 只依 `web/package.json` 安裝；commit 作者 Email 要對得到 GitHub 帳號；只改 `web/` 以外不會觸發 Vercel 部署。Hobby 方案不能商用。
- Supabase 內建寄信只寄給專案成員，「忘記密碼」要設自訂 SMTP。
