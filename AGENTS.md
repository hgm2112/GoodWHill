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
| `EBAY_DEV_ID` | eBay Dev ID (required for Trading-API listing sync) |
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
    0001). Note: `0007_item_kinds_v2.sql` REMAPS the `item_kind` enum to
    `sealed | loose | open | used | other` (was sealed/bulk_cards/other);
    apply it before deploying code that sends `loose`. `0008_item_acquired_at.sql`
    adds `items.acquired_at` (date) + backfills from `created_at`; apply before
    deploying the date-acquired edit/scan code (inserts reference the column).
    `0009_item_price_history.sql` adds the `item_price_history` time-series
    table (price snapshots); apply it before relying on price history — until
    then snapshot writes warn + skip and the history endpoint 500s (the modal
    shows an error state, nothing else breaks).
    `0010_item_release_date.sql` adds `items.release_date` +
    `upc_catalog.release_date` (dates); apply it before deploying the
    release-date edit/scan code (inserts reference the column).
    `0011_bundle_listing_fields.sql` adds `bundles.listing_price_cents` +
    `bundles.shipping_cents` (nullable); apply it before the mark-listed
    panel (PATCH writes these columns).
    `0012_listings_shipping.sql` adds `listings.shipping_cents` (nullable
    int, parsed from GetMyeBaySelling); apply it before the bundle
    detail's "Fill from eBay" button — the fill route 404s without it.
  - Tables: `profiles`, `upc_catalog` (shared, any user may read/contribute),
    `items` (owner-scoped inventory incl. `item_kind` enum, `quantity`,
    `value_cents`, `acquired_at` date (editable in the item form; scan-created
    rows stamp the scan date), `release_date` date (the product's release —
    distinct from `acquired_at`), cached eBay price columns),     `item_movements` (ledger, one
    row per quantity change with a `reason`), `item_price_history` (owner-scoped
    time series of `value_cents` — one row per change + a first baseline,
    written by `recordPriceHistory`, cascade-deleted with the item),
    `bundles` (incl. `listing_price_cents` "Actual Listing Price" +
    `shipping_cents` "Shipping Fee", captured by the mark-listed panel and
    editable after; prefills Gross/Shipping in the sale form)/`bundle_items`,
    `allocations` (reserved stock), `listing_drafts`, `sales`, `listings`
    (synced eBay listings; `shipping_cents` parsed from the Trading-API
    `ShippingServiceCost`, 12/13 items carried it), `locations` (named storage
    boxes; `items` and
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
  - `POST /api/inventory/refresh-price` prices one item (`{ itemId }`) or
    everything without a value or picture (`{ scope: "unpriced" }` — sealed/open/loose,
    `value_cents IS NULL OR image_url IS NULL`, capped at 50, sequential with
    per-item try/catch and per-UPC|name lookup dedupe; bulk only ever fills
    blanks, never overwrites manual values — value/price fields are stripped
    from the update when the item already has a value). The Inventory header
    "Browse active (N)" button drives the bulk mode; scanned items arrive
    unpriced.
  - Quantity changes always create an `item_movements` row (reasons: add,
    remove, sale, reserve, release, adjust, import, return).
  - Inventory visibility: `GET /api/inventory` returns ALL owner rows (no
    `active`/`quantity` filter — the old `includeInactive` param is gone).
    The inventory grid hides `quantity = 0` rows behind a "Show out of stock
    (N)" toolbar toggle (revealed rows keep the red `×0` badge) and always
    shows paused rows — red ring + artwork overlay "PAUSED · hidden from
    store". Callers that care filter themselves: the sale-form dropdown and
    both bundle routes require `active AND quantity > 0`, and the scan page
    still shows out-of-stock rows (that's the restock signal).
  - Price changes always go through `recordPriceHistory`
    (`src/lib/price-history.ts`) on every `value_cents` write: refresh-price
    (single + bulk), `POST /api/inventory` (create), `PATCH /api/inventory/[id]`
    (when `value_cents` is sent), CSV-import creates. It inserts an
    `item_price_history` row **only when the value differs from the item's
    latest snapshot** (or none exists yet — the baseline) and never throws
    (a missing table/failed write just warns). Manual form edits record too;
    null values never snapshot. Single refresh responses carry `historyPoint`,
    bulk carries `historyPoints[]` so card sparklines update live. Read path:
    `GET /api/inventory/[id]/price-history` (oldest→newest, limit 500);
    the inventory page bulk-loads history (limit 5000) for card sparklines,
    and `PriceHistoryModal.tsx` renders the full chart + last-10 table on the
    card's "Price history" icon button.
  - Product release date (`items.release_date` + shared cache
    `upc_catalog.release_date`, `0010_item_release_date.sql`): the PRODUCT's
    release, distinct from `acquired_at`. Editable in the item form; shown as
    `Released {formatDate(...)}` on the inventory card (omitted when blank)
    and on the scan page's catalog card + matched rows. **Autofill fills
    BLANKS ONLY** (a manual entry always wins). Resolver:
    `resolveReleaseDate`/`resolveReleaseDateDetailed` in
    `src/lib/release-dates.ts` (used by the refresh-price route AND the
    probe) tries, in order — loose → the card's Scryfall `released_at`;
    `set_code` → `getSetReleaseDate`; `upc` → **`upc_catalog.release_date`**
    (seeded manually or cached from an earlier discovery; plain REST fetch,
    NOT `createAdminClient` — the realtime socket throws under plain Node/
    tsx scripts, so the resolver stays script-safe like the probes); sealed/
    open → **Secret Lairs via mtg.wiki** (`src/lib/secret-lair.ts`
    `lookupSecretLairDate`: membership-verified — the drop's name must appear
    verbatim on a `Superdrop|Drop Series|Commander Deck` page, `Secret
    Lair/…` hub subpages excluded, and ALL owning pages must agree on ONE
    date, else blank; never guesses), **Pokémon names via the official press
    schedule** (`/^pok[eé]mon/i` → `fetchPokemonSchedule()` exported from
    `releases.ts` — same `press.pokemon.com/…Schedule?period=All&types=3`
    regex the dashboard uses, but kept WITHOUT the past-date filter and
    shared under its own 6h cache; item tokens minus product words
    [booster/box/ETB/mega/evolution/…] must ALL appear in schedule rows and
    all matches must agree on ONE date, else blank — early-returns before
    Scryfall so a Pokémon name can never hit an MTG set), or else **product
    name → Scryfall set** (`findSetForProduct` in `scryfall.ts`: text before
    `:` minus retail words, exact-normalized → set-name-contains →
    token-subset tiers, token/promo/memorabilia/alchemy sets filtered,
    unique main-set candidate or blank; `Secret Lair*` names hard-excluded).
    eBay is NOT a date source (Browse search never returns item aspects; TCG
    listing details only carry a year-only "Year Manufactured"). Discovered
    dates cache on
    `upc_catalog.release_date` (`cacheCatalogReleaseDate`, blank-fill only)
    so one discovery serves every row + future scans with that barcode —
    the scan route inherits it on create and backfills blanks. Seeding the
    catalog works too: all three Topps Chrome barcodes (887521156788/832/870
    = *2025 Topps Chrome Football*, identity via eBay GTIN title, date
    2026-04-15 from ripped.topps.com) were seeded once and now resolve for
    every row + future scan. Bulk:
    `POST /api/inventory/refresh-price` `{ scope: "no_release_date" }`
    (≤50, per-product dedupe, prices untouched) — Inventory header button
    "Fill release dates (N)". Verify with
    `npx tsx scripts/probe-release-dates.ts --inventory` (runs the
    production resolver over every item, prints each pick + source for
    review; current data: 65/70 resolvable, 5 manual — Yu-Gi-Oh/Festival +
    genuinely ambiguous Secret Lairs; Pokémon sets + the Topps barcodes now
    automatic).
  - Sealed item identity is `(owner_id, upc, location_id, name)` (partial
    unique index `items_upc_loc_name_unique` in `0005_item_name_identity.sql`):
    products sharing a barcode (e.g. Final Fantasy commander decks) stay
    separate rows keyed by name; same full name + box merges. The catalog
    "main" name (resolved title or stable placeholder `Product <upc>`) is the
    unnamed row's name; the deck variant (`sub_name`) qualifies it into
    `<main>: <sub>`. Duplicate checks in `/api/scan`, `/api/inventory`,
    `/api/inventory/[id]`, and `/api/inventory/import` are name-aware and
    compare with `normalizeName` (`lower(trim())`, matching the index) so
    case-variant names merge instead of hitting a `23505`.
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
  `searchActive`: Browse API active-listing prices, estimated by the 25th
  percentile of the IQR-trimmed pool (`stats()` drops Tukey outliers —
  scalper asks high, junk listings low; asking prices are right-skewed).
  Single-barcode products are matched
  exactly by GTIN; deck variants (`"Set: Variant"` names — the shared-pack
  UPC cannot distinguish them, e.g. Commander Masters decks) are priced by a
  GTIN search narrowed by the variant tokens (falling back to a `q` keyword
  search when the GTIN pool is empty), filtered to listings whose titles carry
  the variant tokens and are condition-clean (no playmat/opened/promo/etc.).
  Returns no price (`source: none`) rather than cross-variant listings when
  nothing credible matches. `resolveVariantImage(name)` fetches the matching
  listing's box art for deck variants; the item carries that art while the
  shared UPC catalog keeps the generic pack image. Results are cached in
  `upc_catalog` / `items` (`ebay_avg_value_cents`, `ebay_median_value_cents`,
  `price_source`, `price_sample_count`, `price_checked_at`).
  `ebay_median_value_cents` is a legacy name — it stores the **p25**
  estimate (the value that `primaryCents` returns), not the median.
  `open`-kind items use this same sealed pipeline and ARE priced on
  sealed-condition listings.
  Name-based matching (`requiredTokens`/`titleMatches`/`keepMatching`) is
  word-boundary; when a UPC is known, `matchingPool` searches by GTIN first
  (shared barcodes are narrowed by the variant tokens) and only falls back to
  a keyword search. Box art is chosen by `pickBestImage` from the kept pool:
  titles are scored for sealed-package words (sealed/booster/edition/commander
  deck/drop/box/etc.) minus loose-single hints (collector numbers like
  "Farseek 2698", "single") so single-card listings never become product art.
  These flows are verified with `scripts/probe-image-picks.ts` and applied by
  `npm run backfill-art`.
- Own listings sync: `src/lib/ebay/listings.ts` `syncEbaysListings(userId)`
  uses the legacy Trading API `GetMyeBaySelling` (ActiveList) — the app is a
  legacy-granted app whose accounts list via the classic/website flow, so the
  Inventory API returns nothing and the Listings API scope (`sell.listings`) is
  not granted. The OAuth token rides in `<RequesterCredentials><eBayAuthToken>`
  and the App/Dev/Cert ID headers come from `EBAY_CLIENT_ID`/`EBAY_DEV_ID`/
  `EBAY_CLIENT_SECRET`. Results are paged and upserted into `listings`
  (`parseTradingItem` also extracts the first `ShippingServiceCost` into
  `listings.shipping_cents` — probe `scripts/probe-trading-shipping.ts`
  confirmed ActiveList carries it on 12/13 items).
  Triggered manually by users and via the daily `POST /api/cron/sync-ebay`
  (guarded by `CRON_SECRET`; `maxDuration: 120`).
- Match eBay listings to local items on `ebay_item_id`/`item_id` where
  possible — currently the `items`/`listings` linkage is best-effort (listings
  are displayed read-only). Bundles link deliberately via
  `bundles.ebay_listing_id` (the bundle detail's "eBay listing" card).
- eBay dev app prerequisites live outside the repo: register at
  developer.ebay.com for Client ID/Secret, production access, and a RuName.
  The app handles their absence gracefully.

## Scryfall

- `src/lib/scryfall.ts`: `searchCards` (query → cards), `autocomplete`,
  `lookupByIds`, `getCardByName` (fuzzy `cards/named`), `getSetReleaseDate`
  (set code → `released_at`), `findSetForProduct` (product name → set match
  for release dates; conservative, never guesses), `cardUsdCents`.
- Prices: sealed MTG product has no Scryfall price; bulk single cards do. A
  bulk card's `value_cents` comes from `prices.usd ?? usd_foil ?? usd_etched`.
- Single cards have no standard barcodes — do NOT attempt OCR. Only sealed
  product barcodes are scanned (`/api/scan`, `src/components/BarcodeScanner.tsx`).

## Release calendars

- `src/lib/releases.ts` `fetchUpcomingReleases()` powers the dashboard's
  "Upcoming releases" card: MTG (incl. Secret Lair) from mtg.wiki's
  `Category:Upcoming_releases` MediaWiki API (keeps `Infobox set` pages, drops
  subpages/books; undated pages show as TBA), and Pokémon from the official
  `press.pokemon.com` schedule table (regex-parsed HTML). Merged, dated rows
  ascending then TBA; each source in try/catch (partial results + `errors[]`);
  6h in-memory cache (5 min when empty). Never throws — dashboard degrades to
  an empty-state message. `scripts/probe-releases.ts` prints the parsed list.
  The Pokémon table parse is exported as `fetchPokemonSchedule()` (full
  `period=All` rows incl. past, own 6h cache) and shared with the release-date
  resolver; only `fetchPokemonReleases()` applies the `date < today` drop.

## Bundle generation

- `src/lib/bundle.ts` `generateBundle(items, targetCents, tolerance, opts?)` —
  seeded RNG, ±$15 absolute window (`BUNDLE_TOLERANCE_CENTS`), falls back to
  closest-under. The random seed comes from `Math.random()` per call, so
  "Regenerate" truly re-picks.
- **Composition modes** (`BundleGenOptions.dominant`, default `true`):
  **dominant** anchors each trial on one of the top-5 priciest eligible items
  (sqrt(value)-weighted) and fills ONLY with items worth ≤ 50% of that anchor
  (never overshooting the window); lines return **anchor-first, fillers
  value-descending**, and the fallback keeps the anchor but drops the tier cap.
  **`dominant: false`** = the plain value×stock random mix. Both bundle routes
  take a `dominant` body flag (server default on); the builder checkbox "One
  dominant item" sends it on generate + create. Generation-time only —
  nothing stored on the bundle.
- **Build around an item** (`BundleGenOptions.anchorItemId`): the generate
  route's `anchorItemId` forces one specific item into the bundle — it skips
  the 60%-of-target single-unit rule, pins the bundle to ITS game group (the
  route 409s `ANCHOR_GAME_MISMATCH` when an explicit `game` contradicts it,
  `ANCHOR_NOT_ELIGIBLE` when the eligibility query already excluded it:
  paused / out of stock / no value / kind not in Include), and an id absent
  from `items` yields an empty result (callers turn that into a 409). The
  `dominant` flag then picks the mode: `true` = **anchor mode** (every trial
  seeded with it, line 1, fillers ≤ 50% of it — `fixedAnchorIndex` replaces
  the top-5 draw), `false` = **include mode** (seeded into each plain-mix
  trial, position arbitrary; dup caps still apply to the extra units).
  Builder UI: "Build around item" select (live-filtered to current Include
  types + game choice, auto-clears when filters exclude it) swaps the
  dominant checkbox for two radios (Anchor it / Just include it). Only the
  generate route takes it — `POST /api/bundles` does not (the builder always
  persists previewed `lines`).
- **Duplicates** (`maxUnits` in `bundle.ts`, per user rules): items under $20
  may repeat — max 5 of the same product per bundle, bounded by stock; items
  $20+ appear at most once. Draw weight = `sqrt(value) × sqrt(remaining
  allowed units)`, so deep cheap stock repeats naturally while capped/
  exhausted items drop out of the draw. The trial tie-break counts total
  units (soft ~8-piece preference), not distinct lines. Verify with
  `npx tsx scripts/probe-bundle-dupes.ts` — runs **both modes** plus anchor
  scenarios (presence + first-line/tier for anchor mode, include-mode
  presence, 60% bypass with an oversized anchor) and exits non-zero on a rule
  violation.
- **Internal 10% bundle discount** (`BUNDLE_DISCOUNT_PCT`): the wire
  `targetCents` is the bundle's SELLING PRICE; the generate route converts it
  via `contentsTargetForPrice` (`price ÷ 0.9` — a $100 bundle packs ~$111 of
  value) before generating, and `target_value_cents` stores that contents-fill
  target (the create route does the same for its legacy no-`lines` path; with
  `lines` it stores the preview's `targetValueCents`). The price shown
  anywhere is always `bundlePriceCents(total)` =
  `round(total × 0.9)`, derived from the actual contents — so pre-existing
  bundles also display 10% off ("prices run a bit high"). Seller-facing only:
  builder preview, bundles list, detail header + contents card, CSV export —
  never in listing drafts/titles (`generateListingText` stays price-free by
  design) or anything else buyer-visible.
- `POST /api/bundles/generate` returns a non-persisting preview (client shows
  it; calling again re-randomizes; response carries `priceCents` alongside the
  fill `targetCents`). `POST /api/bundles` persists + reserves, and accepts
  `lines` (`{ itemId, quantity }[]`) + `targetValueCents` from the preview:
  with `lines` the bundle is stored EXACTLY as previewed (no re-roll — lines
  re-read from the DB for money, dup/stock/active rules re-checked, `409
  STALE_PREVIEW` if inventory moved), so preview == created. Without `lines`
  it falls back to generating a fresh bundle (legacy callers; `targetCents` ≥
  $5 required there). Both routes accept `dominant` (boolean, default true);
  the generate route additionally takes `anchorItemId` (see "Build around an
  item" above) — the create route does not.
- **Actual Listing Price / Shipping Fee** (`bundles.listing_price_cents` +
  `shipping_cents`, `0011_bundle_listing_fields.sql`): captured on the
  bundle detail page when marking listed — "Mark listed" opens a panel with
  the two `NumberDollars` inputs (price prefilled with the suggested
  `bundlePriceCents(total)`, shipping blank) and PATCHes
  `listingPriceCents`/`shippingCents` (null clears, must be integer ≥ 0
  cents) alongside `status`; once set, an info line shows both with an
  **Edit** button that re-saves without changing status. Display: detail
  info line + bundles list (the actual price replaces the derived price,
  `ship $Y` appended when set). The sale form prefills Gross/Shipping from
  these when that bundle is picked (still editable). CSV/drafts untouched.
  The info line also shows for `listed`/`sold` bundles even when both values
  are null (dashes + Edit), so the inputs are always reachable once listed.
- **Auto-fill from eBay** (`POST /api/bundles/[id]/ebay-fill`): the "eBay
  listing" card on the bundle detail links a synced `listings` row
  (`bundles.ebay_listing_id`) and fills Actual Listing Price + Shipping Fee
  from it — it runs `syncEbaysListings` first (best-effort; falls back to the
  last-synced row with `_synced: false` on eBay errors), 409s when the
  linked listing isn't active or has no price, and overwrites
  `shipping_cents` only when the listing carries one (null = keep stored).
  Status is never changed. When unlinked, the dropdown preselects the
  `(suggested)` listing matched from the bundle's listing-draft title
  (shared ≥ 2 meaningful words and ≥ 30% overlap, generic lot words
  dropped) — auto-suggest + confirm, never auto-applied. `PATCH
  /api/bundles/[id]` accepts `ebayListingId: null` to unlink (prices kept).
- `src/lib/bundle.ts` also exports `defaultBundleName`, `generateListingText`,
  and `bundleToCsv` ("Contents value" + "Bundle price (10% off)" rows).

## Working set / next steps

- Frontend: pages + clients for dashboard, inventory, scan, bundles (+ detail),
  sales, listings, and settings are written; wiring is via the API routes
  above.
- Verify with `npm run typecheck`, `npm run lint`, `npm run build`.
- Deployment: Vercel Hobby (1 daily cron). Set all env vars in Vercel,
  including `CRON_SECRET`; add the cron in `vercel.json` if a scheduled job is
  desired, else manual "Sync now" is sufficient.

## Gotchas

- **Never run `npm run build` while `npm run dev` is running** — both share
  `.next/`, and a production build clobbers the dev server's cache/manifests,
  which breaks every dynamic `[id]` API route with a bare 500 until the dev
  server is restarted. Run typecheck/lint during dev; run `build` only when the
  dev server is stopped (or on CI/Vercel).
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
- Client fetch calls `res.json()` can throw on non-JSON error bodies (bare 500s,
  proxies) — parse defensively (`res.json().catch(() => null)`) and always wrap
  the flow in try/catch/finally so failures surface as a visible error instead
  of a silent no-op.`