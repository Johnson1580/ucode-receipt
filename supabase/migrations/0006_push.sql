-- 通知改成「系統畫面＋手機推播」（2026-10-16 使用者決定，不用 LINE）
-- level：alert＝異常（系統畫面上方紅色提醒，處理後消失）；info＝一般消息（例：某批辨識完成，只推播、不留在畫面上）
alter table public.notifications add column level text not null default 'alert' check (level in ('alert', 'info'));
alter table public.notifications add column url text;   -- 點推播後開啟的頁面

-- 每支手機／每個瀏覽器一筆推播訂閱
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
grant select, insert, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;
create policy push_own_read on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid() and public.is_active_user());
create policy push_own_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_user());
create policy push_own_delete on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());
