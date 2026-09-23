-- ============================================================================
-- goodwhilly — drop the legacy per-owner global UPC uniqueness
-- Additive over 0001..0005. Idempotent: safe to re-run.
-- The original `items_upc_unique` constraint (`unique (owner_id, upc)` from
-- 0001) blocks any second row sharing a UPC — commander decks that share a
-- barcode (Final Fantasy) could never be tracked as separate rows. 0003 was
-- supposed to drop it but never ran on some databases. With 0005's name-aware
-- unique index in place, per-UPC identity is (owner, upc, box, normalized
-- name), so the global constraint is obsolete.
-- ============================================================================

alter table public.items
  drop constraint if exists items_upc_unique;

-- Defensive: in case a database carries it as a standalone index instead.
drop index if exists items_upc_unique;

-- Re-assert the name-aware uniqueness from 0005 (no-op when already present).
create unique index if not exists items_upc_loc_name_unique
  on public.items (owner_id, upc, coalesce(location_id::text, ''), lower(trim(name)))
  where upc is not null;