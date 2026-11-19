-- Costs & rates: the last market check and a log of rate changes on each freight rate (logistics option).
alter table logistics_options add column if not exists market jsonb;      -- { rate, low, high, at, as_of, basis, confidence, source }
alter table logistics_options add column if not exists rate_log jsonb;    -- [{ at, by, from: manual|quote|market, old, new, note }]
notify pgrst, 'reload schema';
