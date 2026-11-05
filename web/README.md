# 優碼數位 AI 收款單據辨識系統：網頁

Next.js 16（關掉 Cache Components），部署在 Vercel（Root Directory 設 `web`）。
規則與 Excel 格式引用 `../supabase/functions/_shared`（與雲端辨識程式共用同一份）。

- 本機開發：`web/.env.example` 複製成 `web/.env.local` 填好後 `npm run dev`
- 環境變數與金鑰：見 `../docs/金鑰設定.md`；部署步驟：`../docs/部署.md`
