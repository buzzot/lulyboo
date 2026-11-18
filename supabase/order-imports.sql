-- New POs by email (orders@<inbound domain>): what AI read, waiting under Import orders until you check and save it.
create table if not exists public.order_imports (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'pending',   -- pending · saved · discarded
  from_email   text,
  subject      text,
  supplier_id  uuid references public.suppliers(id) on delete set null,
  supplier_name text,                              -- the supplier named on the PO, as read
  matched_by   text,                               -- name on the PO · email … · chosen
  lines        jsonb default '[]',                 -- order lines as read by AI
  notes        jsonb default '[]',
  files        jsonb default '[]',                 -- {name, path, type, size, pos}
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   text
);
create index if not exists order_imports_status_idx on public.order_imports (status);
alter table public.order_imports enable row level security;
