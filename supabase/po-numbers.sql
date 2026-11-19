-- PO numbers as the number only: "PO900018", "PO#900018", "P.O. 900018" → "900018".
-- Only values that start with PO followed by a digit are changed. Safe to run more than once.

create or replace function pg_temp.po_num(v text) returns text language sql immutable as $$
  select case when v ~* '^\s*P\.?\s*O\.?\s*(#|no\.?|num(ber)?\.?)?\s*[:#–-]?\s*[0-9]'
              then btrim(regexp_replace(v, '^\s*P\.?\s*O\.?\s*(#|no\.?|num(ber)?\.?)?\s*[:#–-]?\s*', '', 'i'))
              else v end
$$;

update public.plan_orders        set po  = pg_temp.po_num(po) where po <> pg_temp.po_num(po);
update public.po_payments        set po  = pg_temp.po_num(po) where po <> pg_temp.po_num(po);
update public.plan_files         set pos = (select array_agg(distinct pg_temp.po_num(x)) from unnest(pos) x) where exists (select 1 from unnest(pos) x where x <> pg_temp.po_num(x));
update public.ship_confirmations set pos = (select array_agg(distinct pg_temp.po_num(x)) from unnest(pos) x) where exists (select 1 from unnest(pos) x where x <> pg_temp.po_num(x));
update public.customs_entries    set pos = (select array_agg(distinct pg_temp.po_num(x)) from unnest(pos) x) where exists (select 1 from unnest(pos) x where x <> pg_temp.po_num(x));

-- check: anything still starting with PO + digit (should return no rows)
select 'plan_orders' as t, po from public.plan_orders where po ~* '^\s*P\.?\s*O\.?\s*[#:–-]?\s*[0-9]'
union all select 'po_payments', po from public.po_payments where po ~* '^\s*P\.?\s*O\.?\s*[#:–-]?\s*[0-9]';
