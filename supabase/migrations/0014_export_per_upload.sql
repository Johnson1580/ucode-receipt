-- 匯出收款單依掃描檔（PDF）分開（2026-10-30 到場測試後業主要求）：
-- 掃描了 a、b、c 三個 PDF，就匯出三個 Excel，各自只含那個 PDF 的收款，序號各自從 1 開始。
-- 一次匯出只能是同一個掃描檔的收款；檔名帶掃描檔名（收款單_20261030_a.xlsx），同一天同名就加 _2、_3。

alter table public.exports add column upload_id uuid references public.uploads (id);

drop function if exists public.create_export(integer, uuid[]);

create or replace function public.create_export(p_date integer, p_ids uuid[])
returns public.exports
language plpgsql security definer set search_path = public as $$
declare
  e public.exports;
  s public.settings;
  v_rows jsonb;
  v_ids uuid[];
  v_upload uuid;
  v_base text;
  v_name text;
  n integer := 1;
begin
  if not (has_role('owner') or has_role('accountant')) then raise exception '沒有匯出權限'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then raise exception '請至少勾選一筆'; end if;
  if (select count(distinct upload_id) from receipts where id = any (p_ids)) > 1 then
    raise exception '一次只能匯出同一個掃描檔的收款';
  end if;
  select * into s from settings;

  with picked as (
    select r.id, r.upload_id, r.customer_code, coalesce(c.name, r.customer_name) as customer_name, r.amount, r.summary,
           p.page_no, r.entry_index
    from receipts r
    join pages p on p.id = r.page_ids[1]
    left join customers c on c.code = r.customer_code
    where r.export_id is null and r.status in ('auto', 'reviewed') and r.id = any (p_ids)
    order by p.page_no, r.entry_index
    for update of r skip locked
  )
  select coalesce(array_agg(id order by page_no, entry_index), '{}'), min(upload_id::text)::uuid,
         coalesce(jsonb_agg(jsonb_build_object('receipt_id', id, 'customer_code', customer_code,
           'customer_name', customer_name, 'amount', amount, 'summary', summary) order by page_no, entry_index), '[]')
  into v_ids, v_upload, v_rows from picked;

  if cardinality(v_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception '勾選的收款有些已經被匯出或狀態已變更，請重新整理後再選';
  end if;

  -- 檔名：收款單_日期_掃描檔名（去掉副檔名與 Windows 檔名不能用的字元）
  select nullif(btrim(regexp_replace(regexp_replace(file_name, '\.[^.]*$', ''), '[\\/:*?"<>|]', '_', 'g')), '')
    into v_base from uploads where id = v_upload;
  v_name := '收款單_' || p_date || coalesce('_' || v_base, '');
  while exists (select 1 from exports where file_name = v_name || case when n = 1 then '' else '_' || n end || '.xlsx') loop
    n := n + 1;
  end loop;
  v_name := v_name || case when n = 1 then '' else '_' || n end || '.xlsx';

  insert into exports (export_date, file_name, row_count, total, rows, settings, created_by, upload_id)
  values (p_date, v_name, cardinality(v_ids),
          (select coalesce(sum((x ->> 'amount')::integer), 0) from jsonb_array_elements(v_rows) x),
          v_rows,
          jsonb_build_object('bank_account', s.bank_account, 'subject_code', s.subject_code, 'fee', s.fee),
          auth.uid(), v_upload)
  returning * into e;

  update receipts set export_id = e.id where id = any (v_ids);
  return e;
end $$;

revoke execute on function public.create_export(integer, uuid[]) from public, anon;
grant execute on function public.create_export(integer, uuid[]) to authenticated;
