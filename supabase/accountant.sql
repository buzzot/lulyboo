-- Accountant account type, supplier bank details, "signed" PO files, who paid.
-- Safe to run more than once.

-- 1. Allow the new role
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.staff_users'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.staff_users drop constraint %I', c);
  end loop;
end $$;
alter table public.staff_users add constraint staff_users_role_check check (role in ('admin','director','manager','accountant'));

-- 2. Supplier bank details (shown to Admin, Director and Accountant; the account number is masked)
alter table public.suppliers add column if not exists bank_beneficiary text;
alter table public.suppliers add column if not exists bank_name        text;
alter table public.suppliers add column if not exists bank_swift       text;
alter table public.suppliers add column if not exists bank_account     text;
alter table public.suppliers add column if not exists bank_address     text;

-- 3. A PO file can be ticked as the signed copy
alter table public.plan_files add column if not exists signed boolean not null default false;

-- 4. Who recorded the payment
alter table public.po_payments add column if not exists paid_by text;

notify pgrst, 'reload schema';
