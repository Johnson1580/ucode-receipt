-- 收回 Supabase 自動開放的表權限（2026-11-05）
-- 本專案用 CLI 建立，等於後台「Automatically expose new tables」是勾的：anon、authenticated 對 public 每張表都有全部權限，
-- 新建的表也會自動開放。權限設計是「只開放明確 grant 的」（0001 開頭的註解），只靠 RLS 擋不夠保險。
-- 這裡把 anon、authenticated 的表／序號權限全部收回、預設權限關掉，再照 0001／0005／0006 原本的 grant 補回。
-- service_role（雲端程式）的權限不動（0007）。

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- 0001
grant select on public.profiles, public.settings, public.customers, public.uploads, public.pages, public.receipts,
  public.review_logs, public.other_records, public.exports, public.notifications to authenticated;
grant update (bank_account, subject_code, fee, backup_time, uploader_alert_minutes, updated_at, updated_by)
  on public.settings to authenticated;
grant insert, update, delete on public.customers to authenticated;
grant select on public.devices to authenticated;
grant update (resolved_at) on public.notifications to authenticated;
-- 0005
grant update (recognition_mode) on public.settings to authenticated;
-- 0006
grant select, insert, delete on public.push_subscriptions to authenticated;
