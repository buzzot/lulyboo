-- Staff role "Development": edits Development projects and Samples; views Suppliers, RFQs and Products.
alter table public.staff_users drop constraint if exists staff_users_role_check;
alter table public.staff_users add constraint staff_users_role_check check (role in ('admin','director','manager','accountant','development'));
