-- Per-PO shipping documents alert: Telegram switch and once-a-day marker.
alter table public.settings add column if not exists docs_telegram boolean not null default true;
alter table public.settings add column if not exists docs_reminded_on date;
