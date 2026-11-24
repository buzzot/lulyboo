-- Development: factory checklist per category (imported from "Factory Checklist - <Category>.xlsx"), copied onto each project; supplier answers per question.
-- Run once in Supabase → SQL Editor (safe to run again).

-- Catalog → Categories → Factory checklist
alter table public.categories add column if not exists checklist         jsonb not null default '[]';  -- [{key,name,section,type,options,req,req_label,hint}] type: file · choice · multi · text
alter table public.categories add column if not exists checklist_file    jsonb;                         -- {name,path,mime,bytes,at} the original Excel
alter table public.categories add column if not exists checklist_version int   not null default 0;

-- Each project keeps its own copy (switch items off, add its own)
alter table public.dev_projects add column if not exists category_id       uuid references public.categories(id) on delete set null;
alter table public.dev_projects add column if not exists checklist         jsonb not null default '[]';  -- same questions + on/custom
alter table public.dev_projects add column if not exists checklist_file    jsonb;
alter table public.dev_projects add column if not exists checklist_version int   not null default 0;

-- Supplier answers: {key: {value | value[] | na, details, status: yes|date|no|na (files), date, files:[{name,path,size,mime,at}], at}}
alter table public.dev_invitations add column if not exists doc_answers jsonb not null default '{}';

-- Link existing projects to their category by name (they then show "choose a category" only if none matches)
update public.dev_projects p set category_id = c.id
  from public.categories c
 where p.category_id is null and p.category is not null and lower(trim(p.category)) = lower(c.name);
