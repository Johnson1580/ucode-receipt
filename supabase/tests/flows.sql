-- 權限與流程測試：用 set role authenticated + request.jwt.claim.sub 模擬真的登入的使用者（不是只用 service role 測）
\set ON_ERROR_STOP 1
begin;
insert into auth.users values ('00000000-0000-0000-0000-000000000001', 'boss@x'), ('00000000-0000-0000-0000-000000000002', 'acc@x'),
  ('00000000-0000-0000-0000-000000000003', 'rev@x'), ('00000000-0000-0000-0000-000000000004', 'off@x');
insert into profiles (id, display_name, email, roles, active) values
  ('00000000-0000-0000-0000-000000000001', '老闆', 'boss@x', '{owner}', true),
  ('00000000-0000-0000-0000-000000000002', '會計', 'acc@x', '{accountant}', true),
  ('00000000-0000-0000-0000-000000000003', '複核', 'rev@x', '{reviewer}', true),
  ('00000000-0000-0000-0000-000000000004', '已停用', 'off@x', '{owner}', false);
insert into customers values ('00385', '範例商行'), ('02655', '示範快餐');
insert into uploads (id, file_name, file_hash, page_count, status, scan_date) values
  ('10000000-0000-0000-0000-000000000001', 'a.pdf', repeat('a', 64), 2, 'done', 20261016);
insert into pages (id, upload_id, page_no, image_path, status) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 1, 'x/p001.jpg', 'done'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 2, 'x/p002.jpg', 'done');
insert into receipts (id, upload_id, page_ids, entry_index, status, reasons, ai_values, current_values, customer_code, customer_name, amount, summary, scan_date) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '{20000000-0000-0000-0000-000000000001}', 0, 'auto', '{}',
   '{"customer_code":"00385","amount":1200}', '{"customer_code":"00385","amount":1200}', '00385', '範例商行', 1200, '', 20261016),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '{20000000-0000-0000-0000-000000000002}', 0, 'review', '{合計 3760 手改 3700}',
   '{"customer_code":"02655","amount":3600}', '{"customer_code":"02655","amount":3600}', '02655', '示範快餐', 3600, '', 20261016);

-- 1. 複核人員：可以看、可以複核，不能匯出、不能改設定
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
do $$ begin assert (select count(*) from receipts) = 2, '複核人員看得到收款'; end $$;
select review_receipt('30000000-0000-0000-0000-000000000002', 'approve',
  '{"customer_code":"02655","amount":3700,"corrected_total":3700}', '合計 3760 手改 3700');
do $$ begin
  assert (select status from receipts where id = '30000000-0000-0000-0000-000000000002') = 'reviewed';
  assert (select amount from receipts where id = '30000000-0000-0000-0000-000000000002') = 3700;
  assert (select ai_values ->> 'amount' from receipts where id = '30000000-0000-0000-0000-000000000002') = '3600', 'AI 原值保留';
  assert (select changed_fields from review_logs) = '{amount,corrected_total}', '紀錄修改欄位';
  assert (select count(*) from exports) = 0, '複核人員看不到匯出';
end $$;
do $$ begin perform create_export(20261016, '{30000000-0000-0000-0000-000000000001}'); raise exception 'should fail'; exception when others then
  assert sqlerrm = '沒有匯出權限', sqlerrm; end $$;
do $$ begin perform review_receipt('30000000-0000-0000-0000-000000000002', 'approve', '{"customer_code":"02655","amount":1}', ''); raise exception 'should fail';
  exception when others then assert sqlerrm like '這筆已經處理過了%', sqlerrm; end $$;
update settings set fee = 99;  -- RLS：複核人員改不到（0 列）
do $$ begin assert (select fee from settings) = 0, '複核人員不能改參數'; end $$;

-- 2. 會計：依掃描檔（PDF）分開匯出、只匯出勾選的，同一筆不會出現在兩次匯出
reset role;
insert into uploads (id, file_name, file_hash, page_count, status, scan_date) values
  ('10000000-0000-0000-0000-000000000008', 'b:1.pdf', repeat('e', 64), 1, 'done', 20261017);
insert into pages (id, upload_id, page_no, image_path, status) values
  ('20000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000008', 1, 'y/p001.jpg', 'done');
insert into receipts (id, upload_id, page_ids, entry_index, status, reasons, ai_values, current_values, customer_code, customer_name, amount, summary, scan_date) values
  ('30000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000008', '{20000000-0000-0000-0000-000000000008}', 0, 'auto', '{}',
   '{"customer_code":"00385","amount":500}', '{"customer_code":"00385","amount":500}', '00385', '範例商行', 500, '', 20261017);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
do $$ begin perform create_export(20261016, '{}'); raise exception 'should fail'; exception when others then
  assert sqlerrm = '請至少勾選一筆', sqlerrm; end $$;
do $$ begin perform create_export(20261016, '{30000000-0000-0000-0000-000000000002,30000000-0000-0000-0000-000000000009}');
  raise exception 'should fail'; exception when others then assert sqlerrm like '勾選的收款有些%', sqlerrm; end $$;
do $$ begin perform create_export(20261016, '{30000000-0000-0000-0000-000000000002,30000000-0000-0000-0000-000000000008}');
  raise exception 'should fail'; exception when others then assert sqlerrm = '一次只能匯出同一個掃描檔的收款', sqlerrm; end $$;
do $$ declare e exports; begin  -- a.pdf 只勾第 2 筆：只匯出這筆，另一筆留著
  e := create_export(20261016, '{30000000-0000-0000-0000-000000000002}');
  assert e.row_count = 1 and e.total = 3700, format('勾選匯出 %s 筆 %s 元', e.row_count, e.total);
  assert e.file_name = '收款單_20261016_a.xlsx' and e.upload_id = '10000000-0000-0000-0000-000000000001', e.file_name;
  assert (select export_id from receipts where id = '30000000-0000-0000-0000-000000000001') is null, '沒勾的不匯出';
end $$;
do $$ begin perform create_export(20261016, '{30000000-0000-0000-0000-000000000002}'); raise exception 'should fail';
  exception when others then assert sqlerrm like '勾選的收款有些%', sqlerrm; end $$;
do $$ declare e exports; begin  -- a.pdf 剩下的：同一天同名加 _2
  e := create_export(20261016, '{30000000-0000-0000-0000-000000000001}');
  assert e.row_count = 1 and e.total = 1200 and e.file_name = '收款單_20261016_a_2.xlsx', e.file_name;
  assert e.rows -> 0 ->> 'customer_code' = '00385', e.rows::text;
end $$;
do $$ declare e exports; begin  -- b.pdf 另一個檔；檔名裡 Windows 不能用的字元換成 _
  e := create_export(20261016, '{30000000-0000-0000-0000-000000000008}');
  assert e.row_count = 1 and e.total = 500 and e.file_name = '收款單_20261016_b_1.xlsx', e.file_name;
end $$;

-- 3. 老闆：可以改參數；停用的帳號什麼都看不到
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
update settings set fee = 0, bank_account = '0002';
do $$ begin assert (select bank_account from settings) = '0002', '老闆可以改參數'; end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', true);
do $$ begin assert (select count(*) from receipts) = 0, '停用帳號看不到資料'; end $$;

-- 3b. 總覽統計
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
do $$ declare s record; begin
  select * into s from daily_stats(20261016);
  assert s.auto = 1 and s.reviewed = 1 and s.exported = 2 and s.page_count = 2, format('%s', s);
end $$;

-- 3c. 客戶主檔是空的時，可以放行主檔沒有的編號（名稱用單據上的）
reset role;
delete from customers;
insert into receipts (id, upload_id, page_ids, entry_index, status, reasons, ai_values, current_values, customer_code, customer_name, amount, summary, scan_date) values
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '{20000000-0000-0000-0000-000000000001}', 1, 'review', '{x}',
   '{"customer_code":"09999","amount":100}', '{"customer_code":"09999","amount":100}', '09999', '單據上的名稱', 100, '', 20261016);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select review_receipt('30000000-0000-0000-0000-000000000003', 'approve', '{"customer_code":"09999","amount":100}', '');
do $$ begin assert (select customer_name from receipts where id = '30000000-0000-0000-0000-000000000003') = '單據上的名稱'; end $$;

-- 4. 前端不能直接改收款、不能領佇列
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
do $$ begin update receipts set amount = 1; raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
do $$ begin perform claim_pages(1); raise exception 'should fail'; exception when insufficient_privilege then null; end $$;

-- 4b. 辨識模式：老闆可以切換，前端看不到批次表
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
update settings set recognition_mode = 'realtime';
do $$ begin assert (select recognition_mode from settings) = 'realtime'; end $$;
do $$ begin perform count(*) from ai_batches; raise exception 'should fail'; exception when insufficient_privilege then null; end $$;

-- 4c. 推播訂閱：只能看、新增、刪除自己的
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ('00000000-0000-0000-0000-000000000003', 'https://push/rev', 'k', 'a');
do $$ begin insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ('00000000-0000-0000-0000-000000000001', 'https://push/x', 'k', 'a');
  raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
do $$ begin assert (select count(*) from push_subscriptions) = 0, '看不到別人的訂閱'; end $$;

-- 5. 佇列：service role 領取，同一頁不會被領兩次；雲端程式讀得到設定
reset role;
set local role service_role;
do $$ begin assert (select ai_model from settings) is not null, 'service_role 讀得到 settings'; end $$;
reset role;
insert into uploads (id, file_name, file_hash, page_count, status, scan_date) values
  ('10000000-0000-0000-0000-000000000002', 'b.pdf', repeat('b', 64), 3, 'queued', 20261016);
insert into pages (upload_id, page_no, image_path) select '10000000-0000-0000-0000-000000000002', n, 'b' || n from generate_series(1, 3) n;
set local role service_role;
do $$ begin
  assert (select count(*) from claim_pages(2)) = 2;
  assert (select count(*) from claim_pages(5)) = 1, '已領取的不會再被領';
  assert (select count(*) from claim_pages(5)) = 0;
end $$;
rollback;
\echo '全部通過'
