-- Product development costs (moulds, tooling, samples, testing…) and milestones, for statistics:
-- spread over a planned quantity to show a gross factory price. Run once in the Supabase SQL editor.
create table if not exists product_dev_costs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  supplier_id uuid,
  cost_date date,
  title text not null,
  kind text not null default 'mould',          -- mould | samples | testing | design | other
  status text not null default 'quoted',       -- quoted | paid | refunded
  amount numeric(12,2) not null default 0,     -- USD
  paid_at date,
  pay_ref text,
  notes text,
  mould_owner text,                            -- e.g. Lulyboo / supplier
  mould_location text,
  refund_after integer,                        -- supplier refunds the mould after this many pcs
  files jsonb not null default '[]'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_dev_costs_product on product_dev_costs(product_id);

create table if not exists product_dev_milestones (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  ms_date date not null,
  title text not null,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists product_dev_milestones_product on product_dev_milestones(product_id);

alter table products add column if not exists dev_plan_units integer;
alter table products add column if not exists dev_count text not null default 'placed';   -- placed | shipped
alter table products add column if not exists dev_include_quoted boolean not null default true;

alter table product_dev_costs enable row level security;
alter table product_dev_milestones enable row level security;
notify pgrst, 'reload schema';
