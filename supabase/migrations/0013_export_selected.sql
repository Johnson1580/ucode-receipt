-- 匯出收款單可以勾選要匯出哪幾筆（2026-10-30 到場測試後業主要求）
-- p_ids：勾選的收款；null＝全部已放行、還沒匯出的（舊的呼叫方式）。序號由 Excel 產生時依匯出順序 1、2、3 重編，沒勾的不佔號。
-- 勾選的收款如果已經被別人匯出、或狀態變了，整次拒絕（不默默少匯），請操作人員重新整理再選。

drop function if exists public.create_export(integer);

create or replace function public.create_export(p_date integer, p_ids uuid[] default null)
returns public.exports
language plpgsql security definer set search_path = public as $$
declare
  e public.exports;
  s public.settings;
  v_rows jsonb;
  v_ids uuid[];
begin
  if not (has_role('owner') or has_role('accountant')) then raise exception '沒有匯出權限'; end if;
  if p_ids is not null and cardinality(p_ids) = 0 then raise exception '請至少勾選一筆'; end if;
  select * into s from settings;

  with picked as (
    select r.id, r.customer_code, coalesce(c.name, r.customer_name) as customer_name, r.amount, r.summary,
           u.created_at as u_at, p.page_no, r.entry_index
    from receipts r
    join uploads u on u.id = r.upload_id
    join pages p on p.id = r.page_ids[1]
    left join customers c on c.code = r.customer_code
    where r.export_id is null and r.status in ('auto', 'reviewed')
      and (p_ids is null or r.id = any (p_ids))
    order by u.created_at, p.page_no, r.entry_index
    for update of r skip locked
  )
  select coalesce(array_agg(id order by u_at, page_no, entry_index), '{}'),
         coalesce(jsonb_agg(jsonb_build_object('receipt_id', id, 'customer_code', customer_code,
           'customer_name', customer_name, 'amount', amount, 'summary', summary) order by u_at, page_no, entry_index), '[]')
  into v_ids, v_rows from picked;

  if p_ids is not null and cardinality(v_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception '勾選的收款有些已經被匯出或狀態已變更，請重新整理後再選';
  end if;
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

revoke execute on function public.create_export(integer, uuid[]) from public, anon;
grant execute on function public.create_export(integer, uuid[]) to authenticated;
