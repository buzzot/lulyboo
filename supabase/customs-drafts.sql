-- Customs drafts: our own CBP 7501 for a shipped container / LCL shipment, before the broker files.
-- Run once in the Supabase SQL editor.
create table if not exists customs_drafts (
  id uuid primary key default gen_random_uuid(),
  container_id uuid not null unique references plan_containers(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,       -- header, items (classification per product), lines, totals
  notes jsonb not null default '{}'::jsonb,      -- importer's notes for the AI, per product id
  compare jsonb,                                 -- our draft vs the broker's 7501, per product
  built_at timestamptz, built_by text,
  correction_sent_at timestamptz, correction_to text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table customs_drafts enable row level security;
notify pgrst, 'reload schema';
