-- 透字判斷與轉錄也走批次（2026-10-20 使用者決定，費用 5 折；沒收款的頁面多等一輪批次）
-- 流程：收款辨識批次 → 沒收款的頁面標 followup（result 先存收款辨識結果）→ 第二輪批次同時送「透字判斷」與「轉錄」
--      → 透字頁丟掉轉錄結果、不是透字頁才採用。第二輪失敗的頁面改用即時處理。
alter table public.pages drop constraint pages_status_check;
alter table public.pages add constraint pages_status_check
  check (status in ('pending', 'processing', 'submitted', 'followup', 'done', 'failed'));
alter table public.ai_batches add column kind text not null default 'receipt' check (kind in ('receipt', 'followup'));

-- 領取等第二輪的頁面（跟 claim_pages 一樣用 skip locked，排程與上傳觸發同時跑也不會重複領）
create or replace function public.claim_followups(p_limit integer, p_lease_seconds integer default 300)
returns setof public.pages
language sql security definer set search_path = public as $$
  update pages set status = 'processing', lease_until = now() + make_interval(secs => p_lease_seconds)
  where id in (
    select id from pages where status = 'followup' order by created_at, page_no for update skip locked limit p_limit
  )
  returning *;
$$;
revoke execute on function public.claim_followups(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_followups(integer, integer) to service_role;
