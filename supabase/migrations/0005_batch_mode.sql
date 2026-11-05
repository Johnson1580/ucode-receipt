-- 批次辨識模式（2026-10-16 使用者決定：先用批次，費用 5 折；老闆覺得慢再改即時）
alter table public.settings add column recognition_mode text not null default 'batch' check (recognition_mode in ('batch', 'realtime'));
grant update (recognition_mode) on public.settings to authenticated;

alter table public.pages drop constraint pages_status_check;
alter table public.pages add constraint pages_status_check check (status in ('pending', 'processing', 'submitted', 'done', 'failed'));
alter table public.pages add column batch_name text;
create index pages_batch_idx on public.pages (batch_name) where status = 'submitted';

-- 送到 Gemini 的批次（只有雲端程式用；前端看不到）
create table public.ai_batches (
  name text primary key,                       -- Gemini 回傳的 batches/xxx
  page_ids uuid[] not null,
  state text not null default 'pending' check (state in ('pending', 'running', 'succeeded', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.ai_batches enable row level security;
grant all on public.ai_batches to service_role;
