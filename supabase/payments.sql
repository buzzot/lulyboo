-- Supplier payments: installments from each PO's payment terms, reminders, weekly PDF reports, docs-to-broker.
create table if not exists public.po_payments (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid references public.suppliers(id) on delete cascade,
  po            text not null,
  no            int not null default 1,          -- installment number
  of_n          int,                             -- of how many
  pct           numeric not null,                -- percent of the order / invoice value
  trigger       text not null,                   -- po · before_shipment · bl · arrival · delivery · fixed
  offset_days   int not null default 0,          -- days after the trigger (negative = before)
  fixed_date    date,
  label         text,
  terms         text,                            -- the terms text the schedule came from
  po_date       date,                            -- PO date when set by hand (else: first import)
  amount        numeric,                         -- set by hand; null = pct × invoice / PO value
  status        text not null default 'open',    -- open · paid · cancelled
  paid_amount   numeric default 0,
  paid_at       date,
  paid_ref      text,
  paid_files    jsonb default '[]',
  snoozed_until date,
  log           jsonb default '[]',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
create index if not exists po_payments_sup_idx on public.po_payments (supplier_id, po);
alter table public.po_payments enable row level security;

create table if not exists public.payment_reports (
  id          uuid primary key default gen_random_uuid(),
  week_start  date, week_end date,
  path        text, name text,
  total       numeric, count int,
  sent_to     text, created_by text,
  created_at  timestamptz not null default now()
);
alter table public.payment_reports enable row level security;

alter table public.suppliers add column if not exists payment_terms text;          -- default terms for POs without their own
alter table public.plan_containers add column if not exists broker_docs_sent_at timestamptz;
alter table public.settings add column if not exists payment_remind_days int;
alter table public.settings add column if not exists broker_remind_days int;
alter table public.settings add column if not exists broker_email text;
alter table public.settings add column if not exists accountant_email text;
alter table public.settings add column if not exists report_to_accountant boolean not null default false;
alter table public.settings add column if not exists weekly_report boolean not null default true;
alter table public.settings add column if not exists report_weekday int;
alter table public.settings add column if not exists report_hour int;
alter table public.settings add column if not exists payments_reminded_on date;
alter table public.settings add column if not exists report_made_on date;
