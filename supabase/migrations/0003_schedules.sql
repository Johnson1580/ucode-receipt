-- local-test: skip（本機測試沒有 pg_cron / pg_net / vault）
-- 排程：每分鐘跑辨識佇列、每 10 分鐘跑維護（90 天原圖刪除、上傳程式沒回報提醒、送通知）。
-- 需要先在 vault 建兩個 secret（見 docs/部署.md）：project_url、cron_secret（與 Edge Function 的 CRON_SECRET 相同）
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.call_function(fn text) returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/' || fn,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000);
$$;
revoke execute on function public.call_function(text) from public, anon, authenticated;

select cron.schedule('process-queue', '* * * * *', $$ select public.call_function('process-queue') $$);
select cron.schedule('maintenance', '*/10 * * * *', $$ select public.call_function('maintenance') $$);
