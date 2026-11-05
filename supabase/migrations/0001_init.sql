-- 優碼數位 AI 收款單據辨識系統：初始資料表
-- 規則（CLAUDE.md「Supabase 專案設定與資料庫改動規則」）：每張表都要 create table + grant + RLS policy；
-- 不在後台手動改表結構，一律新增 migration。

-- ===== 角色 =====
-- 附件一第三節：老闆（含系統管理）、會計、複核人員；一個帳號可兼任多個角色
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  email text not null,
  roles text[] not null default '{}' check (roles <@ array['owner', 'accountant', 'reviewer']),
  active boolean not null default true,      -- 停用後不能登入，歷史紀錄保留原操作人
  created_at timestamptz not null default now()
);

create or replace function public.has_role(r text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and r = any (roles));
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

-- ===== 參數設定（單列）=====
create table public.settings (
  id boolean primary key default true check (id),
  bank_account text not null default '0001',   -- 收款存摺帳號
  subject_code text not null default '1141',   -- 科目編碼
  fee integer not null default 0,              -- 手續費
  ai_model text not null default 'gemini-3.8-flash',
  ai_paused boolean not null default false,    -- AI 額度不足／帳務錯誤時暫停，補足後自動續跑
  ai_pause_reason text,
  ai_paused_at timestamptz,
  backup_time time not null default '22:00',   -- 每日備份到外接硬碟的時間（台北時間）
  uploader_alert_minutes integer not null default 30, -- 上傳程式超過幾分鐘沒回報就提示
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id)
);
insert into public.settings default values;

-- ===== 客戶主檔（由老闆匯入 Excel 更新）=====
create table public.customers (
  code text primary key,
  name text not null,
  updated_at timestamptz not null default now()
);

-- ===== 常駐電腦上的程式（上傳程式只能上傳；備份用另一把只能讀的金鑰）=====
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('uploader', 'backup')),
  token_hash text not null unique,             -- 金鑰只存 sha256，原文只在建立時顯示一次
  active boolean not null default true,
  last_seen_at timestamptz,
  last_status jsonb,                           -- 上傳程式回報：狀態、待上傳數、外接硬碟是否連接…
  created_at timestamptz not null default now()
);

-- ===== 上傳批次（一個掃描檔）與頁面 =====
create table public.uploads (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references public.devices (id),
  file_name text not null,
  file_hash text not null unique,              -- 同一檔案不重複上傳
  page_count integer not null,
  status text not null default 'uploading' check (status in ('uploading', 'queued', 'done')),
  scan_date integer not null,                  -- 處理日期 8 碼（台北時間），例 20261016
  created_at timestamptz not null default now(),
  finalized_at timestamptz
);

create table public.pages (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.uploads (id) on delete cascade,
  page_no integer not null,
  image_path text not null,                    -- storage scans/ 底下的路徑
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts integer not null default 0,
  lease_until timestamptz,
  error text,
  page_type text,                              -- delivery_note / statement / not_a_document
  result jsonb,                                -- PageResult（AI 原始辨識值，永久保留）
  model text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  processed_at timestamptz,
  image_deleted_at timestamptz,                -- 90 天後原圖自動刪除
  created_at timestamptz not null default now(),
  unique (upload_id, page_no)
);
create index pages_pending_idx on public.pages (status, created_at) where status in ('pending', 'processing');

-- ===== 收款（一個客戶區塊一筆；連鎖對帳單每家分店一筆）=====
create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.uploads (id),
  page_ids uuid[] not null,                    -- 來源頁（跨頁合併時有多頁）
  entry_index integer not null,
  status text not null check (status in ('auto', 'review', 'reviewed', 'skipped')),
  reasons text[] not null default '{}',        -- 進複核的原因
  ai_values jsonb not null,                    -- AI 原始辨識值（ReceiptValues），不會被修改
  current_values jsonb not null,               -- 目前的值（複核修正後）
  customer_code text not null default '',
  customer_name text not null default '',      -- 依客戶主檔帶出
  amount integer,
  summary text not null default '',
  scan_date integer not null,
  released_by uuid references public.profiles (id),  -- 自動放行為 null
  released_at timestamptz,
  export_id uuid,
  created_at timestamptz not null default now()
);
create index receipts_status_idx on public.receipts (status);
create index receipts_customer_idx on public.receipts (customer_code);
create index receipts_unexported_idx on public.receipts (created_at) where export_id is null and status in ('auto', 'reviewed');

-- 複核紀錄：每次修正保留 AI 原值、修正前後的值、修正人與時間
create table public.review_logs (
  id bigint generated always as identity primary key,
  receipt_id uuid not null references public.receipts (id),
  action text not null check (action in ('approve', 'skip')),
  before_values jsonb not null,
  after_values jsonb not null,
  changed_fields text[] not null,
  user_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

-- ===== 其他單據紀錄（沒有產生收款的頁面，不經複核、全部直接填入）=====
create table public.other_records (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.pages (id),
  upload_id uuid not null references public.uploads (id),
  scan_date integer not null,
  source text not null,                        -- 「檔名.pdf 第 N 頁」
  category text not null,                      -- CATEGORY_ZH 四種之一
  customer_code text,
  customer_name text,
  summary text not null,
  full_text text not null default '',
  printed_total integer,                       -- 未收款對帳單的本期應收（客戶與單據查詢用）
  created_at timestamptz not null default now()
);
create index other_records_date_idx on public.other_records (scan_date);
create index other_records_customer_idx on public.other_records (customer_code);

-- ===== 匯出紀錄 =====
create table public.exports (
  id uuid primary key default gen_random_uuid(),
  export_date integer not null,                -- 收款單「日期」欄（處理當天）
  file_name text not null,
  row_count integer not null,
  total integer not null,
  rows jsonb not null,                         -- 匯出當下的內容快照，檔案隨時可重新產生
  settings jsonb not null,                     -- 匯出當下的存摺帳號／科目／手續費
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);
alter table public.receipts add constraint receipts_export_fk foreign key (export_id) references public.exports (id);

-- ===== 通知（AI 額度不足、上傳程式沒回報、外接硬碟未連接…）=====
create table public.notifications (
  id bigint generated always as identity primary key,
  kind text not null,
  message text not null,
  resolved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- ===== 權限 =====
-- 不自動開放新表給前端：明確 grant；service_role（雲端程式）本來就繞過 RLS
grant usage on schema public to authenticated;
grant select on public.profiles, public.settings, public.customers, public.uploads, public.pages, public.receipts,
  public.review_logs, public.other_records, public.exports, public.notifications to authenticated;
grant update (bank_account, subject_code, fee, backup_time, uploader_alert_minutes, updated_at, updated_by)
  on public.settings to authenticated;
grant insert, update, delete on public.customers to authenticated;
grant select on public.devices to authenticated;
grant update (resolved_at) on public.notifications to authenticated;
grant execute on function public.has_role(text), public.is_active_user() to authenticated;

alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.customers enable row level security;
alter table public.devices enable row level security;
alter table public.uploads enable row level security;
alter table public.pages enable row level security;
alter table public.receipts enable row level security;
alter table public.review_logs enable row level security;
alter table public.other_records enable row level security;
alter table public.exports enable row level security;
alter table public.notifications enable row level security;

-- 查詢：所有啟用中的帳號都能看（附件一角色表：各角色對掃描、複核、影像查詢至少可「看」）
create policy profiles_read on public.profiles for select to authenticated using (public.is_active_user());
create policy settings_read on public.settings for select to authenticated using (public.is_active_user());
create policy customers_read on public.customers for select to authenticated using (public.is_active_user());
create policy uploads_read on public.uploads for select to authenticated using (public.is_active_user());
create policy pages_read on public.pages for select to authenticated using (public.is_active_user());
create policy receipts_read on public.receipts for select to authenticated using (public.is_active_user());
create policy review_logs_read on public.review_logs for select to authenticated using (public.is_active_user());
create policy other_records_read on public.other_records for select to authenticated using (public.is_active_user());
create policy notifications_read on public.notifications for select to authenticated using (public.is_active_user());
-- 匯出：老闆、會計
create policy exports_read on public.exports for select to authenticated
  using (public.has_role('owner') or public.has_role('accountant'));
-- 參數設定、客戶主檔、裝置：只有老闆
create policy settings_write on public.settings for update to authenticated
  using (public.has_role('owner')) with check (public.has_role('owner'));
create policy customers_write on public.customers for all to authenticated
  using (public.has_role('owner')) with check (public.has_role('owner'));
create policy devices_read on public.devices for select to authenticated using (public.has_role('owner'));
create policy notifications_resolve on public.notifications for update to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
-- 收款的修改一律走下面的 review_receipt()／create_export()（security definer，裡面檢查角色並寫紀錄），前端不能直接 update
