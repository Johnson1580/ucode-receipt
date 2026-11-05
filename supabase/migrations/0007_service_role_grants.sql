-- 雲端程式（Edge Functions，service_role）的權限
-- 2026-10-16 部署時發現：專案關掉「Automatically expose new tables」後，連 service_role 都不會自動拿到新表的權限，
-- 雲端程式讀 settings 得到 null（不是報錯）。所以要明確 grant；之後新增的表也自動給 service_role。
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
