-- Lulyboo Supplier Portal — Supabase schema
-- Run in Supabase: Dashboard → SQL Editor → paste → Run. Safe to re-run.

create extension if not exists pgcrypto;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- ───────────────────────── Suppliers (CRM) ─────────────────────────
create table if not exists public.suppliers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  contact_name    text,
  email           text,
  phone           text,
  website         text,
  address         text,
  country         text,
  crm_status      text not null default 'Prospect'
                  check (crm_status in ('Prospect','Contacted','Quoting','Active','On hold','Blocked')),
  rating          smallint check (rating between 1 and 5),
  categories_supplied text,
  notes           text,
  next_follow_up  date,
  active          boolean not null default true,   -- portal access allowed for this supplier's users
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
drop trigger if exists suppliers_touch on public.suppliers;
create trigger suppliers_touch before update on public.suppliers
for each row execute function public.touch_updated_at();

alter table public.suppliers add column if not exists registered_at timestamptz;

-- ───────────────────────── Supplier user accounts ─────────────────────────
-- Login identity = email. Flow: invite link → emailed code → company registration + password.
create table if not exists public.supplier_users (
  id                 uuid primary key default gen_random_uuid(),
  supplier_id        uuid not null references public.suppliers(id) on delete cascade,
  email              text not null,                 -- stored lower-case
  name               text,
  password_hash      text,                          -- scrypt; null until registration
  status             text not null default 'invited' check (status in ('invited','active','disabled')),
  invite_token_hash  text unique,                   -- sha256 of invite-link token; cleared after registration
  invite_expires_at  timestamptz,
  session_version    integer not null default 1,    -- bump to sign the user out everywhere
  last_login_at      timestamptz,
  created_at         timestamptz not null default now()
);
create unique index if not exists supplier_users_email_idx on public.supplier_users (email);
create index if not exists supplier_users_supplier_idx on public.supplier_users (supplier_id);

create table if not exists public.auth_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.supplier_users(id) on delete cascade,
  purpose     text not null check (purpose in ('invite','reset')),
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists auth_codes_user_idx on public.auth_codes (user_id, purpose, created_at desc);

create table if not exists public.supplier_activities (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid not null references public.suppliers(id) on delete cascade,
  activity_date   date not null default current_date,
  type            text not null default 'Note'
                  check (type in ('Call','Email','WeChat/WhatsApp','Meeting','Factory visit','Sample','Quote','Note')),
  summary         text not null,
  follow_up_date  date,
  done            boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists supplier_activities_supplier_idx on public.supplier_activities(supplier_id, activity_date desc);

-- ───────────────────────── Categories ─────────────────────────
create table if not exists public.categories (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,
  default_hs_code     text,
  default_duty_pct    numeric(6,3),       -- US import duty %, verify per HS code
  target_margin_pct   numeric(6,2),       -- Lulyboo gross margin target on wholesale price
  notes               text,
  sort                integer not null default 0,
  created_at          timestamptz not null default now()
);
insert into public.categories (name, target_margin_pct, sort) values
  ('Infant/Toddler', 45, 1), ('Pet', 45, 2), ('Home', 40, 3), ('Other', 40, 9)
on conflict (name) do nothing;

-- ───────────────────────── Products ─────────────────────────
create table if not exists public.products (
  id                      uuid primary key default gen_random_uuid(),
  supplier_id             uuid not null references public.suppliers(id) on delete cascade,

  -- Supplier-provided (matches the bulk upload template)
  product_name            text not null,
  supplier_sku            text,
  category                text,             -- categories.name
  subcategory             text,
  description             text,
  materials               text,
  product_size_cm         text,
  unit_net_weight_kg      numeric(10,3),
  packaging_type          text,
  certifications          text,
  hs_code                 text,
  country_of_origin       text,
  dangerous_goods         text,
  currency                text not null default 'USD',
  unit_price              numeric(12,4),
  incoterm                text,
  fob_port                text,
  payment_terms           text,
  moq                     integer,
  sample_lead_days        integer,
  production_lead_days    integer,
  quote_valid_until       date,
  suggested_retail_usd    numeric(12,2),
  units_per_inner         integer,
  units_per_carton        integer,
  carton_l_cm             numeric(8,2),
  carton_w_cm             numeric(8,2),
  carton_h_cm             numeric(8,2),
  carton_nw_kg            numeric(10,3),
  carton_gw_kg            numeric(10,3),
  supplier_qty_20gp       integer,
  supplier_qty_40gp       integer,
  supplier_qty_40hq       integer,
  photo_link              text,
  factory_notes           text,

  -- Lulyboo review & pricing fields (never shown to suppliers)
  status                  text not null default 'New'
                          check (status in ('New','Reviewing','Shortlisted','Sample requested','Selected','Rejected')),
  target_stores           text[] not null default '{}',
  planned_qty             integer,          -- order quantity used for LCL/air costing (defaults to MOQ)
  logistics_option_id     uuid,             -- preferred option for this product (defaults to settings)
  duty_rate_pct           numeric(6,3),     -- overrides category / global default
  our_wholesale_usd       numeric(12,2),
  our_retail_usd          numeric(12,2),
  score                   smallint check (score between 1 and 5),
  review_notes            text,

  source                  text not null default 'form',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
-- Drafts: saved by the supplier but not yet submitted; hidden from the admin views until submitted.
alter table public.products add column if not exists is_draft boolean not null default false;
alter table public.products add column if not exists submitted_at timestamptz;
create index if not exists products_supplier_idx on public.products(supplier_id);
create index if not exists products_status_idx   on public.products(status);
create index if not exists products_category_idx on public.products(category);
drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
for each row execute function public.touch_updated_at();

alter table public.products add column if not exists brand text;
alter table public.products add column if not exists is_draft boolean not null default false;
alter table public.products add column if not exists submitted_at timestamptz;

-- Duty research (admin only): USITC HTS lookup + AI. duty_rate_pct stays the admin's manual override and wins over duty_ai_pct.
alter table public.products add column if not exists hts_verified_code text;
alter table public.products add column if not exists duty_ai_pct numeric(6,3);
alter table public.products add column if not exists duty_ai_detail jsonb;
alter table public.products add column if not exists duty_ai_checked_at timestamptz;
alter table public.settings add column if not exists china_extra_tariff_pct numeric(6,3) not null default 0; -- blanket extra tariff on China-origin goods (admin-entered)

-- ───────────────────────── Images ─────────────────────────
create table if not exists public.product_images (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products(id) on delete cascade,
  path         text not null,       -- full-size WebP, max 1600 px
  thumb_path   text not null,       -- thumbnail WebP, max 400 px
  bytes        integer not null,    -- full + thumb
  width        integer,
  height       integer,
  sort         integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists product_images_product_idx on public.product_images(product_id, sort);

-- ───────────────────────── Logistics options ─────────────────────────
-- mode: FCL_20GP / FCL_40GP / FCL_40HQ  → rate_usd per container
--       LCL                             → rate_usd per CBM (W/M: 1 t = 1 CBM)
--       AIR                             → rate_usd per chargeable kg (volumetric ÷ 6000)
--       EXPRESS                         → rate_usd per chargeable kg (volumetric ÷ 5000)
create table if not exists public.logistics_options (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  mode                   text not null check (mode in ('FCL_20GP','FCL_40GP','FCL_40HQ','LCL','AIR','EXPRESS')),
  origin                 text,
  destination            text,
  rate_usd               numeric(12,2) not null,
  min_charge_usd         numeric(12,2) not null default 0,
  fees_per_shipment_usd  numeric(12,2) not null default 0,   -- customs broker, drayage, port/terminal fees…
  transit_days           integer,
  valid_until            date,
  active                 boolean not null default true,
  notes                  text,
  sort                   integer not null default 0,
  created_at             timestamptz not null default now()
);
insert into public.logistics_options (name, mode, origin, destination, rate_usd, fees_per_shipment_usd, transit_days, sort)
select * from (values
  ('China → LA/LB · 40HQ FCL', 'FCL_40HQ', 'Ningbo / Shenzhen', 'Los Angeles / Long Beach', 3800::numeric, 1500::numeric, 30, 1),
  ('China → LA/LB · 40GP FCL', 'FCL_40GP', 'Ningbo / Shenzhen', 'Los Angeles / Long Beach', 3500, 1500, 30, 2),
  ('China → LA/LB · 20GP FCL', 'FCL_20GP', 'Ningbo / Shenzhen', 'Los Angeles / Long Beach', 2500, 1300, 30, 3),
  ('China → LA · LCL',         'LCL',      'Ningbo / Shenzhen', 'Los Angeles',              95,   650,  35, 4),
  ('China → LAX · Air',        'AIR',      'Shanghai / Shenzhen','LAX',                     6.5,  350,  7,  5)
) v(name, mode, origin, destination, rate_usd, fees_per_shipment_usd, transit_days, sort)
where not exists (select 1 from public.logistics_options);

-- ───────────────────────── Settings (single row) ─────────────────────────
create table if not exists public.settings (
  id                         smallint primary key default 1 check (id = 1),
  default_logistics_option_id uuid,
  default_duty_pct           numeric(6,3) not null default 0,
  default_target_margin_pct  numeric(6,2) not null default 40,
  insurance_pct              numeric(6,3) not null default 0.3,     -- % of goods value
  fx_to_usd                  jsonb not null default '{"USD":1,"CNY":0.14,"EUR":1.08,"HKD":0.128,"VND":0.000039,"INR":0.012}',
  updated_at                 timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;
update public.settings
   set default_logistics_option_id = (select id from public.logistics_options where mode = 'FCL_40HQ' order by sort limit 1)
 where id = 1 and default_logistics_option_id is null;

-- ───────────────────────── AI analyses ─────────────────────────
create table if not exists public.ai_analyses (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('product_review','similar','compare','category_match')),
  title         text,
  product_ids   uuid[] not null default '{}',
  category      text,
  model         text,
  result        jsonb not null,
  input_tokens  integer,
  output_tokens integer,
  created_at    timestamptz not null default now()
);
create index if not exists ai_analyses_created_idx on public.ai_analyses(created_at desc);
create index if not exists ai_analyses_products_idx on public.ai_analyses using gin(product_ids);

-- Storage usage summary
create or replace view public.storage_usage
with (security_invoker = true) as
select count(*)::int as image_count, coalesce(sum(bytes),0)::bigint as total_bytes
from public.product_images;

-- ───────────────────────── Security ─────────────────────────
-- The Node server uses the secret / service-role key (bypasses RLS).
-- RLS with no policies keeps the public anon key from reading anything.
alter table public.suppliers           enable row level security;
alter table public.supplier_activities enable row level security;
alter table public.categories          enable row level security;
alter table public.products            enable row level security;
alter table public.product_images      enable row level security;
alter table public.logistics_options   enable row level security;
alter table public.settings            enable row level security;
alter table public.ai_analyses         enable row level security;
alter table public.supplier_users      enable row level security;
alter table public.auth_codes          enable row level security;

-- Newer Supabase projects don't expose SQL-created tables to the API automatically.
-- Grant access to the server's secret (service_role) key only; anon/authenticated get nothing.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- ───────────────────────── Storage bucket ─────────────────────────
-- Private bucket; the server hands out short-lived signed URLs.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='storage' and table_name='buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('product-images','product-images', false, 10485760, array['image/webp'])
    on conflict (id) do nothing;
  end if;
end $$;
