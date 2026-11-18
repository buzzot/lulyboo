-- Payments: choose where each reminder goes (all on by default).
alter table public.settings add column if not exists payment_telegram boolean not null default true;
alter table public.settings add column if not exists payment_email    boolean not null default true;
alter table public.settings add column if not exists broker_telegram  boolean not null default true;
alter table public.settings add column if not exists report_telegram  boolean not null default true;
