-- Development projects: Notes tab = internal team chat with files. Never shown to suppliers.
create table if not exists public.dev_notes (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.dev_projects(id) on delete cascade,
  author       text,
  body         text,
  attachments  jsonb not null default '[]',   -- [{name,path,size,mime}]
  pinned       boolean not null default false,
  decision     boolean not null default false,
  edited_at    timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists dev_notes_project_idx on public.dev_notes (project_id, created_at);
alter table public.dev_notes enable row level security;
-- safe to run again (adds the columns if the table was created earlier)
alter table public.dev_notes add column if not exists pinned boolean not null default false;
alter table public.dev_notes add column if not exists decision boolean not null default false;
alter table public.dev_notes add column if not exists edited_at timestamptz;
