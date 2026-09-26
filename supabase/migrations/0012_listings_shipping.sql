-- 0012_listings_shipping.sql
-- Shipping cost of a synced eBay listing (parsed from GetMyeBaySelling's
-- ShippingDetails/ShippingServiceCost during sync). Used by the bundle
-- "fill price & shipping from eBay" flow.
-- Idempotent; apply before deploying the sync/parse code.

alter table public.listings add column if not exists shipping_cents int;
