# SESSION.md — handoff for the next agent

Last session: 2026-09-24 (5th session same day). Repo: goodwhilly (Next.js 15 + Supabase inventory app
for an MTG/eBay reseller). Read `AGENTS.md` first for full operating context;
this file records where the previous session left off.

## Current Objective

**Dominant-anchor bundle composition** (code complete, typecheck/lint/probe
green, **committed `7b6a1bf`, pushed**): `generateBundle` gained a
toggleable composition mode (default ON): each bundle anchors on one of the
top-5 priciest eligible items (sqrt(value)-weighted) and fills ONLY with
items worth ≤50% of that anchor; lines return anchor-first, fillers
value-desc. Unchecking the new builder checkbox ("One dominant item") sends
`dominant: false` and falls back to the old plain random mix. No DB change —
generation-time only. Probe-verified both modes (100% anchor-first, 100%
filler-tier compliance, 0 dup-rule violations at $50/$100/$150 fill targets).
Bundle duplicates shipped this session as `24de6a9`; discount as `89ac676`;
price history as `94528d0` (migration `0009` applied by the user).

## What We Did (this session)

1. **eBay multi-unit price filtering committed** (`cd862de`, pushed): QUANTITY/
   VARIANT pattern pools — see previous-session-style notes below.
2. **Date acquired feature shipped** (`6b08b6d`, pushed): nullable
   `items.acquired_at date` (`0008_item_acquired_at.sql` — **applied by the user
   in the SQL editor, verified via REST**: column exists, all rows backfilled,
   0 nulls); ItemForm "Date acquired" input (local-today default on add, edit
   prefill, null clears); POST/PATCH inventory accept + validate `YYYY-MM-DD`
   (`getDateOnly`/`todayDateOnly` in `api-helper.ts`, `localToday()` in
   `utils.ts`); scan creates stamp the scanner's local date (ScanClient sends
   it, server falls back to UTC). The quantity PATCH gap remains open.
3. **Dashboard upcoming releases committed** (`ba77fba`, pushed): removed the "Low stock (≤2)"
   block + `lowStock` computation from `src/app/(app)/page.tsx`; new
   "Upcoming releases" list in its place (date column · linked name · badge
   MTG/Secret Lair/Pokémon, `slice(0, 8)`, dated asc then TBA, empty/error/
   partial states), "Reserved in bundles" kept below per the user. New
   `src/lib/releases.ts` (`fetchUpcomingReleases()`, never throws): MTG from
   mtg.wiki `Category:Upcoming_releases` MediaWiki API (Infobox set only,
   `/`-subpages and books dropped, `{{start date and age}}` + plain-text date
   fallback), Pokémon from `press.pokemon.com` schedule table (regex parse,
   entity-decoded); parallel, per-source try/catch → `{releases, errors[]}`;
   6h in-memory cache (5 min when empty). Verified live via
   `npx tsx scripts/probe-releases.ts`: **13 rows, 0 errors** (Reality
   Fracture Oct 2 → Kamigawa Jun 2027, Delta Reign Nov 6, both Secret Lairs
   TBA).
4. **Item price history committed** (`94528d0`, pushed): see the historical
   file list in git; migration `0009` **applied by the user in the SQL
   editor** this session. Decisions: record on refresh **and** manual edits;
   **only on change** (first snapshot = baseline); UI = card sparkline +
   detail modal; `recordPriceHistory` never throws (missing table → warn).
5. **Bundle 10% discount** (`89ac676`, pushed): user's requirement —
   "prices are still too high… bundle $110 value into a $100 bundle", and
   "no one else should know about it than me and you". Semantics: wire
   `targetCents` = SELLING price; both bundle routes fill contents to
   `contentsTargetForPrice(price)` = price ÷ 0.9; displayed price always
   `bundlePriceCents(total)` = round(total × 0.9) (derived from actual
   contents → existing bundles also show 10% off). Buyer-facing surfaces
   untouched: listing drafts stay price-free (`dd4d7e2` respected), bundle
   name = game label, sales record gross you type yourself. No migration.
   (Committed this session as `89ac676`.)
6. **Bundle duplicates** (`24de6a9`, pushed): user rules — only
   items **under $20** may repeat, **max 5 of the same product per bundle**
   (bounded by stock); $20+ items at most once. `generateBundle` rewritten:
   per-item `maxUnits` cap enforced on every add-path (main draw,
   overshoot-diversion, fallback); draw weight = `sqrt(value) ×
   sqrt(remaining allowed units)` (capped/exhausted items drop out); trial
   tie-break now counts total units (soft ~8) instead of distinct lines (the
   old `|lines.size − 8|` actively suppressed duplicates). No API/DB/UI
   changes (`×N` + line totals already render). Verified with the new
   `scripts/probe-bundle-dupes.ts`: 56–71% of 200–500 bundles contain a dup
   line at $50/$100/$150 fill targets, **0 rule violations**, avg fill on
   target. (Commit message: quote the message with single quotes — it contains
   `$20`, which bash ate once → mangled `9f36ca8`, fixed via amend +
   `--force-with-lease`.)
7. **Dominant-anchor composition** (`7b6a1bf`, pushed): user request
   — bundle should start from one standout item + smaller fillers, with a
   toggle. `BundleGenOptions { dominant?: boolean }` (default true);
   `generateBundle` now routes to `dominantBundle` (top-5 sqrt(value)-weighted
   anchor, one unit, fillers ≤50% of anchor sqrt(value)-weighted and never
   past the window, anchor-first/value-desc line order, fallback = priciest
   anchor + largest-first fill without the tier cap) or the previous mix
   logic (`mixBundle`, behavior unchanged). Shared scoring extracted
   (`trialScore`, `toLines`, `lineTotal`); `buildBundleAcrossGames` takes +
   forwards `opts`. Both bundle routes read `body.dominant !== false`;
   `BundleBuilder.tsx` checkbox "One dominant item" (default checked) sent on
   generate + create. Nothing stored on the bundle. Probe now runs BOTH modes
   with anchor stats: dominant 100% anchor-first / 100% ≤50%-tier / ~51%
   anchor share; dup rules held everywhere.

## What We Did (previous session)

1. **`open` items priced like sealed** (`a4706e1`): the sealed-condition eBay
   pipeline now also runs for `open` kind items (they share the sealed UPC
   logic; opened boxes/boosters price on sealed listings). Trimmed the sealed
   single-hint list in `pricing.ts` (`PACKAGE_WORDS`/`SINGLE_HINTS`) so open
   box art stays correct.
2. **Product-art overhaul** (`af8942d`): word-boundary token matching
   (`titleMatches`/`requiredTokens`), `matchingPool` searches **GTIN first**
   (deck variants share a pack UPC, so the variant tokens narrow that pool) and
   only falls back to a `q` keyword search; `pickBestImage`/`scoreTitle` score
   sealed-package words (+1) vs loose-single hints (−2) on a lowercased title.
   `resolveNameImage`/`resolveVariantImage` now accept an optional `gtin`; the
   `searchActive` variant branch uses the GTIN-first pool. Routes pass
   `item.upc`. Added `scripts/probe-image-picks.ts` to debug the kept pool, and
   ran `npm run backfill-art` (kind `in.(sealed,open)`, passes `upc`): **29
   images updated, 0 failures**. Verified in the DB: Lord of the Rings ×2,
   Duskmourn: Endless Punishment, Secret Lair Cats of Chaos / Toby's Journey /
   Witch's Familiar / Garfield As Intended / Marvel Command Tower.
3. **"Browse active" bulk refresh** (`c0cf1eb`, widened `0dcdf5e`):
   `POST /api/inventory/refresh-price` now accepts `{ scope: "unpriced" }`,
   selecting sealed/open/loose rows where **`value_cents IS NULL OR
   image_url IS NULL`**, capped at 50, sequential with per-item try/catch and a
   per-`upc|name` dedupe cache, `export const maxDuration = 120`, upfront 409
   `EBAY_NOT_CONFIGURED`, returns `{ refreshed, failed, skipped, errors[] }`.
   **Manual values are never overwritten**: when the item already has
   `value_cents`, `withoutManualValue()` strips value/avg/price_source/sample
   count from the update (applied to cached dedupe replays too); a picture/name
   fill still lands. Button is in the Inventory header: "Browse active (N)",
   count uses the identical predicate, disabled at 0, driven by the header
   "Browse active" button in the grid. User reported it missing → it was a
   stale browser tab.
4. **Layout rearrangement** (`0dcdf5e`): desktop nav tabs (Inventory/Scan/
   Bundles/Sales/Listings/Settings) merged into the sticky "goodwhilly" header
   bar (middle segment, `overflow-x-auto`); removed the Inventory subtitle
   "Simple view for quick selling · Big pictures · No clutter"; moved the
   "N items · N units · inventory value $X" summary into the color-key card
   (dots left, summary right, wraps). Mobile hamburger + bottom bar unchanged.
5. **Scan ergonomics** (`b9aabc9`, `e0bd1c8`, `be0ef4a`): product/sub name
   fields now prefill from the saved inventory row for the scanned barcode
   (split on first `": "`; falls back to catalog name when no row exists;
   unknown barcodes clear instead of leaking the previous product's name).
   Quantity is a `−`/`+` stepper (1..99, buttons disabled while busy) instead
   of a number input. Quantity **always starts at 1**: resets on a new barcode
   lookup (`[upc]` effect) and after every successful add. (A localStorage
   "remember quantity" version was added then reverted at the user's request —
   do not bring back remembering.)

## Current State

- `origin/main` = `7b6a1bf` (dominant-anchor mode, pushed). Working tree
  **clean** — all this session's work (price history, discount, duplicates,
  dominant anchor) is committed.
- **Migration `0009` applied** (SQL editor by the user, this session). The
  price-history feature has not been browser-verified yet.
- `typecheck` + `lint` pass (run after the dominant-anchor change).
  **Probe verified**: `npx tsx scripts/probe-bundle-dupes.ts` → BOTH modes,
  dup rate 56–71%, dominant 100% anchor-first / 100% filler-tier, 0 violations
  at fill targets $55.56/$111.11/$166.67. **`npm run build` not run** — dev
  server is running in the user's foreground terminal; building would
  clobber `.next/` and 500 every dynamic route.
- Bundle discount + duplicates + dominant toggle NOT browser-checked yet. No
  browser check of price history either.
- Data: ~35 items (UI header showed "35 items · 49 units"). "Tarkir
  Dragonstorm: Temur Roar" is kind `other` again (restored after an earlier
  diagnosis flip); its art is still the multi-deck set-pack image — not fixed
  by backfill (kinds other/used excluded), user hasn't asked.
- Two "Lorwyn Eclipsed" rows (Bundle, Player Boosters) have `price_checked_at`
  set but `value_cents` null (eBay lookup came back empty). They now match the
  widened bulk predicate, so "Browse active" will retry them.

## Decisions Made

- **Bulk predicate = value/picture blank, not price_checked_at**: catches
  items that were checked but never priced, in line with the user's original
  wording ("don't have a price/picture"). Manual values protected per item
  (see `withoutManualValue`).
- **Names memory on scan = the saved inventory row** (user picked this over
  sticky last-typed): no cross-product leakage; multi-deck barcodes prefill
  the first row's name (the "Will save as…" preview shows what you're about to
  save).
- **Quantity is not remembered** (user reversed the earlier request twice):
  default 1 on new scan, resets to 1 after add. No localStorage involved.
- **Date acquired**: editable `YYYY-MM-DD` in the item form; scan-created rows
  stamp the scanner's local date (client sends `localToday()`, server falls
  back to UTC today); existing rows backfilled to `created_at::date`. In POST
  /api/inventory: an explicit `null` (form cleared) stays null; a caller that
  omits the field entirely gets today.
- **Canvas/stepper/min widths**: use Tailwind classes in `globals.css`;
  review built classes before editing.

## Files Changed (this session, committed as `7b6a1bf` = dominant-anchor)

- `src/lib/bundle.ts` — `BundleGenOptions { dominant? }` (default true);
  `generateBundle` routes to new `dominantBundle` (top-5 weighted anchor,
  ≤50%-of-anchor fillers, anchor-first/value-desc order, anchor+greedy
  fallback) or `mixBundle` (previous behavior, extracted); shared
  `trialScore`/`toLines`/`lineTotal`; `buildBundleAcrossGames(..., opts)`.
- `src/app/api/bundles/generate/route.ts`, `src/app/api/bundles/route.ts` —
  `const dominant = body?.dominant !== false;` passed as `{ dominant }`.
- `src/components/BundleBuilder.tsx` — `dominant` state (default true) +
  "One dominant item" checkbox under Include kinds; flag sent on generate +
  create.
- `scripts/probe-bundle-dupes.ts` — runs both modes; keeps hard dup/cap
  checks; adds dominant anchor stats (anchor-first %, fillers ≤50% %, avg
  anchor share).
- `AGENTS.md` — composition-modes bullet, probe/routes notes updated.
  `SESSION.md` — this file.

(Committed earlier this session: `94528d0` price history, `89ac676` bundle
discount, `24de6a9` bundle duplicates — see "What We Did" items 4–6.)

## Files Changed (previous session)

- `src/lib/ebay/pricing.ts` — word-boundary matching; `matchingPool`,
  `pickBestImage`/`scoreTitle` exported; GTIN-first pools; `resolveNameImage`/
  `resolveVariantImage` take optional `gtin`; `open` kind priced on
  sealed-condition listings; trimmed SINGLE_HINTS.
- `src/app/api/inventory/refresh-price/route.ts` — `priceOne` helper,
  `{ scope: "unpriced" }` bulk mode (value/picture predicate, cap 50, dedupe
  cache, per-item try/catch), `withoutManualValue`, `maxDuration = 120`.
- `src/app/api/ebay/price/route.ts` — `open`-kind price gate (sealed pipeline).
- `src/components/InventoryClient.tsx` — "Browse active (N)" header button +
  `unpricedCount`/`refreshUnpriced`; subtitle removed; summary merged into the
  color-key card; count predicate = `value_cents == null || !image_url`.
- `src/components/Nav.tsx` — tabs merged into the header row; standalone tab
  bar removed; `NavLink` got `px-2.5 whitespace-nowrap`.
- `src/components/ScanClient.tsx` — name/sub prefill from saved row;
  `−`/`+` quantity stepper; `setDelta(1)` on new barcode lookup and after add.
- `src/components/ItemForm.tsx` — UPC row shown for `open` kind (earlier sesh
  carryover into `a4706e1`).
- `scripts/probe-image-picks.ts` (new) — inspect kept pool for a name/gtin.
- `scripts/backfill-variant-art.ts` — covers `kind in.(sealed,open)`, passes
  `upc` to resolvers.
- `AGENTS.md` — updated: GTIN-first matching strategy, bulk refresh scope,
  open-kind pricing.
- `SESSION.md` — this file.

## Important Technical Details

- Commands: `npm run dev` / `typecheck` / `lint` / `build` / `db:types`.
  Verify every change with typecheck+lint; build only with dev stopped.
- Kinds: `sealed | loose | open | used | other` (`ITEM_KINDS`, `src/lib/utils.ts`).
  `open` uses the sealed eBay pricing/art pipeline; only `loose` prices via
  Scryfall; `used`/`other` are manual-only.
- Bulk refresh dedupe key = `upc|name`; item rows share a UPC+name merge
  smoothly; `normalizeName` (lower/trim) is the duplicate-compare convention.
- Money: cents on the wire/DB; `primaryCents` = p25 (25th pct of the
  IQR-trimmed pool) with median/mean fallback, every source.
  `withoutManualValue` protects only null/`manual` price_source — auto
  (browse_active/insights/scryfall) values refresh in place on row refresh.
  `price_checked_at` is set on every refresh even
  when no value is found (source `manual`).
- Marketplace Insights still 403 → auto fallback to `browse_active`.
- Script env pattern (Node 20): `supabase-js createClient` fails (no native
  WebSocket) — use raw REST headers `apikey`/`Authorization` and parse
  `.env.local` manually (see `scripts/backfill-variant-art.ts`).
- Route probes for sanity: dynamic `[id]` routes must return 401/405 JSON,
  never bare 500.

## Problems / Blockers

1. **Bundle discount + duplicates + dominant toggle not browser-exercised
   yet** — discount: generate a $100 preset → contents ≈ $111, price $100;
   create → detail/list show price · value; CSV has both rows; an old bundle
   shows price = value × 0.9. Duplicates: probe-verified (56–71% dup rate, 0
   violations); eyeball one real generate for `×N` lines on multi-copy
   under-$20 stock. Dominant: default-checked bundle leads with the priciest
   line; unchecking the box gives the old mix.
2. **Price history not browser-verified** (migration is in; check
   sparkline/modal after a refresh or manual value edit).
3. **Dashboard releases not visually checked in a browser** — code + probe
   verified; ask the user to load the dashboard.
4. **Latent bug, still NOT fixed:** `PATCH /api/inventory/[id]` ignores
   `quantity` — the edit form sends it but the route never puts it in `next`,
   so quantity edits silently don't persist. (`src/app/api/inventory/[id]/route.ts`.)
   (`acquired_at` now IS handled there; quantity still isn't.)
5. **`npm run build` not run this session** (blocked by the running dev server).
6. **Temur Roar art** (kind `other`) still shows the multi-deck set-pack image
   — browse_active already re-priced it; not backfilled (kinds other/used out
   of scope). Optional cleanup, ask the user.
7. Marketplace Insights access still pending eBay approval.
8. `EBAY_DEV_ID` still not set in Vercel (Trading-API listing sync).

## Next Steps (priority order)

1. Browser-verify the bundle discount + duplicates + dominant toggle and the
   price history sparkline (items under Problems 1–2).
2. Fix the `quantity` PATCH gap (route `[id]` ignores `quantity`; decide
   whether form quantity edits should reuse `adjust` semantics + movement
   ledger before coding).
3. Optional: resolve Temur Roar's art (or accept the pack image).
4. Stop dev → `npm run build` → confirm green → restart dev.
5. Before deploy: Vercel env (incl. `CRON_SECRET`, `EBAY_*`), optional
   `vercel.json` cron for `/api/cron/sync-ebay`.

## Do Not Forget

- **Never run `npm run build` while `npm run dev` is running** — clobbers
  `.next/`, breaks every dynamic `[id]` API route with a bare 500.
- Don't rewrite migrations `0001`–`0009`; add the next `0010_*.sql` (keep idempotent).
- Don't touch `ArtworkThumb`'s enlarged views (hover popover, modal lightbox,
  `s-l<N>` → `s-l1600`) or show `category` on cards — user said leave them.
- Split card names on **last `:`** for the bold sub-name display.
- No OCR/barcode guessing for single cards; only sealed UPCs are scanned.
- Cents everywhere; `*_cents` suffixes. Pin package versions; no new deps
  without a reason. Never store secrets in the repo.
- "subscribe to Go" in user messages = typo, ignore.
- Client fetch calls: parse `res.json()` defensively
  (`.catch(() => null)`) and always try/catch/finally so failures show as a
  visible error, not a silent no-op.