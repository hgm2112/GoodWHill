-- Date the item was acquired. Shown/edited in the item edit form; rows created
-- by a scan stamp the scan date. Nullable (no reliable date for old imports).
alter table public.items add column if not exists acquired_at date;

-- Backfill: the date the row was first added is the best-known acquisition date.
update public.items
set acquired_at = (created_at at time zone 'utc')::date
where acquired_at is null;
