-- Product release/street date — when the product came out, NOT when we
-- acquired it (that's items.acquired_at). Nullable: entered manually or
-- autofilled from a Scryfall set/card date; blanks stay blank.
alter table public.items add column if not exists release_date date;

-- Shared per-UPC cache so one discovery serves every row (and future scans)
-- with that barcode. Same fill rules: only ever written when a date is found,
-- never cleared.
alter table public.upc_catalog add column if not exists release_date date;
