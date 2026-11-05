-- 複核、匯出、佇列用的資料庫函式，以及檔案儲存空間

-- ===== 人工複核：確認放行或標記不產生收款 =====
-- 附件一項目 3：修正後確認，匯出檔使用修正後的值，紀錄保留 AI 原值與修正人。
-- p_values：修正後的 ReceiptValues；p_summary：依 _shared/rules.ts summaryText() 算好的摘要
create or replace function public.review_receipt(p_id uuid, p_action text, p_values jsonb, p_summary text)
returns public.receipts
language plpgsql security definer set search_path = public as $$
declare
  r public.receipts;
  v_name text;
  v_code text := coalesce(p_values ->> 'customer_code', '');
  v_amount integer := (p_values ->> 'amount')::integer;
  v_changed text[];
begin
  if not (has_role('owner') or has_role('accountant') or has_role('reviewer')) then
    raise exception '沒有複核權限';
  end if;
  if p_action not in ('approve', 'skip') then raise exception '未知的動作 %', p_action; end if;
  select * into r from receipts where id = p_id for update;
  if not found then raise exception '找不到這筆收款'; end if;
  if r.status <> 'review' then raise exception '這筆已經處理過了（%）', r.status; end if;

  if p_action = 'approve' then
    select name into v_name from customers where code = v_code;
    if v_name is null then raise exception '客戶編號 % 不在客戶主檔，請先修正', v_code; end if;
    if v_amount is null or v_amount <= 0 then raise exception '請輸入實收金額'; end if;
  end if;

  select coalesce(array_agg(k order by k), '{}') into v_changed
  from jsonb_object_keys(p_values) k
  where r.current_values -> k is distinct from p_values -> k;

  insert into review_logs (receipt_id, action, before_values, after_values, changed_fields, user_id)
  values (p_id, p_action, r.current_values, p_values, v_changed, auth.uid());

  update receipts set
    status = case p_action when 'approve' then 'reviewed' else 'skipped' end,
    current_values = p_values,
    customer_code = v_code,
    customer_name = coalesce(v_name, customer_name),
    amount = v_amount,
    summary = case p_action when 'approve' then coalesce(p_summary, '') else summary end,
    released_by = auth.uid(),
    released_at = now()
  where id = p_id
  returning * into r;
  return r;
end $$;

-- ===== 匯出收款單 =====
-- 附件一項目 4：同一筆收款不會出現在兩次匯出中 → 在同一個交易裡鎖定、標記、存快照。
-- 客戶名稱依客戶主檔帶出（匯出當下的主檔）。
create or replace function public.create_export(p_date integer)
returns public.exports
language plpgsql security definer set search_path = public as $$
declare
  e public.exports;
  s public.settings;
  v_rows jsonb;
  v_ids uuid[];
begin
  if not (has_role('owner') or has_role('accountant')) then raise exception '沒有匯出權限'; end if;
  select * into s from settings;

  with picked as (
    select r.id, r.customer_code, coalesce(c.name, r.customer_name) as customer_name, r.amount, r.summary,
           u.created_at as u_at, p.page_no, r.entry_index
    from receipts r
    join uploads u on u.id = r.upload_id
    join pages p on p.id = r.page_ids[1]
    left join customers c on c.code = r.customer_code
    where r.export_id is null and r.status in ('auto', 'reviewed')
    order by u.created_at, p.page_no, r.entry_index
    for update of r skip locked
  )
  select coalesce(array_agg(id order by u_at, page_no, entry_index), '{}'),
         coalesce(jsonb_agg(jsonb_build_object('receipt_id', id, 'customer_code', customer_code,
           'customer_name', customer_name, 'amount', amount, 'summary', summary) order by u_at, page_no, entry_index), '[]')
  into v_ids, v_rows from picked;

  if cardinality(v_ids) = 0 then raise exception '目前沒有可匯出的收款'; end if;

  insert into exports (export_date, file_name, row_count, total, rows, settings, created_by)
  values (p_date,
          '收款單_' || p_date || coalesce('_' || nullif((select count(*) + 1 from exports where export_date = p_date), 1)::text, '') || '.xlsx',
          cardinality(v_ids),
          (select coalesce(sum((x ->> 'amount')::integer), 0) from jsonb_array_elements(v_rows) x),
          v_rows,
          jsonb_build_object('bank_account', s.bank_account, 'subject_code', s.subject_code, 'fee', s.fee),
          auth.uid())
  returning * into e;

  update receipts set export_id = e.id where id = any (v_ids);
  return e;
end $$;

-- ===== 辨識佇列：雲端辨識程式領取待處理頁面（只有 service_role 能呼叫）=====
create or replace function public.claim_pages(p_limit integer, p_lease_seconds integer default 300)
returns setof public.pages
language sql security definer set search_path = public as $$
  update pages set status = 'processing', attempts = attempts + 1,
         lease_until = now() + make_interval(secs => p_lease_seconds)
  where id in (
    select p.id from pages p join uploads u on u.id = p.upload_id
    where u.status = 'queued'
      and (p.status = 'pending' or (p.status = 'processing' and p.lease_until < now()))
    order by p.created_at, p.page_no
    for update of p skip locked
    limit p_limit
  )
  returning *;
$$;

revoke execute on function public.claim_pages(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_pages(integer, integer) to service_role;
revoke execute on function public.review_receipt(uuid, text, jsonb, text) from public, anon;
revoke execute on function public.create_export(integer) from public, anon;
grant execute on function public.review_receipt(uuid, text, jsonb, text) to authenticated;
grant execute on function public.create_export(integer) to authenticated;

-- ===== 檔案儲存空間 =====
-- scans：單頁影像（90 天後自動刪除）；exports 不另存檔案，匯出內容存在 exports.rows，隨時重新產生
insert into storage.buckets (id, name, public) values ('scans', 'scans', false) on conflict do nothing;

create policy scans_read on storage.objects for select to authenticated
  using (bucket_id = 'scans' and public.is_active_user());
