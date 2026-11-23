-- Quality inspections before shipping (run once in Supabase → SQL Editor).
-- Every open PO gets one by default: request → scheduled → confirmed (inspector + supplier, 7 days before)
-- → report → your Pass / Fail → invoice → paid.

create table if not exists public.inspection_companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text,                        -- where requests go (booking@…)
  cc            text,                        -- more addresses, comma separated
  contact       text,
  phone         text,
  man_day_usd   numeric,                     -- usual price per inspection day
  default_aql   text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
alter table public.inspection_companies enable row level security;

create table if not exists public.inspections (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null,                 -- LBI-XXXX, in every email subject
  supplier_id       uuid not null references public.suppliers(id) on delete cascade,
  pos               jsonb not null default '[]',    -- PO numbers inspected
  container_id      uuid,
  company_id        uuid references public.inspection_companies(id) on delete set null,
  type              text not null default 'psi',    -- psi · dupro · loading · audit
  status            text not null default 'todo',   -- todo · requested · scheduled · confirmed · report · passed · failed · skipped · cancelled
  target_date       date,                           -- suggested (ready date − 3 days)
  inspection_date   date,
  aql               text,
  confirm_days      int not null default 7,
  req_file_id       uuid,                           -- testing requirements sent (plan_files)
  req_version       int,
  request_sent_at   timestamptz,
  confirm_sent_at   timestamptz,
  inspector_confirm text,                           -- asked · confirmed · issue
  inspector_note    text,
  supplier_confirm  text,
  supplier_note     text,
  proposed_date     date,
  reminded_at       timestamptz,
  ai                jsonb,                          -- what AI read from the report
  decision          text,                           -- pass · fail · pass_notes
  decision_note     text,
  decided_at        timestamptz,
  decided_by        text,
  fee_quoted        numeric,
  invoice_no        text,
  invoice_amount    numeric,
  invoice_due       date,
  invoice_file_id   uuid,
  paid_at           date,
  paid_by           text,
  paid_ref          text,
  paid_files        jsonb not null default '[]',
  log               jsonb not null default '[]',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
create index if not exists inspections_supplier_idx on public.inspections (supplier_id);
alter table public.inspections enable row level security;

-- reports, invoices and requirement files are PO documents linked to their inspection
alter table public.plan_files add column if not exists inspection_id uuid;
-- a trusted factory: no inspection alert for its POs
alter table public.suppliers add column if not exists inspection_off boolean not null default false;
alter table public.settings add column if not exists inspections_digest_on date;
