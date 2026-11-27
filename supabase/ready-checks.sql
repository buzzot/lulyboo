-- Ready-to-ship confirmations (run once in Supabase → SQL Editor).
-- One email per supplier 5 days before shipping: confirm the ready date + inspection date.
-- Replies (subject LBR-XXXXX) are read by AI; a new date waits for you to apply it. See src/readycheck.js.

create table if not exists public.ready_checks (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,          -- LBR-XXXXX, in the email subject
  supplier_id       uuid not null references public.suppliers(id) on delete cascade,
  kind              text not null default 'check', -- check (automatic / Send now) | followup (quick status update)
  items             jsonb not null default '[]',   -- [{ line_id, po, product, sku, qty, ready_date, ship_date, container_id }]
  pos               text[] not null default '{}',
  ship_date         date,                          -- earliest shipping date asked about
  status            text not null default 'sent',  -- sent | confirmed | changed | replied | applied
  sent_at           timestamptz,
  sent_to           text,
  cc                text,
  subject           text,
  asks              jsonb not null default '[]',   -- the questions in the email
  reminders         int not null default 0,
  last_reminded_at  timestamptz,
  reply_at          timestamptz,
  reply_from        text,
  reply_text        text,
  facts             jsonb not null default '{}',   -- { ready_ok, new_date, per_po, inspection_date, summary }
  log               jsonb not null default '[]',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists ready_checks_supplier_idx on public.ready_checks (supplier_id, created_at desc);
alter table public.ready_checks enable row level security;
