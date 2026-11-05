-- 處理狀況總覽（附件一項目 3）與上傳程式狀態（項目 1：系統畫面看得到上傳程式最近一次回報的時間）

create or replace function public.daily_stats(p_date integer)
returns table (upload_id uuid, file_name text, created_at timestamptz, upload_status text, page_count integer,
  pages_done integer, pages_failed integer, auto integer, reviewed integer, review integer, skipped integer,
  exported integer, others integer)
language sql stable security definer set search_path = public as $$
  select u.id, u.file_name, u.created_at, u.status, u.page_count,
    (select count(*) from pages p where p.upload_id = u.id and p.status = 'done')::int,
    (select count(*) from pages p where p.upload_id = u.id and p.status = 'failed')::int,
    count(r.id) filter (where r.status = 'auto')::int,
    count(r.id) filter (where r.status = 'reviewed')::int,
    count(r.id) filter (where r.status = 'review')::int,
    count(r.id) filter (where r.status = 'skipped')::int,
    count(r.id) filter (where r.export_id is not null)::int,
    (select count(*) from other_records o where o.upload_id = u.id)::int
  from uploads u left join receipts r on r.upload_id = u.id
  where u.scan_date = p_date and is_active_user()
  group by u.id
  order by u.created_at;
$$;

-- 裝置表只有老闆看得到；其他角色只需要知道上傳程式是否正常
create or replace function public.uploader_status()
returns table (name text, last_seen_at timestamptz, last_status jsonb)
language sql stable security definer set search_path = public as $$
  select name, last_seen_at, last_status from devices where kind = 'uploader' and active and is_active_user() order by last_seen_at desc nulls last;
$$;

-- 本月 AI 用量（頁數、token）
create or replace function public.month_usage()
returns table (pages integer, input_tokens bigint, output_tokens bigint)
language sql stable security definer set search_path = public as $$
  select count(*)::int, coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0) from pages
  where processed_at >= date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei' and is_active_user();
$$;

revoke execute on function public.daily_stats(integer), public.uploader_status(), public.month_usage() from public, anon;
grant execute on function public.daily_stats(integer), public.uploader_status(), public.month_usage() to authenticated;
