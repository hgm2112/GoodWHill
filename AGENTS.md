# goodwhilly

A login-protected inventory app for an MTG/eBay reseller. Tracks sealed
product (scanned by barcode), bulk loose cards (Scryfall-priced), and other
stock; records sales; syncs the seller's own eBay active listings; autofills
sealed-product values from eBay; and generates random ~$50/$100/$150/$200
"mystery bundles" from in-stock inventory that reserve stock and produce an
editable eBay listing draft.

Built by an AI agent for a solo seller. This file is the shared operating
context for the agent — read it before working here.

## Commands

```bash
npm install
npm run dev          # local dev (needs .env.local, see below)
npm run lint         # eslint .
npm run typecheck    # tsc --noEmit
npm run build        # next build (must pass before deploy)
npm run seed         # optional: seed a few known UPC catalog rows
npm run db:types     # regenerates Supabase TS types when you have the CLI + a linked project
```

- Tailwind v4 via `@tailwindcss/postcss`, Tailwind `@import "tailwindcss"` only.
  Shared component classes (`.input`, `.btn`, `.card`, `.badge-*`, `.table-*`)
  live in `src/app/globals.css` under `@layer components`.
- Styling rules added in `globals.css` apply only when a class is present on
  the element (`.input:has(~ button)` etc. can affect siblings). When editing
  Tailwind, check the built classes in `src/app/globals.css` and use dynamic
  selectors there.
- `next/no-img-element` is enforced; use `// eslint-disable-next-line @next/next/no-img-element` when rendering remote images (Scryfall/eBay), as the repo does everywhere.
- Pin package versions. Don't add new deps without a reason.

## Env / config

Copy `.env.local.example` → `.env.local`. Keys:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key for browser client |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only, bypasses RLS (admin client) |
| `SUPABASE_PROJECT_ID` | used by `supabase` CLI / db:types |
| `APP_URL` | e.g. `http://localhost:3000` |
| `CRON_SECRET` | guard for `/api/cron/*` |
| `EBAY_CLIENT_ID` | eBay App ID |
| `EBAY_CLIENT_SECRET` | eBay cert |
| `EBAY_RUNAME` | registered RuName — also the OAuth `redirect_uri` |
| `EBAY_ENV` | `prod` or `sandbox` |
| `EBAY_TOKEN_ENCRYPTION_KEY` | 64 hex chars; AES-256-GCM for stored eBay tokens. Falls back to plaintext with a `console.warn` if unset (dev only). |

## Architecture

- Next.js 15 App Router. `src/app/(auth)/*` = login/signup; `src/app/(app)/*` =
  the app (dashboard, inventory, scan, bundles, sales, listings, settings),
  wrapped by a layout that redirects unauthenticated users.
- `src/middleware.ts` guards pages only (skips `/api`). Every API route
  re-auths via `authUser()` (see below).
- Supabase:
  - Browser: `src/lib/supabase/client.ts`; Server components/route
    handlers: `src/lib/supabase/server.ts`; Bypass-RLS admin (tokens, cron,
    seeds): `src/lib/supabase/admin.ts`.
  - Schema + RLS + triggers in `supabase/migrations/0001_init.sql`. Apply via
    the Supabase SQL editor or `supabase db push`. Keep the migration
    idempotent when adding edits (add new `0002_*.sql` files, don't rewrite
    0001).
  - Tables: `profiles`, `upc_catalog` (shared, any user may read/contribute),
    `items` (owner-scoped inventory incl. `item_kind` enum, `quantity`,
    `value_cents`, cached eBay price columns), `item_movements` (ledger, one
    row per quantity change with a `reason`), `bundles`/`bundle_items`,
    `allocations` (reserved stock), `listing_drafts`, `sales`, `listings`
    (synced eBay listings), `locations` (named storage boxes; `items` and
    `profiles` reference one via `location_id`/`default_location_id`, FK
    `ON DELETE SET NULL`), `ebay_tokens` (service-role ONLY — no RLS policy
    for app roles).

### API conventions

- `src/lib/api-helper.ts`: `authUser()` (returns `{ supabase, user }` or null),
  `apiError(message, status, extra)`, `getIntParam`, `getCents`, `readJson`,
  `jsonOk`.
- Cents everywhere on the wire and in the DB for money (`*_cents`). Convert
  with `centsToUsd` / `usdToCents` in `src/lib/utils.ts`.
- Responses use plain `NextResponse.json`; errors use `apiError` with a
  caller-facing `error` string. Some places include a `code` (e.g.
  `EBAY_NOT_CONFIGURED`, `EBAY_NOT_CONNECTED`).
- Money paths to keep correct:
  - `POST /api/bundles` reserves stock and decrements item quantities; on any
    failure it rolls back and deletes the bundle.
  - `POST /api/sales` deducts stock (or marks a bundle sold); `DELETE
    /api/sales/[id]` restores it.
  - `DELETE /api/bundles/[id]` releases allocations and restores stock
    (`releaseAllocations` in the route).
  - Quantity changes always create an `item_movements` row (reasons: add,
    remove, sale, reserve, release, adjust, import, return).
  - Sealed item identity is `(owner_id, upc, location_id, name)` (partial
    unique index `items_upc_loc_name_unique` in `0005_item_name_identity.sql`):
    products sharing a barcode (e.g. Final Fantasy commander decks) stay
    separate rows keyed by name; same full name + box merges. The catalog
    "main" name (resolved title or stable placeholder `Product <upc>`) is the
    unnamed row's name; the deck variant (`sub_name`) qualifies it into
    `<main>: <sub>`. Duplicate checks in `/api/scan`, `/api/inventory`,
    `/api/inventory/[id]`, and `/api/inventory/import` are name-aware.
  - `POST /api/scan` finds/creates the item for `(owner, upc, box, name)`
    where `name` is the request `name` or the catalog main name (resolved
    title or placeholder `Product <upc>`) for unnamed scans; then adds `delta`
    stock. When the catalog main name changes, placeholder rows (old name or
    `Product <upc>`) are backfilled to merge unnamed scans into one row.
  - `POST /api/scan/name` names ONE inventory row (`{ upc, item_id,
    product_name?, sub_name? }`): `product_name` sets the shared catalog main
    name (defaults: existing catalog name, else eBay GTIN resolve); `sub_name`
    is the deck variant and composes the full item name
    `${product_name}: ${sub_name}` (no sub → just the main name). 409 if
    another item already has that full name in the same box.

## eBay integration

- OAuth flow: `/api/ebay/connect` → user consents → `/api/ebay/callback` (verifies
  `state` cookie) → tokens exchanged, encrypted with AES-256-GCM
  (`encryptSecret`/`decryptSecret` in `src/lib/ebay/oauth.ts`) and stored in
  `ebay_tokens`. `getUserAccessToken` auto-refreshes when expired.
- Price lookup for sealed product (`src/lib/ebay/pricing.ts`):
  `lookupSealedPrice(upc, name?)` tries the Marketplace Insights
  `/buy/marketplace_insights/v1_beta/item_sales/search` (real 90-day sold
  data; restricted, errors until free access is approved) and falls back to
  Browse API `/buy/browse/v1/item_summary/search?filter=gtin:<upc>` active-
  listing prices (an estimate from `price.median`/`price.value`). Results are
  cached in `upc_catalog` / `items` (`ebay_avg_value_cents`,
  `ebay_median_value_cents`, `price_source`, `price_sample_count`,
  `price_checked_at`).
- Own listings sync: `src/lib/ebay/listings.ts` `syncEbaysListings(userId)`
  pulls `GET /sell/listings/v1/listing?status=ACTIVE` and upserts the
  `listings` table with defensive shape-parsing (eBay responses change shape).
  Triggered manually by users and via the daily `POST /api/cron/sync-ebay`
  (guarded by `CRON_SECRET`; `maxDuration: 120`).
- Match eBay listings to local items on `ebay_item_id`/`item_id` where
  possible — currently the `items`/`listings` linkage is best-effort (listings
  are displayed read-only).
- eBay dev app prerequisites live outside the repo: register at
  developer.ebay.com for Client ID/Secret, production access, and a RuName.
  The app handles their absence gracefully.

## Scryfall

- `src/lib/scryfall.ts`: `searchCards` (query → cards), `autocomplete`,
  `lookupByIds`, `getCardByName` (fuzzy `cards/named`), `cardUsdCents`.
- Prices: sealed MTG product has no Scryfall price; bulk single cards do. A
  bulk card's `value_cents` comes from `prices.usd ?? usd_foil ?? usd_etched`.
- Single cards have no standard barcodes — do NOT attempt OCR. Only sealed
  product barcodes are scanned (`/api/scan`, `src/components/BarcodeScanner.tsx`).

## Bundle generation

- `src/lib/bundle.ts` `generateBundle(items, targetCents, tolerance)` — seeded
  RNG, tolerates ±5%, falls back to closest-under. The random seed comes from
  `Math.random()` per call, so "Regenerate" truly re-picks.
- `POST /api/bundles/generate` returns a non-persisting preview (client shows
  it; calling again re-randomizes). `POST /api/bundles` persists + reserves.
- `src/lib/bundle.ts` also exports `defaultBundleName`, `generateListingText`,
  and `bundleToCsv`.

## Working set / next steps

- Frontend: pages + clients for dashboard, inventory, scan, bundles (+ detail),
  sales, listings, and settings are written; wiring is via the API routes
  above.
- Verify with `npm run typecheck`, `npm run lint`, `npm run build`.
- Deployment: Vercel Hobby (1 daily cron). Set all env vars in Vercel,
  including `CRON_SECRET`; add the cron in `vercel.json` if a scheduled job is
  desired, else manual "Sync now" is sufficient.

## Gotchas

- `cookies()`/`supabase.auth` in Server Components make pages dynamic — build
  succeeds but pages render on request. Don't try to statically prerender user
  data.
- The supabase server client reads cookies from the request; in route handlers
  it must be created inside the handler.
- `quantity` on `items` is an absolute count. "Adjust" changes it by a delta and
  records the movement. Sales/bundles/cancellations all go through the same
  accounting (see API conventions).
- Never store secrets in the repo. `.env.local` is gitignored; tokens are
  encrypted with `EBAY_TOKEN_ENCRYPTION_KEY`.