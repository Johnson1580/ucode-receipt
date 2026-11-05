-- 客戶主檔還沒匯入時，不檢查「客戶編號在不在主檔」（2026-10-20 使用者要求先拿掉，看樣本正常情況的結果）。
-- 匯入主檔後規則自動恢復（附件一項目 4 驗收標準：主檔找不到的客戶編號列入人工複核）。
-- 複核放行：主檔有資料時客戶編號必須在主檔；主檔是空的時，客戶名稱用單據上印的（AI 讀到的）。
create or replace function public.review_receipt(p_id uuid, p_action text, p_values jsonb, p_summary text)
returns public.receipts
language plpgsql security definer set search_path = public as $$
declare
  r public.receipts;
  v_name text;
  v_code text := coalesce(p_values ->> 'customer_code', '');
  v_amount integer := (p_values ->> 'amount')::integer;
  v_changed text[];
  v_master_empty boolean := not exists (select 1 from customers);
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
    if v_name is null and not v_master_empty then raise exception '客戶編號 % 不在客戶主檔，請先修正', v_code; end if;
    if v_code = '' then raise exception '請填客戶編號'; end if;
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
