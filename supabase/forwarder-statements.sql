-- Forwarder statements: upload a statement of account, every invoice is matched to a shipment and kept once
-- (forwarder + invoice no.). The next statement only updates paid / balance. Run once in the Supabase SQL Editor.
alter table public.freight_actuals add column if not exists forwarder_id uuid references public.forwarders(id) on delete set null;
alter table public.freight_actuals add column if not exists due_date     date;
alter table public.freight_actuals add column if not exists amount       numeric;
alter table public.freight_actuals add column if not exists paid         numeric;
alter table public.freight_actuals add column if not exists balance      numeric;
alter table public.freight_actuals add column if not exists currency     text default 'USD';
alter table public.freight_actuals add column if not exists file_no      text;     -- forwarder's job / file no. (OI-267440)
alter table public.freight_actuals add column if not exists mbl_no       text;
alter table public.freight_actuals add column if not exists booking_no   text;
alter table public.freight_actuals add column if not exists refs         text;     -- Ref column as printed ("PO#313, PO#314")
alter table public.freight_actuals add column if not exists payments     jsonb default '[]';   -- [{ date, ref, amount }]
alter table public.freight_actuals add column if not exists source       text default 'invoice'; -- invoice · statement
alter table public.freight_actuals add column if not exists statement_id uuid;
alter table public.freight_actuals add column if not exists updated_at   timestamptz;
create index if not exists freight_actuals_fwd_idx on public.freight_actuals (forwarder_id, invoice_no);

create table if not exists public.fwd_statements (
  id              uuid primary key default gen_random_uuid(),
  forwarder_id    uuid references public.forwarders(id) on delete set null,
  statement_date  date,
  status          text not null default 'review',   -- review · saved
  file            jsonb,                            -- { name, path, type, size }
  parsed          jsonb,                            -- what AI read: invoices, totals, checks
  created_by      text,
  created_at      timestamptz not null default now(),
  saved_at        timestamptz
);
create index if not exists fwd_statements_fwd_idx on public.fwd_statements (forwarder_id, created_at desc);
alter table public.fwd_statements enable row level security;
notify pgrst, 'reload schema';
