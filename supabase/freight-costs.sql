-- Freight costs: charge list (with internal notes), offers added from files, actual costs from invoices.
create table if not exists public.charge_types (
  id            uuid primary key default gen_random_uuid(),
  code          text unique,
  name          text not null,
  grp           text not null default 'trucking',   -- port · customs · trucking · extra
  unit          text not null default 'container',  -- container · bl · entry · line · day · hour · pct_drayage · each · shipment
  when_applies  text not null default 'always',     -- always · if_needed
  rate_usd      numeric,                            -- default when no quote has it
  min_qty       numeric,                            -- e.g. 2 days minimum
  free_qty      numeric,                            -- e.g. 2 hours free
  aliases       text[] default '{}',                -- other names on quotes and invoices
  note          text,                               -- internal: what it is, when it applies, how to keep it low
  note_draft    boolean default false,
  market        jsonb,                              -- last AI market check { low, high, summary, sources, at }
  sort          int default 0,
  created_at    timestamptz not null default now()
);
alter table public.charge_types enable row level security;

-- offers added from a PDF / screenshot / pasted email live with the RFQ replies
alter table public.freight_quotes alter column quote_id drop not null;
alter table public.freight_quotes add column if not exists source      text default 'rfq';  -- rfq · pdf · image · email
alter table public.freight_quotes add column if not exists ref         text;
alter table public.freight_quotes add column if not exists cutoff      date;
alter table public.freight_quotes add column if not exists delivery_to text;
alter table public.freight_quotes add column if not exists files       jsonb default '[]';
alter table public.freight_quotes add column if not exists notes       text;

create table if not exists public.freight_actuals (
  id            uuid primary key default gen_random_uuid(),
  container_id  uuid references public.plan_containers(id) on delete set null,
  box           text,
  label         text,
  company       text,
  invoice_no    text,
  invoice_date  date,
  lines         jsonb default '[]',                 -- [{ name, usd, ocean }]
  files         jsonb default '[]',
  created_by    text,
  created_at    timestamptz not null default now()
);
alter table public.freight_actuals enable row level security;

alter table public.settings add column if not exists delivery_address text;   -- default drayage address
notify pgrst, 'reload schema';
