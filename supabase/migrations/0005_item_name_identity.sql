-- ============================================================================
-- goodwhilly — per-name item identity for shared-UPC products
-- Additive over 0001..0004. Idempotent: safe to re-run.
-- Products that share one barcode (e.g. Final Fantasy commander decks) must be
-- separate line items: a row's identity is now (owner, upc, location, name)
-- instead of (owner, upc, location). Same normalized name in the same box
-- still merges into one quantity.
-- ============================================================================

-- Replace the box-only uniqueness from 0003.
drop index if exists items_upc_unassigned_unique;
drop index if exists items_upc_location_unique;

-- One row per (owner, upc, box, name) for all sealed-with-barcode rows.
-- lower(trim(name)) so "Limit Break" and "limit break" collide (merge).
-- coalesce keeps NULL (unassigned) locations unique too.
create unique index if not exists items_upc_loc_name_unique
  on public.items (owner_id, upc, coalesce(location_id::text, ''), lower(trim(name)))
  where upc is not null;