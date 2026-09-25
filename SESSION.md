# SESSION.md — handoff for the next agent

Last session: 2026-09-25 (new day; prior 5 sessions were 2026-09-24). Repo: goodwhilly (Next.js 15 + Supabase inventory app
for an MTG/eBay reseller). Read `AGENTS.md` first for full operating context;
this file records where the previous session left off.

## Current Objective

**Product release date** (code complete, typecheck/lint green, probe-verified
**59/70 resolvable**, **NOT yet committed**): `items.release_date` — when the
PRODUCT came out, distinct from `acquired_at`. Migration
`supabase/migrations/0010_item_release_date.sql` (adds `items.release_date` +
shared `upc_catalog.release_date`) **is already applied** — verified via REST
(column returns, all null). Display: editable in the item form, `Released Jun
13, 2025` on inventory cards / scan catalog card / matched rows (`formatDate`,
omitted when blank). Autofill fills BLANKS ONLY.

**Why nothing was filling (diagnosed + fixed this session):** the resolver
had only two sources — loose-card Scryfall date (0 loose items exist) and
`set_code` (0 of 70 items have one) — so every lookup returned null. Also
confirmed live: eBay can NEVER be a source (Browse search returns no
`localizedAspects` at all; TCG listing details only have year-only
"Year Manufactured"). The fix (implemented):

1. **`findSetForProduct`** (`scryfall.ts`) — product name → Scryfall set
   match (6h `/sets` cache): before-`:` product line minus retail words;
   exact-normalized → set-name-contains → token-subset tiers;
   token/promo/memorabilia/alchemy sets filtered; unique main-set candidate
   or blank; `Secret Lair*` hard-excluded (their `sld` date is 2019).
   Prototype caught three wrong-match traps that are now guarded: CLB→1994
   Legends, Commander Masters→Masters 25, SL drops→`sld 2019`.
2. **`lookupSecretLairDate`** (`secret-lair.ts`) — mtg.wiki membership-
   verified: drop name searched as phrase with `intitle:"Secret Lair"`,
   title gated to `Superdrop|Drop Series|Commander Deck` (`Secret Lair/…`
   hub subpages like the "Drop Series" index — which carries an unrelated
   2025-10-29 date and poisoned early runs — excluded), phrase must appear
   verbatim in the page wikitext, and **all owning pages must agree on
   exactly one date** (else blank: e.g. "Command Tower" is reprinted across
   7 superdrops → correctly left blank). 6h wikitext/phrase caches (negatives
   cached too) keep a 50-item bulk fill ~10-20s.
3. **`resolveReleaseDate`/`resolveReleaseDateDetailed`** live in
   `src/lib/release-dates.ts` (shared by route + probe): loose card →
   set_code → SL-wiki or set match.
4. **Probe**: `npx tsx scripts/probe-release-dates.ts --inventory` runs the
   production resolver over every item and prints each pick + source.
   **Result: 59/70** (set_name=34, secret_lair=25); 11 manual = Pokémon×3,
   Topps×3, Yu-Gi-Oh, Festival in a Box, plus 3 genuinely ambiguous Secret
   Lairs (Lasagna Food Token, Command Tower, Inked Foil Edition). Every pick
   eyeballed: set dates all correct; SL pages spot-checked verbatim in page
   context (e.g. "Back in my day!" confirmed inside the Two Scoops superdrop
   table).

## What We Did (this session)

1. **Product release date feature** (Current Objective — uncommitted;
   file list in its own section below): schema `0010`, item form field
   (`ItemForm` "Released" input + `CardSearchInput`/scryfall search surfacing
   `released_at` prefill), POST/PATCH inventory validate `YYYY-MM-DD`,
   inventory card "Released …" line, scan-page catalog card + matched rows,
   `cacheCatalogReleaseDate` + `{ scope: "no_release_date" }` bulk mode in
   refresh-price (≤50, per-product dedupe, prices untouched, "Fill release
   dates (N)" header button), scan route inherits catalog date on create +
   backfills blanks. Initially the resolver had no working source (0 loose,
   0 set_code → always null; user reported "no dates are being filled in") —
   this session added the name→set matcher (`findSetForProduct`), the
   membership-verified mtg.wiki Secret Lair lookup (`secret-lair.ts`),
   extracted the resolver to `src/lib/release-dates.ts`, and added the
   `--inventory` probe. eBay aspect path dropped after live probing (see
   Current Objective).
2. **Inventory visibility: paused always shown, sold-out hidden** (committed
   `26e3c0c` + SESSION refresh `4b92db4`, pushed — see Files Changed below).

## What We Did (2026-09-24 sessions)

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

- `origin/main` = `4b92db4` (SESSION refresh for inventory visibility, pushed).
  Working tree **dirty**: the release-date feature is fully coded but
  **uncommitted** (awaiting user's commit request).
- `typecheck` + `lint` pass (re-run after the matcher + SL lookup landed).
  **`npm run build` not run** — dev server is running in the user's
  foreground terminal; building would clobber `.next/` and 500 every dynamic
  route.
- **Migration `0010` IS applied** (verified via REST this session: the
  column returns, all rows null). **Dates are NOT filled yet** — the user
  clicks "Fill release dates (N)" once the feature is browser-ready; expect
  59/70 to fill in one or two clicks (cap 50 per call), 11 stay manual.
- **Probe verified**: `npx tsx scripts/probe-release-dates.ts --inventory` →
  **59/70 resolvable** (set_name=34, secret_lair=25), every pick + source
  printed and reviewed; SL page matches spot-checked verbatim in wikitext
  context. eBay probing proved Browse carries no usable release dates (see
  Current Objective).
- **Probe verified** dominant-anchor: `npx tsx scripts/probe-bundle-dupes.ts`
  → BOTH modes, dup rate 56–71%, dominant 100% anchor-first / 100%
  filler-tier, 0 violations at fill targets $55.56/$111.11/$166.67.
- **Migration `0009` applied** (SQL editor by the user, 2026-09-24). The
  price-history feature has not been browser-verified yet.
- Bundle discount + duplicates + dominant toggle NOT browser-checked yet. No
  browser check of price history either. Inventory visibility (paused shown,
  sold-out hidden) also not browser-checked yet.
- Data (REST-verified this session): **70 items · 248 units** — 69 sealed +
  1 open ("Tarkir Dragonstorm: Temur Roar Commander Deck", now kind `open`
  with price $98.66 + picture ✓; the old "kind other, no art" note is dead).
- All 6 "Lorwyn Eclipsed" rows are priced (Bundle $60, Play Boosters
  $6.00/$6.24, etc.) — the old "value null, Browse will retry" note is dead.

## Decisions Made

- **Release-date sources (2026-09-25)**: eBay is NOT one — live probing
  proved Browse summaries return no `localizedAspects` (0/10, with/without
  `fieldgroups=PRODUCT`) and TCG listing details only carry year-only
  "Year Manufactured"; the dead aspect code was stripped from `pricing.ts`.
  For Secret Lairs the user picked "Probe mtg.wiki first" over guessing;
  the membership-verified lookup passed (21/28 + suffix fallbacks) and is
  now the implementation. **Blank-not-guess**: anything unresolvable
  (Pokémon/Topps/Yu-Gi-Oh, Secret Lairs whose owning pages disagree) stays
  manual rather than risking a wrong date.
- **Inventory visibility (2026-09-25, user-confirmed via picker)**: sold-out
  rows stay in the DB and are hidden behind a "Show out of stock (N)" toggle
  (chosen over literal permanent hiding — rows must stay editable/restockable);
  pause = inventory-only (sale dropdown + bundle gen still exclude paused).
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

## Files Changed (this session, UNCOMMITTED = product release date)

- `supabase/migrations/0010_item_release_date.sql` (new) — nullable
  `items.release_date date` + `upc_catalog.release_date date`, idempotent.
- `src/lib/types.ts` — `Item.release_date`, `CatalogEntry.release_date`,
  `ScryfallCard.released_at`.
- `src/lib/scryfall.ts` — `cardFromJson` maps `released_at`;
  `getSetReleaseDate(code)`; **`findSetForProduct(name)`** — 6h-cached
  `/sets`, conservative product-line→set matcher (exact → set-contains →
  token-subset; token/promo/memorabilia/alchemy filtered; unique main-set
  candidate or blank; `Secret Lair*` excluded).
- `src/lib/secret-lair.ts` (new) — `lookupSecretLairDate(itemName)`:
  membership-verified mtg.wiki superdrop lookup (phrase search with
  `intitle:"Secret Lair"`, title gate `Superdrop|Drop Series|Commander
  Deck` + `Secret Lair/…` hub exclusion, verbatim wikitext membership,
  all owners must agree on one date; 6h wikitext + phrase caches with
  negatives).
- `src/lib/release-dates.ts` (new) — `resolveReleaseDateDetailed`
  (returns `{date, source, detail}` for the probe) + `resolveReleaseDate`
  (date-only, used by the route): loose card → set_code → SL-wiki / set
  match.
- `src/lib/ebay/pricing.ts` — release-aspect code REMOVED after live probing
  (search summaries have no `localizedAspects`; TCG details only have
  "Year Manufactured"); pricing/art behavior untouched.
- `src/app/api/inventory/refresh-price/route.ts` — imports the resolver from
  `release-dates`, `cacheCatalogReleaseDate` (blank-fill on `upc_catalog`),
  release date rides along in `priceOne` when blank, new `{ scope:
  "no_release_date" }` bulk mode (≤50, per-product dedupe, prices
  untouched), single/bulk responses cache the catalog date.
- `src/app/api/inventory/route.ts` + `[id]/route.ts` — POST/PATCH accept and
  `getDateOnly`-validate `release_date` (explicit null clears).
- `src/app/api/scan/route.ts` — new rows inherit `existingCatalog.release_date`;
  stock update backfills a blank item date from the catalog; catalog upserts
  never touch `release_date`.
- `src/app/api/scryfall/search/route.ts` + `src/components/CardSearchInput.tsx`
  — search results carry `released_at` for form prefill.
- `src/components/ItemForm.tsx` — "Released" date input (edit prefill, blank
  allowed, `applyCard` prefill from the picked card).
- `src/components/InventoryClient.tsx` — card "Released {formatDate}" line
  (omitted when blank), `undatedCount` memo, "Fill release dates (N)" header
  button → `scope: "no_release_date"`.
- `src/components/ScanClient.tsx` — catalog card "Released …" line +
  matched-inventory rows append `· Released …`.
- `scripts/probe-bundle-dupes.ts` — `mk()` fixture gained `release_date: null`.
- `scripts/probe-release-dates.ts` (new) — set-code / card-name modes +
  **`--inventory`** (runs the production resolver over every item, prints
  each pick + source).
- `AGENTS.md` — migration `0010` note, tables line, release-date conventions
  bullet (resolver sources + matcher rules + probe), Scryfall
  `getSetReleaseDate`/`findSetForProduct`.
  `SESSION.md` — this file.

## Files Changed (2026-09-25, committed `26e3c0c` = inventory visibility)

- `src/app/(app)/inventory/page.tsx` — SSR query: dropped `.eq("active", true)`.
- `src/app/api/inventory/route.ts` — GET returns all owner rows; removed the
  `includeInactive` param + active filter (JSDoc updated).
- `src/components/InventoryClient.tsx` — removed `showInactive`/“Show paused”
  checkbox + `includeInactive` param; new `showZero` state, `zeroCount`
  memo, `filtered` drops `quantity <= 0` unless toggled; toolbar "Show out of
  stock (N)" checkbox (only when N > 0); paused card = red ring/border +
  overlay subtitle "hidden from store"; legend line updated.
- `src/app/(app)/sales/page.tsx` — sale-form item query adds
  `.gt("quantity", 0)`.
- `src/components/BundleBuilder.tsx` — game-label derivation filters
  `active && quantity > 0` (GET is now unfiltered; server routes already
  require it).
- `AGENTS.md` — inventory-visibility bullet under API conventions.
  `SESSION.md` — this file.

## Files Changed (2026-09-24 sessions, committed `7b6a1bf` = dominant-anchor)

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

1. **Release date not filled/browser-verified yet** — migration `0010` is
   applied (REST-verified) and the probe resolves **59/70**, but no dates
   are written to the DB yet: have the user click "Fill release dates (N)"
   (2 clicks: cap 50), then check the card "Released" lines, scan displays,
   and the form field. 11 rows stay manual by design: Pokémon×3, Topps×3,
   Yu-Gi-Oh, Festival in a Box, and 3 ambiguous Secret Lairs (Lasagna Food
   Token, Command Tower, Inked Foil Edition).
2. **Bundle discount + duplicates + dominant toggle not browser-exercised
   yet** — discount: generate a $100 preset → contents ≈ $111, price $100;
   create → detail/list show price · value; CSV has both rows; an old bundle
   shows price = value × 0.9. Duplicates: probe-verified (56–71% dup rate, 0
   violations); eyeball one real generate for `×N` lines on multi-copy
   under-$20 stock. Dominant: default-checked bundle leads with the priciest
   line; unchecking the box gives the old mix.
3. **Inventory visibility not browser-verified** — paused rows always shown
   (red ring + "PAUSED · hidden from store" overlay, no more Show-paused
   toggle); sold-out rows hidden unless "Show out of stock (N)" is checked
   (revealed rows keep the red `×0`); sale dropdown no longer lists 0-stock
   items.
4. **Price history not browser-verified** (migration is in; check
   sparkline/modal after a refresh or manual value edit).
5. **Dashboard releases not visually checked in a browser** — code + probe
   verified; ask the user to load the dashboard.
6. **Latent bug, still NOT fixed:** `PATCH /api/inventory/[id]` ignores
   `quantity` — the edit form sends it but the route never puts it in `next`,
   so quantity edits silently don't persist. (`src/app/api/inventory/[id]/route.ts`.)
   (`acquired_at` now IS handled there; quantity still isn't.)
7. **`npm run build` not run this session** (blocked by the running dev server).
8. **Temur Roar art** — the deck is now kind `open` with price + picture, but
   nobody has eyeballed whether the art is the right DECK art (it may still
   be the old multi-deck set-pack image). Optional: check on the card, or run
   `npm run backfill-art` (covers `open` now) if wrong.
9. Marketplace Insights access still pending eBay approval.
10. `EBAY_DEV_ID` still not set in Vercel (Trading-API listing sync).

## Next Steps (priority order)

1. Have the user click "Fill release dates (N)" and browser-verify the
   release-date feature (Problem 1; probe says expect 59/70) — commit only
   when the user asks.
2. Browser-verify the inventory visibility rules (Problem 3), the bundle
   discount + duplicates + dominant toggle, and the price history sparkline
   (Problems 2–4).
3. Fix the `quantity` PATCH gap (route `[id]` ignores `quantity`; decide
   whether form quantity edits should reuse `adjust` semantics + movement
   ledger before coding).
4. Optional: eyeball Temur Roar's art (Problem 8) — re-run backfill-art if
   it's still the set-pack image.
5. Stop dev → `npm run build` → confirm green → restart dev.
6. Before deploy: Vercel env (incl. `CRON_SECRET`, `EBAY_*`), optional
   `vercel.json` cron for `/api/cron/sync-ebay`.

## Do Not Forget

- **Never run `npm run build` while `npm run dev` is running** — clobbers
  `.next/`, breaks every dynamic `[id]` API route with a bare 500.
- Don't rewrite migrations `0001`–`0010`; add the next `0011_*.sql` (keep idempotent).
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