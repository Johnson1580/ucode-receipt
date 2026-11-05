-- 上傳程式自動更新（2026-10-30）：新版 exe 與 latest.json（版本、sha256、檔名）放在 uploader bucket。
-- 只有 device-api（service_role）讀，給上傳金鑰產生短時效下載網址；前端與匿名都碰不到（沒有 policy）。
insert into storage.buckets (id, name, public) values ('uploader', 'uploader', false) on conflict do nothing;
