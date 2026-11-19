-- Freight rate history: run once in the Supabase SQL editor (same as the "Freight rate history" block in schema.sql).
-- Freight rate history (run once): a permanent copy of every priced forwarder quote, for comparing
-- forwarders and prices on the same lane and container type. Kept when containers are deleted.
create table if not exists public.freight_quotes (
  id            uuid primary key default gen_random_uuid(),
  quote_id      uuid unique,                          -- plan_quotes.id (no FK: the quote can be deleted)
  container_id  uuid references public.plan_containers(id) on delete set null,
  forwarder_id  uuid references public.forwarders(id) on delete set null,
  company       text,
  code          text,                                 -- LBQ-XXXXX
  quoted_on     date not null,
  pol           text not null,                        -- loading port, UN/LOCODE
  pod           text not null default 'LALB',         -- LALB = Los Angeles / Long Beach, else UN/LOCODE
  box           text not null,                        -- 20GP · 40GP · 40HQ · LCL
  cbm           numeric,
  kg            numeric,
  wm            numeric,                              -- LCL freight tons (W/M)
  currency      text,
  ocean_usd     numeric,
  total_usd     numeric,                              -- all-in
  per_wm        numeric,                              -- LCL all-in per W/M
  charges       jsonb default '[]',
  carrier       text,
  vessel        text,
  etd           date,
  eta           date,
  transit_days  int,
  valid_until   date,
  free_days     int,
  reply_hours   int,
  chosen        boolean not null default false,
  excluded      boolean not null default false,       -- left out of the comparison
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists freight_quotes_lane_idx on public.freight_quotes (pol, pod, box, quoted_on);
alter table public.freight_quotes enable row level security;
notify pgrst, 'reload schema';
