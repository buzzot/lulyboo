-- Shipment confirmations (run once): one request per supplier per shipment on the loading date, the documents
-- the supplier sends back (plan_files.shipment_id), and the actual figures you accepted (kept for stats).
create table if not exists public.ship_confirmations (
  id              uuid primary key default gen_random_uuid(),
  code            text unique not null,               -- LBS-XXXXX, in the email subject
  token           text unique not null,               -- supplier upload link /ship/<token>
  supplier_id     uuid not null references public.suppliers(id) on delete cascade,
  container_id    uuid references public.plan_containers(id) on delete set null,
  mode            text,                               -- FCL · LCL · '' (no container plan)
  pos             text[] default '{}',
  order_ids       uuid[] default '{}',
  due_date        date,                               -- the day the request goes out (loading date)
  new_date        date,                               -- new date reported by the supplier / set by you
  status          text not null default 'scheduled',  -- scheduled · sent · received · complete · cancelled
  sent_at         timestamptz,
  sent_to         text,
  reminders       int default 0,
  last_reminded_at timestamptz,
  confirmed_at    timestamptz,
  received_at     timestamptz,
  loaded_on       date,
  container_no    text,
  seal_no         text,
  bl_no           text,
  planned         jsonb,                              -- planned figures per line when the request went out
  facts           jsonb,                              -- what the documents say (AI / supplier form)
  actual          jsonb,                              -- accepted totals, for stats
  reply_text      text,
  accepted_at     timestamptz,
  accepted_by     text,
  log             jsonb default '[]',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index if not exists ship_confirmations_supplier_idx on public.ship_confirmations (supplier_id);
create index if not exists ship_confirmations_container_idx on public.ship_confirmations (container_id);
alter table public.ship_confirmations enable row level security;
alter table public.plan_files add column if not exists shipment_id uuid references public.ship_confirmations(id) on delete set null;
alter table public.plan_containers add column if not exists loading_date date;
alter table public.plan_containers add column if not exists container_no text;
alter table public.plan_containers add column if not exists seal_no text;
