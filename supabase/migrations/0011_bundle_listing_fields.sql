-- 0011_bundle_listing_fields.sql
-- Actual Listing Price + Shipping Fee, captured when a bundle is marked
-- listed (editable afterwards). Both nullable — a bundle may be listed
-- before the numbers are known.
-- Idempotent; apply before deploying the code that writes these columns.

alter table public.bundles add column if not exists listing_price_cents int;
alter table public.bundles add column if not exists shipping_cents int;
