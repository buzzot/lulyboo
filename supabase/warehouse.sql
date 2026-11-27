-- Warehouse: delivery plan per container + the reminders already sent (run once in Supabase → SQL Editor).
alter table public.plan_containers add column if not exists delivery jsonb not null default '{}';   -- { lfd, port_appt, date, time, trucker, warehouse, resp_name, resp_email, status, updates, docs_asked, log }
alter table public.settings add column if not exists warehouse_sent jsonb not null default '[]';      -- Telegram digests sent (today:YYYY-MM-DD, tomorrow:…)
alter table public.settings add column if not exists warehouse_inbox jsonb not null default '[]';     -- delivery emails not matched to a container yet ("To assign")
