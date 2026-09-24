import { EBAY_PATHS, MARKETPLACE_ID, extractPriceCents } from "@/lib/ebay/oauth";

/**
 * eBay price lookup for sealed products.
 *
 * Strategy (requested by the user):
 *   1. Marketplace Insights API  — real sold items (last 90 days). Restricted:
 *      returns 403 until eBay approves your free access application. When it
 *      works it is the true "average sold".
 *   2. Browse API — CURRENT active asking prices. Exact UPC match for
 *      single-barcode products; for deck variants (shared pack barcode,
 *      "Set: Variant" names like "Commander Masters: Planeswalker Party")
 *      a keyword search on the name filtered to matching, condition-clean
 *      listings. Estimate uses the 25th percentile of the IQR-trimmed pool
 *      (asking prices are right-skewed; even the mean/median overstate on
 *      outlier listings) and is labeled as such.
 *
 * Results are cached on the item / upc_catalog by the caller.
 */

let cachedAppToken: { token: string; expiresAt: number } | null = null;

export async function getApplicationToken(): Promise<string> {
  if (cachedAppToken && cachedAppToken.expiresAt > Date.now() + 60_000) {
    return cachedAppToken.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  const res = await fetch(EBAY_PATHS.token, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`,
      ).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`eBay app token failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedAppToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedAppToken.token;
}

/** Linear-interpolation percentile (Excel PERCENTILE.INC / NumPy default) on a sorted array. */
function percentile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

/**
 * Drop Tukey outliers (outside Q1 − 1.5·IQR … Q3 + 1.5·IQR) when the pool is
 * large enough for the fences to mean anything. Catches both scalper asks
 * (high) and junk listings — damaged/wrong item, mispriced (low). Falls back
 * to the raw pool when trimming would gut it.
 */
function trimOutliers(sorted: number[]): number[] {
  if (sorted.length < 5) return sorted;
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const kept = sorted.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
  return kept.length >= 3 ? kept : sorted;
}

/** Price stats over an IQR-trimmed pool: p25 (the estimate), median, mean. */
export function stats(values: number[]) {
  if (!values.length) return null;
  const kept = trimOutliers([...values].sort((a, b) => a - b));
  const mean = Math.round(kept.reduce((a, b) => a + b, 0) / kept.length);
  return { p25: percentile(kept, 0.25), median: percentile(kept, 0.5), mean, count: kept.length };
}

function collectListValues(list: unknown, key: string): number[] {
  const out: number[] = [];
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const cents = extractPriceCents((entry as Record<string, unknown>)[key]);
    if (cents != null && cents > 0) out.push(cents);
  }
  return out;
}

/** Real sold data, if approved for the Marketplace Insights API. */
export async function searchInsights(query: string): Promise<{
  averageCents: number | null;
  medianCents: number | null;
  p25Cents: number | null;
  count: number;
  unavailable?: boolean;
}> {
  const token = await getApplicationToken();
  const url = new URL(`${EBAY_PATHS.api}/buy/marketplace_insights/v1_beta/item_sales/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "200");

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
        Accept: "application/json",
      },
    });
  } catch {
    return { averageCents: null, medianCents: null, p25Cents: null, count: 0, unavailable: true };
  }

  if (res.status === 403 || res.status === 401) {
    // Insights access not approved yet → caller falls back to Browse.
    return { averageCents: null, medianCents: null, p25Cents: null, count: 0, unavailable: true };
  }
  if (!res.ok) {
    return { averageCents: null, medianCents: null, p25Cents: null, count: 0, unavailable: true };
  }

  const body = (await res.json()) as { itemSales?: unknown[] };
  const sales = body.itemSales ?? [];
  const cents = collectListValues(sales, "salePrice").concat(
    collectListValues(sales, "price"),
  );
  const s = stats(cents);
  if (!s) return { averageCents: null, medianCents: null, p25Cents: null, count: 0 };
  return { averageCents: s.mean, medianCents: s.median, p25Cents: s.p25, count: s.count };
}

/** Filler words in a product name that shouldn't be required in listing titles. */
const STOPWORDS = new Set([
  "mtg",
  "magic",
  "the",
  "gathering",
  "trading",
  "of",
  "and",
  "for",
  "with",
  "a",
  "an",
  "card",
  "cards",
  "game",
  "games",
]);

/** Title words that indicate an opened/used/accessory listing, not NIB product. */
const CONDITION_BLACKLIST = [
  "playmat",
  "opened",
  "sleeved",
  "sleeves",
  "used",
  "damaged",
  "promo",
  "promos",
  "accessor",
];

/** "Commander Masters: Planeswalker Party" → set "Commander Masters", variant "Planeswalker Party". */
function splitVariant(name: string): { set: string | null; variant: string | null } {
  const trimmed = name.trim();
  if (!trimmed) return { set: null, variant: null };
  const idx = trimmed.lastIndexOf(":");
  if (idx > 0) {
    const set = trimmed.slice(0, idx).trim();
    const variant = trimmed.slice(idx + 1).trim();
    if (variant) return { set: set || null, variant };
  }
  return { set: null, variant: null };
}

/** Title terms every kept listing must contain: the variant, else the whole name. */
function requiredTokens(name: string): string[] {
  const { set, variant } = splitVariant(name);
  const head = variant ?? set ?? name;
  return head
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function titleMatches(tokens: string[], title: string): boolean {
  const t = title.toLowerCase();
  return (
    tokens.length === 0 ||
    tokens.every((tok) => new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t))
  );
}

function isConditionClean(title: string): boolean {
  // "unopened/unsealed" are good (still NIB) despite containing "opened/sealed".
  const t = title.toLowerCase().replace(/unopened/g, "").replace(/unsealed/g, "");
  return !CONDITION_BLACKLIST.some((w) => t.includes(w));
}

export interface BrowseEntry {
  title: string;
  cents: number;
  image: string | null;
}

async function browseSearch(params: {
  q?: string | null;
  gtin?: string | null;
}): Promise<BrowseEntry[]> {
  const token = await getApplicationToken();
  const url = new URL(`${EBAY_PATHS.api}/buy/browse/v1/item_summary/search`);
  if (params.q) url.searchParams.set("q", params.q);
  if (params.gtin) url.searchParams.set("gtin", params.gtin);
  url.searchParams.set("limit", "50");
  url.searchParams.set("filter", "price:[1..5000],buyingOptions:{FIXED_PRICE},deliveryCountry:US");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      Accept: "application/json",
    },
  });
  if (!res.ok) return [];

  const body = (await res.json()) as { itemSummaries?: unknown[] };
  const out: BrowseEntry[] = [];
  for (const entry of body.itemSummaries ?? []) {
    const rec = entry as Record<string, unknown>;
    const title = rec.title;
    if (typeof title !== "string") continue;
    const cents = extractPriceCents(rec.price);
    if (cents != null && cents > 0) {
      const primary = (rec.image as Record<string, unknown> | undefined)?.imageUrl as
        | string
        | undefined;
      const thumb = (
        (rec.thumbnailImages as Array<Record<string, unknown>> | undefined)?.[0] as
          | Record<string, unknown>
          | undefined
      )?.imageUrl as string | undefined;
      out.push({ title, cents, image: primary ?? thumb ?? null });
    }
  }
  return out;
}

interface BrowseStats {
  averageCents: number | null;
  medianCents: number | null;
  p25Cents: number | null;
  count: number;
}

const NO_STATS: BrowseStats = { averageCents: null, medianCents: null, p25Cents: null, count: 0 };

function toStats(entries: BrowseEntry[]): BrowseStats {
  const s = stats(entries.map((e) => e.cents));
  return s
    ? { averageCents: s.mean, medianCents: s.median, p25Cents: s.p25, count: s.count }
    : NO_STATS;
}

/**
 * Title phrases advertising MULTIPLE units — safe to exclude for every
 * product ("6x booster pack", "lot of 3", …). `2x2` (Double Masters' set
 * code) deliberately does not match: both sides of the x need word boundaries.
 */
const QUANTITY_PATTERNS: RegExp[] = [
  /\b\d+\s*x\b/i, // "6x Booster Box", "6 x booster pack"
  /\bx\s*\d+\b/i, // "x6", "x 6"
  /\blot of\b/i,
  /\bset of\b/i,
  /\ball \d+\b/i,
  /\bcase of\b/i,
  /\b\d+\s*decks?\b/i,
];

/**
 * Packaging phrases that are wrong ONLY for shared-barcode "Set: Variant"
 * pools — "bundle"/"box set" are real product names for single-barcode
 * products (Booster Bundle etc.), so excluding them everywhere would empty
 * those products' price pools.
 */
const VARIANT_MULTI_PATTERNS: RegExp[] = [/box set/i, /\bbundle\b/i];

function matchesAny(title: string, patterns: RegExp[]): boolean {
  const t = title.toLowerCase();
  return patterns.some((re) => re.test(t));
}

/** NIB, single-unit titles (plus variant-pack rules when the name has a variant). */
function keepClean(entries: BrowseEntry[], name: string) {
  const variant = nameHasVariant(name);
  return entries.filter(
    (e) =>
      isConditionClean(e.title) &&
      !matchesAny(e.title, QUANTITY_PATTERNS) &&
      (!variant || !matchesAny(e.title, VARIANT_MULTI_PATTERNS)),
  );
}

/** Keep only listings that are condition/single-unit clean AND match the product name. */
export function keepMatching(entries: BrowseEntry[], name: string) {
  const tokens = requiredTokens(name);
  return keepClean(entries, name).filter((e) => titleMatches(tokens, e.title));
}

/** True when a name carries a "Set: Variant" style sub-name (shared barcodes). */
export function nameHasVariant(name: string): boolean {
  return Boolean(splitVariant(name).variant);
}

/** Title words that signal the sealed PACKAGE rather than a loose single-card listing. */
const PACKAGE_WORDS: RegExp[] = [
  /\bsealed\b/,
  /\bunopened\b/,
  /\bunsealed\b/,
  /\bbooster\b/,
  /\bpacks?\b/,
  /\bedition\b/,
  /\bcommander\b/,
  /\bdeck\b/,
  /\bdrop\b/,
  /\bbox\b/,
  /\bdisplay\b/,
  /\bfoil edition\b/,
];

/** Title hints that a listing is a loose single card (e.g. Secret Lair "Farseek 2698"). */
const SINGLE_HINTS: RegExp[] = [/\b(?!19\d{2}|20\d{2})\d{3,4}\b/, /\bsingle\b/];

function scoreTitle(title: string): number {
  const t = title.toLowerCase();
  let score = 0;
  for (const re of PACKAGE_WORDS) if (re.test(t)) score += 1;
  for (const re of SINGLE_HINTS) if (re.test(t)) score -= 2;
  return score;
}

/** The most package-like kept entry's image, keeping eBay relevance order on ties. */
export function pickBestImage(entries: BrowseEntry[]): string | null {
  if (!entries.length) return null;
  let best = entries[0];
  let bestScore = scoreTitle(best.title);
  for (const e of entries.slice(1)) {
    const s = scoreTitle(e.title);
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return best.image;
}

/**
 * Matching listing pool for a product name. When a UPC is known the Browse
 * search runs by GTIN (returns the right sealed packages, and for shared
 * barcodes the variant tokens in requiredTokens pick the right deck) and only
 * falls back to a keyword search when the GTIN pool is empty.
 */
export async function matchingPool(name: string, gtin?: string | null): Promise<BrowseEntry[]> {
  if (gtin) {
    const byGtin = keepMatching(await browseSearch({ q: null, gtin }), name);
    if (byGtin.length) return byGtin;
  }
  const q = name.replace(/[;:]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return [];
  return keepMatching(await browseSearch({ q, gtin: null }), name);
}

/**
 * Box art for a sealed product by name (works for deck variants and UPC-less
 * products) from a matching, condition-clean listing. Uses the same keyword
 * match pool as price lookups. Returns null when nothing credible matches.
 */
export async function resolveNameImage(name: string, gtin?: string | null): Promise<string | null> {
  return pickBestImage(await matchingPool(name, gtin));
}

/**
 * Box art for a deck variant ("Set: Variant" names) from a matching,
 * condition-clean listing. Returns null when the name has no variant or
 * nothing credible matches.
 */
export async function resolveVariantImage(name: string, gtin?: string | null): Promise<string | null> {
  if (!nameHasVariant(name)) return null;
  return resolveNameImage(name, gtin);
}

/**
 * Current asking prices for a sealed product. Deck variants share a pack
 * barcode, so when the name carries a variant it is priced by a keyword
 * search on the name filtered to matching listings — never by raw UPC.
 * Single-barcode products are matched exactly by GTIN, narrowed by the name
 * when it agrees. Returns no stats if nothing credible matches.
 */
export async function searchActive(opts: {
  gtin?: string | null;
  query?: string | null;
}): Promise<BrowseStats> {
  const gtin = opts.gtin?.trim() || null;
  const query = opts.query?.trim() || "";
  const q = query.replace(/[;:]/g, " ").replace(/\s+/g, " ").trim();
  const hasVariant = Boolean(splitVariant(query).variant);

  if (hasVariant) {
    // Shared pack barcode: the UPC cannot distinguish decks — but it still
    // narrows the pool to the right product family (deck variants included),
    // so search by GTIN first and only fall back to a name search.
    if (!q) return NO_STATS;
    return toStats(await matchingPool(query, gtin));
  }

  if (gtin) {
    const items = await browseSearch({ q: null, gtin });
    const matched = keepMatching(items, query);
    // UPC is authoritative for single-barcode products; the name filter only
    // narrows when it agrees. When no title carries the name, fall back to
    // the condition/single-unit-clean GTIN pool — never the raw one, so
    // multi-unit (6x/lot) and junk-condition titles still don't price.
    const pool = matched.length > 0 ? matched : keepClean(items, query);
    const s = toStats(pool);
    if (s.averageCents != null) return s;
  }

  if (q) {
    return toStats(keepMatching(await browseSearch({ q, gtin: null }), query));
  }

  return NO_STATS;
}

export interface PriceLookup {
  averageCents: number | null;
  medianCents: number | null;
  p25Cents: number | null;
  count: number;
  source: "insights" | "browse_active" | "none";
}

/**
 * The stat to treat as "the price" for a lookup: the 25th percentile of the
 * (IQR-trimmed) observed prices — conservative for right-skewed active asking
 * prices, and still the right pick for sold data if Insights comes online.
 * Falls back to median, then mean.
 */
export function primaryCents(
  lookup: Pick<PriceLookup, "p25Cents" | "medianCents" | "averageCents">,
): number | null {
  return lookup.p25Cents ?? lookup.medianCents ?? lookup.averageCents;
}

/**
 * Full pipeline for a sealed product: Insights sold-data when available,
 * otherwise a name-aware Browse active-listing estimate (UPC exact-match for
 * single-barcode products; keyword search on the name for deck variants), or
 * nothing when no credible listing matches.
 */
export async function lookupSealedPrice(opts: {
  gtin?: string | null;
  query?: string | null;
}): Promise<PriceLookup> {
  const searchQuery = opts.query?.trim() || opts.gtin || "";
  const gtin = opts.gtin?.trim() || null;

  if (searchQuery) {
    const insights = await searchInsights(searchQuery);
    if (insights.averageCents != null) {
      return {
        averageCents: insights.averageCents,
        medianCents: insights.medianCents,
        p25Cents: insights.p25Cents,
        count: insights.count,
        source: "insights",
      };
    }
  }

  const browse = await searchActive({ gtin, query: searchQuery });
  if (browse.averageCents != null) {
    return {
      averageCents: browse.averageCents,
      medianCents: browse.medianCents,
      p25Cents: browse.p25Cents,
      count: browse.count,
      source: "browse_active",
    };
  }

  return { averageCents: null, medianCents: null, p25Cents: null, count: 0, source: "none" };
}

/** Resolve a GTIN/UPC to a product name + image (best effort). */
export async function resolveProductByGtin(gtin: string): Promise<{
  name: string | null;
  imageUrl: string | null;
} | null> {
  try {
    const token = await getApplicationToken();
    const url = new URL(
      `${EBAY_PATHS.api}/commerce/catalog/v1_beta/product_summary/search`,
    );
    url.searchParams.set("gtin", gtin);
    url.searchParams.set("limit", "1");
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
        Accept: "application/json",
      },
    });
    if (res.ok) {
      const body = (await res.json()) as { productSummaries?: unknown[] };
      const first = body.productSummaries?.[0];
      if (first && typeof first === "object") {
        const rec = first as Record<string, unknown>;
        const title =
          (rec.title as string) ??
          (rec.leafCategory != null ? (rec.leafCategory as Record<string, unknown>).name as string : null);
        const image =
          typeof rec.image === "string"
            ? rec.image
            : (rec.image as Record<string, unknown>)?.imageUrl ?? null;
        if (title) return { name: title, imageUrl: (image as string) ?? null };
      }
    }
  } catch {
    // fall through to Browse
  }

  // Fallback: use the first active listing title as the product name.
  if (gtin) {
    const token = await getApplicationToken().catch(() => "");
    if (token) {
      const url = new URL(`${EBAY_PATHS.api}/buy/browse/v1/item_summary/search`);
      url.searchParams.set("gtin", gtin);
      url.searchParams.set("limit", "1");
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
          Accept: "application/json",
        },
      });
      if (res.ok) {
        const body = (await res.json()) as { itemSummaries?: unknown[] };
        const first = body.itemSummaries?.[0] as Record<string, unknown> | undefined;
        const title = first?.title as string | undefined;
        const primary = (first?.image as Record<string, unknown> | undefined)?.imageUrl as
          | string
          | undefined;
        const thumb = (
          (first?.thumbnailImages as Array<Record<string, unknown>> | undefined)?.[0] as
            | Record<string, unknown>
            | undefined
        )?.imageUrl as string | undefined;
        const image = primary ?? thumb ?? null;
        if (title) return { name: title, imageUrl: image };
      }
    }
  }

  return null;
}