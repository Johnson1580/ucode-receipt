-- 本機測試用：模擬 Supabase 內建的角色、auth、storage（正式環境已經有這些，不要套到正式資料庫）
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema storage;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema auth, storage to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;
-- 不預先給 service_role 權限：跟正式專案（關掉 Automatically expose new tables）一樣，權限要靠 migration 明確 grant
revoke all on schema public from public;
