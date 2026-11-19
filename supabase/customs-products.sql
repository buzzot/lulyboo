-- Customs records on products: the duty rate actually paid on the latest import (from saved CBP 7501 entries).
-- Pricing uses it (after a manual override) instead of the AI estimate. Safe to run more than once.
alter table public.products add column if not exists duty_paid_pct   numeric;
alter table public.products add column if not exists duty_paid_at    date;
alter table public.products add column if not exists duty_paid_entry text;
notify pgrst, 'reload schema';
