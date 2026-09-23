-- ============================================================================
-- goodwhilly — fix items.active default
-- The live DB drifted (items.active defaulted to false), so scan-created and
-- CSV-imported items were silently hidden (inventory/scan queries filter
-- active = true). Additive + idempotent over 0001_init.sql.
-- ============================================================================

alter table public.items
  alter column active set default true;