-- Record-only shipments: kept for duty, costs, dates and POs, without tracking. Safe to run more than once.
alter table public.plan_containers add column if not exists record_only boolean not null default false;
alter table public.plan_containers add column if not exists record jsonb;
notify pgrst, 'reload schema';
