-- local-test: skip（本機沒有 vault）
-- 排程需要的兩個 vault secret（project_url、cron_secret）由雲端程式自己寫入：
-- maintenance 收到 {"setup": true}（一樣要排程密鑰）時，用自己的環境變數呼叫這個函式。密鑰不用經過聊天、也不會進 git。
create or replace function public.setup_cron_secrets(p_url text, p_secret text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'project_url';
  if v_id is null then perform vault.create_secret(p_url, 'project_url'); else perform vault.update_secret(v_id, p_url); end if;
  select id into v_id from vault.secrets where name = 'cron_secret';
  if v_id is null then perform vault.create_secret(p_secret, 'cron_secret'); else perform vault.update_secret(v_id, p_secret); end if;
end $$;
revoke execute on function public.setup_cron_secrets(text, text) from public, anon, authenticated;
grant execute on function public.setup_cron_secrets(text, text) to service_role;

-- 檢查排程狀態用（只回傳排程是否設定、最近一次呼叫結果，不回傳密鑰）
create or replace function public.cron_status() returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'vault', (select count(*) from vault.secrets where name in ('project_url', 'cron_secret')),
    'jobs', (select jsonb_agg(jobname) from cron.job),
    'recent', (select jsonb_agg(jsonb_build_object('status', status_code, 'at', created, 'body', left(content, 200)) order by created desc)
               from (select * from net._http_response order by created desc limit 5) r));
$$;
revoke execute on function public.cron_status() from public, anon, authenticated;
grant execute on function public.cron_status() to service_role;
