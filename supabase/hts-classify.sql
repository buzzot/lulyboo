-- HTS classification per product (Product → Customs records → "HTS classification").
--   customs_description: AI-written description for customs / declarations (not shown in the catalog)
--   hts_review:          the last AI classification (candidates, fit, rates, duty per piece, sources)
--   hts_original_code:   the code before any change (declared on imports / supplier) — kept
--   hts_declare_code:    the checked code to declare from the next entry; hts_declare_pct its total rate
--   hts_checked_by/at:   who ticked "I checked" and saved it;  hts_rates_at: when the rates were last refreshed
alter table products add column if not exists customs_description text;
alter table products add column if not exists hts_review jsonb;
alter table products add column if not exists hts_original_code text;
alter table products add column if not exists hts_declare_code text;
alter table products add column if not exists hts_declare_pct numeric;
alter table products add column if not exists hts_checked_by text;
alter table products add column if not exists hts_checked_at timestamptz;
alter table products add column if not exists hts_rates_at timestamptz;
notify pgrst, 'reload schema';
