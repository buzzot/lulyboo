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

-- ───────────────────────── Information requests to suppliers (email, tracked by reference) ─────────────────────────
create table if not exists public.info_requests (
  id            uuid primary key default gen_random_uuid(),
  ref           text not null unique,                 -- e.g. LB-1001, put in the email subject so replies can be linked
  supplier_id   uuid not null references public.suppliers(id) on delete cascade,
  product_ids   uuid[] not null default '{}',
  items         text[] not null default '{}',         -- dieline, checklist, samples, certs, photos
  other_text    text,
  note          text,
  to_emails     text[] not null default '{}',
  cc_emails     text[] not null default '{}',
  subject       text not null,
  status        text not null default 'Sent' check (status in ('Sent','Replied','Complete','Closed')),
  email_id      text,                                 -- Resend id of the outgoing message
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists info_requests_supplier_idx on public.info_requests (supplier_id, created_at desc);
-- RFQs sent from outside the portal (e.g. the Hermes agent over Telegram/WhatsApp/WeChat) are logged as requests too.
alter table public.info_requests add column if not exists kind        text not null default 'info';   -- 'info' (sent from the portal) | 'rfq' (logged via the API)
alter table public.info_requests add column if not exists channel     text;                            -- Telegram, WhatsApp, WeChat, Email, ...
alter table public.info_requests add column if not exists contact     text;                            -- the handle or address it was sent to
alter table public.info_requests add column if not exists external_id text;                            -- the sender's own id, makes retries safe
create unique index if not exists info_requests_external_idx on public.info_requests (external_id) where external_id is not null;
create table if not exists public.info_request_messages (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.info_requests(id) on delete cascade,
  direction     text not null check (direction in ('out','in','note')),
  from_email    text,
  to_emails     text[] not null default '{}',
  subject       text,
  body          text,
  attachments   jsonb not null default '[]',
  created_at    timestamptz not null default now()
);
create index if not exists info_request_messages_idx on public.info_request_messages (request_id, created_at);
alter table public.info_requests         enable row level security;
alter table public.info_request_messages enable row level security;

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

-- ───────────────────────── CRM tasks (follow-ups, calls, meetings) ─────────────────────────
create table if not exists public.crm_tasks (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid references public.suppliers(id) on delete cascade,
  product_id      uuid references public.products(id) on delete set null,
  request_id      uuid references public.info_requests(id) on delete set null,
  title           text not null,
  notes           text,
  type            text not null default 'Follow-up'
                  check (type in ('Follow-up','Call','Email','Meeting','Sample','Visit','Other')),
  due_date        date not null,
  due_time        text check (due_time is null or due_time ~ '^[0-2][0-9]:[0-5][0-9]$'),   -- local time, HH:MM
  remind_minutes  integer not null default 15,       -- Telegram ping this many minutes before due_time
  reminded_at     timestamptz,
  done            boolean not null default false,
  done_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists crm_tasks_due_idx on public.crm_tasks(done, due_date);
create index if not exists crm_tasks_supplier_idx on public.crm_tasks(supplier_id);
alter table public.crm_tasks enable row level security;

-- Telegram reminders: paired chat, one-time pairing code, last daily digest date
alter table public.settings add column if not exists telegram_chat_id   text;
alter table public.settings add column if not exists telegram_pair_code text;
alter table public.settings add column if not exists crm_digest_date    date;

-- ───────────────────────── Integration API: audit log + supplier review flag ─────────────────────────
create table if not exists public.api_log (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  ip                text,
  key_label         text,            -- 'current' | 'next' | null (failed auth)
  endpoint          text not null,
  status            integer not null,
  ref               text,
  supplier_created  boolean,
  note              text
);
create index if not exists api_log_created_idx on public.api_log(created_at desc);
alter table public.api_log enable row level security;
alter table public.suppliers add column if not exists needs_review boolean not null default false;   -- created automatically, not yet checked by a person
alter table public.suppliers add column if not exists created_via  text;

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

-- Archive: hidden from the product lists (kept in the Archive page); NULL = active
alter table public.products add column if not exists archived_at timestamptz;
create index if not exists products_archived_idx on public.products(archived_at);

-- Source files of imports (the supplier's quotation spreadsheet), kept so it can be opened from the product / supplier pages
create table if not exists public.supplier_documents (
  id          uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  name        text not null,
  mime        text,
  bytes       bigint,
  path        text not null,
  kind        text not null default 'quotation',
  created_at  timestamptz not null default now()
);
create index if not exists supplier_documents_supplier_idx on public.supplier_documents(supplier_id);
alter table public.supplier_documents enable row level security;
alter table public.products add column if not exists source_document_id uuid references public.supplier_documents(id) on delete set null;
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='storage' and table_name='buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('supplier-documents','supplier-documents', false, 26214400)
    on conflict (id) do nothing;
  end if;
end $$;

-- Product documents (certificates, test reports, specifications) attached to one product
alter table public.supplier_documents add column if not exists product_id uuid references public.products(id) on delete cascade;
create index if not exists supplier_documents_product_idx on public.supplier_documents(product_id);

-- Original (verbatim) message text shown under "Show original message" in the Communication log
alter table public.info_request_messages add column if not exists original text;


-- ── Staff accounts and roles for the admin side ───────────────────────────
create table if not exists public.staff_users (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  username        text not null,
  email           text not null,
  role            text not null check (role in ('admin','director','manager')),
  password_hash   text,
  status          text not null default 'invited' check (status in ('invited','active','disabled')),
  must_change     boolean not null default false,
  session_version integer not null default 1,
  invite_hash     text,
  invite_expires  timestamptz,
  last_login      timestamptz,
  created_by      text,
  created_at      timestamptz not null default now()
);
create unique index if not exists staff_users_username_idx on public.staff_users (lower(username));
create unique index if not exists staff_users_email_idx on public.staff_users (lower(email));
alter table public.staff_users enable row level security;

create table if not exists public.staff_audit (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid,
  staff_name text,
  action     text not null,
  detail     text,
  created_at timestamptz not null default now()
);
create index if not exists staff_audit_created_idx on public.staff_audit (created_at desc);
alter table public.staff_audit enable row level security;

-- Who wrote a manual entry in a request's communication log
alter table public.info_request_messages add column if not exists author text;

-- ───────────────────────── Product development projects ─────────────────────────
-- One development project (spec + files) can be sent to several suppliers. Each supplier has a PRIVATE invitation
-- (thread, quote, status). Suppliers never see each other or the internal target price.
create table if not exists public.dev_projects (
  id               uuid primary key default gen_random_uuid(),
  ref              text not null unique,                 -- DP-1001
  name             text not null,
  category         text,
  status           text not null default 'Draft' check (status in ('Draft','Sourcing','Sampling','Testing','Pilot','Completed','On hold','Cancelled')),
  summary          text,                                 -- what the product is (shown to suppliers)
  requirements     text,                                 -- requirements, materials, dimensions, tolerances, packaging (shown)
  certifications   text,                                 -- standards the product must meet (shown)
  target_price_usd numeric(12,4),                        -- INTERNAL, never shown to suppliers
  target_moq       integer,                              -- INTERNAL
  internal_notes   text,                                 -- INTERNAL
  nda_required     boolean not null default false,
  nda_text         text,
  extra_fields     jsonb not null default '[]',          -- extra quote questions: [{key,label}]
  current_version  integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create table if not exists public.dev_spec_versions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.dev_projects(id) on delete cascade,
  version      integer not null,
  change_note  text,
  snapshot     jsonb not null default '{}',              -- summary/requirements/certifications at that version
  created_at   timestamptz not null default now(),
  unique (project_id, version)
);
create table if not exists public.dev_files (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.dev_projects(id) on delete cascade,
  name         text not null,
  kind         text not null default 'other',            -- drawing, image, spec, certificate, other
  label        text,                                     -- plain-language description shown instead of the file name
  mime         text,
  bytes        integer,
  path         text not null,
  version      integer not null default 1,               -- spec version it was added in
  controlling  boolean not null default false,           -- the controlling drawing
  internal     boolean not null default false,           -- hidden from suppliers
  created_at   timestamptz not null default now()
);
create table if not exists public.dev_invitations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.dev_projects(id) on delete cascade,
  supplier_id    uuid not null references public.suppliers(id) on delete cascade,
  status         text not null default 'Invited' check (status in ('Invited','Viewed','Questions','Quoted','Sample','Declined','Selected','Closed')),
  message        text,
  nda_accepted_at timestamptz,
  nda_accepted_by text,
  viewed_at      timestamptz,
  ack_version    integer not null default 0,             -- last spec version the supplier confirmed
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (project_id, supplier_id)
);
create table if not exists public.dev_messages (
  id             uuid primary key default gen_random_uuid(),
  invitation_id  uuid not null references public.dev_invitations(id) on delete cascade,
  direction      text not null check (direction in ('admin','supplier')),
  author         text,
  body           text,
  attachments    jsonb not null default '[]',            -- [{name,path,size,mime}]
  created_at     timestamptz not null default now()
);
create table if not exists public.dev_quotes (
  id             uuid primary key default gen_random_uuid(),
  invitation_id  uuid not null references public.dev_invitations(id) on delete cascade,
  revision       integer not null default 1,
  spec_version   integer not null default 1,
  currency       text not null default 'USD',
  incoterm       text,
  tiers          jsonb not null default '[]',            -- [{qty,price}]
  tooling_cost   numeric(12,2),
  tooling_lead_days integer,
  moq            integer,
  sample_cost    numeric(12,2),
  sample_lead_days integer,
  production_lead_days integer,
  validity_date  date,
  payment_terms  text,
  material_notes text,
  custom         jsonb not null default '[]',            -- [{label,value}] answers to the project's extra fields
  notes          text,
  attachments    jsonb not null default '[]',
  created_at     timestamptz not null default now()
);
create table if not exists public.dev_milestones (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.dev_projects(id) on delete cascade,
  invitation_id  uuid references public.dev_invitations(id) on delete cascade,  -- null = the whole project
  title          text not null,
  due_date       date,
  remind_days    integer not null default 2,             -- remind this many days before the due date
  done_at        timestamptz,
  reminded_at    timestamptz,
  overdue_notice_on date,
  sort           integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists dev_invitations_supplier_idx on public.dev_invitations (supplier_id);
create index if not exists dev_messages_inv_idx on public.dev_messages (invitation_id, created_at);
create index if not exists dev_milestones_due_idx on public.dev_milestones (due_date) where done_at is null;
alter table public.dev_projects enable row level security;
alter table public.dev_spec_versions enable row level security;
alter table public.dev_files enable row level security;
alter table public.dev_invitations enable row level security;
alter table public.dev_messages enable row level security;
alter table public.dev_quotes enable row level security;
alter table public.dev_milestones enable row level security;

-- Plain-language description for each project file (safe to run on an existing database)
alter table public.dev_files add column if not exists label text;
notify pgrst, 'reload schema';

-- Supplier business license (number, private file, AI check result)
alter table public.suppliers add column if not exists business_license_no text;
alter table public.suppliers add column if not exists business_license_path text;
alter table public.suppliers add column if not exists business_license_name text;
alter table public.suppliers add column if not exists license_info jsonb;
alter table public.suppliers add column if not exists license_checked_at timestamptz;
notify pgrst, 'reload schema';


-- ── Samples ───────────────────────────────────────────────
-- Samples: requests, shipping, tracking (DHL / FedEx / UPS APIs), costs, documents, evaluation
create table if not exists public.samples (
  id               uuid primary key default gen_random_uuid(),
  ref              text unique not null,                          -- SMP-1001
  title            text not null,
  supplier_id      uuid not null references public.suppliers(id) on delete cascade,
  project_id       uuid references public.dev_projects(id) on delete set null,
  invitation_id    uuid references public.dev_invitations(id) on delete set null,
  product_id       uuid references public.products(id) on delete set null,
  stage            text,                                          -- EVT, DVT, PVT, Golden sample...
  qty              integer,
  status           text not null default 'Requested',
  request_note     text,
  due_ship_date    date,                                          -- supplier should ship by
  confirmed_at     timestamptz,
  supplier_seen_at timestamptz,
  -- shipping
  carrier          text,                                          -- dhl | fedex | ups | other
  carrier_other    text,
  tracking_no      text,
  shipped_at       timestamptz,
  eta              timestamptz,
  delivered_at     timestamptz,
  signed_by        text,
  boxes            integer,
  weight_kg        numeric,
  declared_value   numeric,
  freight_by       text,                                          -- supplier | lulyboo | included
  -- tracking state (filled by the carrier poller)
  tracking_status  text,
  tracking_summary text,
  tracking_location text,
  tracking_error   text,
  last_event_at    timestamptz,
  last_checked_at  timestamptz,
  next_check_at    timestamptz,
  stall_alerted_at timestamptz,
  -- money
  currency         text not null default 'USD',
  sample_fee       numeric,
  freight_cost     numeric,
  duties           numeric,
  fee_paid_at      timestamptz,
  fee_refundable   boolean not null default false,
  -- evaluation
  eval_checks      jsonb not null default '[]'::jsonb,            -- [{label, result: pass|fail|null, note}]
  eval_notes       text,
  eval_score       integer,
  evaluated_at     timestamptz,
  eval_reminded_at timestamptz,
  -- reminders
  late_reminded_on date,
  late_reminders   integer not null default 0,
  internal_notes   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create table if not exists public.sample_events (
  id          uuid primary key default gen_random_uuid(),
  sample_id   uuid not null references public.samples(id) on delete cascade,
  at          timestamptz,
  code        text,                                               -- pre_transit, in_transit, customs, out_for_delivery, delivered, exception, note
  description text,
  location    text,
  source      text,                                               -- dhl | fedex | ups | supplier | admin | system
  key         text,                                               -- de-duplicates carrier events
  created_at  timestamptz not null default now()
);
create table if not exists public.sample_files (
  id          uuid primary key default gen_random_uuid(),
  sample_id   uuid not null references public.samples(id) on delete cascade,
  kind        text not null default 'other',                      -- proforma, waybill, invoice, photo, payment, other
  name        text not null,
  path        text not null,
  mime        text,
  bytes       integer,
  uploaded_by text,                                               -- admin | supplier
  created_at  timestamptz not null default now()
);
create index if not exists samples_supplier_idx on public.samples (supplier_id);
create index if not exists samples_next_check_idx on public.samples (next_check_at) where tracking_no is not null;
create index if not exists sample_events_sample_idx on public.sample_events (sample_id, at desc);
create unique index if not exists sample_events_key_idx on public.sample_events (sample_id, key);
create index if not exists sample_files_sample_idx on public.sample_files (sample_id);
alter table public.samples enable row level security;
alter table public.sample_events enable row level security;
alter table public.sample_files enable row level security;
notify pgrst, 'reload schema';

-- Development threads by email (run once): where a message came from and the original email
alter table public.dev_messages add column if not exists source text;   -- null = portal, 'email'
alter table public.dev_messages add column if not exists email jsonb;   -- {from, subject, message_id, text, original, summarized, language, questions, commitments}

-- Request log AI summaries (run once)
alter table public.info_request_messages add column if not exists ai jsonb;

-- Sailing schedules (run once): departures China → Los Angeles / Long Beach, from carrier APIs and forwarder schedules
create table if not exists public.sailings (
  id            uuid primary key default gen_random_uuid(),
  origin        text not null,                 -- UN/LOCODE: CNNGB, CNSHA, CNYTN, CNCAN
  destination   text not null,                 -- USLGB, USLAX
  carrier       text not null,                 -- COSCO, OOCL, CMA CGM, Matson …
  service       text,
  vessel        text,
  voyage        text,
  imo           text,
  etd           date not null,
  eta           date,
  transit_days  int,
  direct        boolean default true,
  via           text,                          -- transshipment port(s)
  cy_cutoff     date,
  doc_cutoff    date,
  source        text not null,                 -- api | file | email
  source_name   text,                          -- "CMA CGM API", forwarder name or file name
  batch         text,                          -- one upload / email, so it can be undone
  fetched_at    timestamptz default now(),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists sailings_etd_idx on public.sailings (etd);
create index if not exists sailings_batch_idx on public.sailings (batch);
alter table public.sailings enable row level security;

-- RFQ API: reserve a reference before the email is sent (run once)
alter table public.info_requests drop constraint if exists info_requests_status_check;
alter table public.info_requests add constraint info_requests_status_check check (status in ('Draft','Sent','Replied','Complete','Closed'));

-- Container planning (run once): open PO lines from supplier reports, grouped by port and week
create table if not exists public.plan_orders (
  id                uuid primary key default gen_random_uuid(),
  supplier_id       uuid not null references public.suppliers(id) on delete cascade,
  po                text not null,
  product           text,
  sku               text,
  qty               numeric,
  cartons           numeric,
  cbm               numeric,
  cbm_estimated     boolean default false,   -- from catalog carton size × cartons
  gross_kg          numeric,
  ready_date        date,
  inspection_date   date,
  inspection_note   text,                    -- e.g. "to be booked"
  production_status text,                    -- as the supplier wrote it
  pending_from_us   text,                    -- what the supplier waits for from Lulyboo
  order_type        text,                    -- New item / Repeat order
  approved_by       text,
  port              text,                    -- UN/LOCODE: CNNGB, CNSHA, CNYTN, CNCAN (null = to confirm)
  port_text         text,                    -- port as written
  notes             text,
  shipped           boolean not null default false,
  batch             text,
  source_name       text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index if not exists plan_orders_supplier_idx on public.plan_orders (supplier_id);
create index if not exists plan_orders_ready_idx on public.plan_orders (ready_date);
alter table public.plan_orders enable row level security;

-- Container planning documents (run once): POs, order reports, packing lists… linked to PO numbers
create table if not exists public.plan_files (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers(id) on delete cascade,
  name          text not null,
  path          text not null,              -- supplier-documents bucket
  size          bigint,
  content_type  text,
  kind          text,                       -- PO · Order report · Production status · Packing list · Invoice · Other
  pos           text[] default '{}',        -- PO numbers this file covers
  batch         text,
  uploaded_by   text,
  created_at    timestamptz default now()
);
create index if not exists plan_files_supplier_idx on public.plan_files (supplier_id);
alter table public.plan_files enable row level security;

-- Container load plans (run once): containers you build by dragging PO lines into them
create table if not exists public.plan_containers (
  id          uuid primary key default gen_random_uuid(),
  port        text not null,                    -- loading port UN/LOCODE (CNNGB …)
  box         text not null default '40GP',     -- 20GP · 40GP · 40HQ
  sailing_id  uuid references public.sailings(id) on delete set null,
  status      text not null default 'planned',  -- planned · requested · booked · shipped
  notes       text,
  created_by  text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists plan_containers_port_idx on public.plan_containers (port, status);
alter table public.plan_containers enable row level security;
alter table public.plan_orders add column if not exists container_id uuid references public.plan_containers(id) on delete set null;
create index if not exists plan_orders_container_idx on public.plan_orders (container_id);
alter table public.plan_containers add column if not exists request_to   text;          -- logistics company emailed
alter table public.plan_containers add column if not exists request_cc   text;
alter table public.plan_containers add column if not exists requested_at timestamptz;
alter table public.plan_containers add column if not exists request_body text;

-- Forwarders you ask for quotes, and their quotes per container (run once)
create table if not exists public.forwarders (
  id            uuid primary key default gen_random_uuid(),
  company       text not null,
  contact_name  text,
  email         text not null,
  cc            text,                         -- extra addresses, comma separated
  phone         text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
alter table public.forwarders enable row level security;
create table if not exists public.plan_quotes (
  id            uuid primary key default gen_random_uuid(),
  container_id  uuid not null references public.plan_containers(id) on delete cascade,
  forwarder_id  uuid references public.forwarders(id) on delete set null,
  code          text not null unique,         -- LBQ-XXXXX, in the subject so replies are matched
  company       text,
  to_email      text,
  sent_at       timestamptz,
  status        text not null default 'sent', -- sent · replied · chosen · declined
  currency      text,
  ocean_usd     numeric,
  total_usd     numeric,
  charges       jsonb default '[]',
  carrier       text,
  vessel        text,
  etd           date,
  eta           date,
  transit_days  int,
  cy_cutoff     date,
  valid_until   date,
  free_days     int,
  summary       text,
  notes         text,
  request_text  text,                         -- the email we sent (personalised)
  reply_from    text,
  reply_text    text,
  replied_at    timestamptz,
  files         jsonb default '[]',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists plan_quotes_container_idx on public.plan_quotes (container_id);
alter table public.plan_quotes enable row level security;

-- Packing per PO line (from POs / packing lists), used to calculate cartons and m³ from the order quantity (run once)
alter table public.plan_orders add column if not exists units_per_carton numeric;
alter table public.plan_orders add column if not exists carton_l_cm      numeric;
alter table public.plan_orders add column if not exists carton_w_cm      numeric;
alter table public.plan_orders add column if not exists carton_h_cm      numeric;
alter table public.plan_orders add column if not exists carton_gw_kg     numeric;

-- Cost per piece on PO lines (run once)
alter table public.plan_orders add column if not exists unit_price numeric;
alter table public.plan_orders add column if not exists currency   text;

-- Supplier holidays (CNY etc.) shown on the CRM calendar; suppliers confirm their schedule in the portal (run once)
create table if not exists public.supplier_holidays (
  id                  uuid primary key default gen_random_uuid(),
  supplier_id         uuid not null references public.suppliers(id) on delete cascade,
  year                int,
  name                text not null default 'Holiday',
  order_cutoff        date,          -- last day to order for shipment before the holiday
  order_cutoff_after  date,          -- order deadline for the first shipment after
  last_ship           date,          -- last shipment before
  first_ship          date,          -- first shipment after
  factory_from        date,
  factory_to          date,
  office_from         date,
  office_to           date,
  notes               text,
  source              text not null default 'lulyboo',   -- lulyboo · supplier
  file_path           text,
  file_name           text,
  file_mime           text,
  reminder_task_ids   jsonb default '[]',
  created_by          text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
create index if not exists supplier_holidays_sup_idx on public.supplier_holidays (supplier_id, year);
alter table public.supplier_holidays enable row level security;
alter table public.suppliers add column if not exists holidays_confirmed_year int;
alter table public.suppliers add column if not exists holidays_confirmed_at   timestamptz;
