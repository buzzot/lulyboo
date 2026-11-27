-- Inspection messages (run once in Supabase → SQL Editor).
-- What the inspection company / supplier sent (emails to inspect@, or added by hand) and your answers
-- (Approve · Other date · Decline · Reply), plus the inspection company's own booking ID.
alter table public.inspections add column if not exists messages  jsonb not null default '[]';
alter table public.inspections add column if not exists their_ref text;
