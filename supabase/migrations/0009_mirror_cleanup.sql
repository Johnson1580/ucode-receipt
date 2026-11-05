-- 透字判斷用的左右翻轉圖（pNNN_m.jpg）只在辨識時用到，用完就刪，長期只保存原圖（2026-10-20 使用者決定）。
-- 每月 2 萬頁（合約上限）保存 90 天：只存原圖約 16 GB，連翻轉圖一起存約 22.5 GB，會超過合約的 20 GB。
alter table public.pages add column mirror_deleted_at timestamptz;
create index pages_mirror_cleanup_idx on public.pages (processed_at) where mirror_deleted_at is null and status in ('done', 'failed');
