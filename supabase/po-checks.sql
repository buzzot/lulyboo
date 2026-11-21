-- PO totals check: the totals printed on a PO / PI (total qty, subtotal, number of lines), kept per supplier + PO.
-- The PO page compares the live lines with them; imports compare what AI read with them.
create table if not exists public.po_checks (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete cascade,
  po            text not null,
  total_qty     numeric,
  total_amount  numeric,
  currency      text default 'USD',
  line_count    int,
  lines         jsonb default '[]',   -- [{ sku, product, qty, amount }] as read, repeated SKUs added together
  file_name     text,
  read_ok       boolean,
  checked_at    timestamptz not null default now()
);
create index if not exists po_checks_supplier_po on public.po_checks (supplier_id, po);
alter table public.po_checks enable row level security;
