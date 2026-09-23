-- ============================================================================
-- goodwhilly — split stock across locations (per-area quantities)
-- Additive over 0001_init.sql + 0002_storage_locations.sql.
-- Enables one UPC to live in multiple boxes, each with its own quantity.
-- Idempotent: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Drop the (owner_id, upc) unique constraint so the same sealed product can
-- exist as separate item rows in different boxes. The partial unique indexes
-- below re-establish the invariants in a location-aware way.
-- ---------------------------------------------------------------------------
alter table public.items
  drop constraint if exists items_upc_unique;

-- ---------------------------------------------------------------------------
-- Unassigned rows: still exactly ONE row per (owner, upc) with no box, so
-- scanning keeps the "one entry + amount" behavior until you assign a box.
-- ---------------------------------------------------------------------------
create unique index if not exists items_upc_unassigned_unique
  on public.items (owner_id, upc)
  where upc is not null and location_id is null;

-- ---------------------------------------------------------------------------
-- Boxed rows: one row per (owner, upc, box), each carrying its own quantity.
-- Scanning the same UPC into multiple boxes now creates separate rows.
-- ---------------------------------------------------------------------------
create unique index if not exists items_upc_location_unique
  on public.items (owner_id, upc, location_id)
  where upc is not null and location_id is not null;
