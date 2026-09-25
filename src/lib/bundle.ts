import type { Item } from "@/lib/types";
import { pluralize, truncated } from "@/lib/utils";

export interface BundleLine {
  item: Item;
  quantity: number;
  valueCents: number;
}

export interface BundleResult {
  lines: BundleLine[];
  totalCents: number;
  targetCents: number;
}

/**
 * Deterministic RNG so the same seed reproduces the same bundle (used by the
 * "regenerate" flow — each click uses a fresh seed).
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Absolute window around the target, in cents (±$15). */
export const BUNDLE_TOLERANCE_CENTS = 1500;

/**
 * Bundle discount: the asking price is 10% below the contents' value (the
 * component prices run a bit high, so every bundle is priced 10% off).
 * Seller-facing only — never surfaces in listing drafts/titles.
 */
export const BUNDLE_DISCOUNT_PCT = 10;

/** Asking price for a bundle: 10% off its contents' value. */
export function bundlePriceCents(totalValueCents: number): number {
  return Math.round(totalValueCents * (1 - BUNDLE_DISCOUNT_PCT / 100));
}

/**
 * Contents-fill target for a chosen price point: value whose 10% discount
 * lands on `priceCents` (a $100 bundle packs ~$111 of stock).
 */
export function contentsTargetForPrice(priceCents: number): number {
  return Math.round(priceCents / (1 - BUNDLE_DISCOUNT_PCT / 100));
}

/**
 * First word of a category ("MTG Sealed" → "MTG"); "" when blank.
 * Used to group inventory into games (MTG, Pokemon, …) for bundling.
 */
export function gameOf(category: string | null | undefined): string {
  const c = (category ?? "").trim();
  if (!c) return "";
  return c.split(/\s+/)[0] || "";
}

/** Max copies of one under-$20 product inside a single bundle. */
const DUP_MAX_UNITS = 5;
/** Duplicates only below this value (strictly under $20). */
const DUP_ELIGIBLE_VALUE_CENTS = 2000;
/** Soft target for how many pieces a bundle holds (tie-break only). */
const PREFERRED_UNITS = 8;

/** Allowed units of `item` per bundle: stock, the 5-cap, and the $20 rule. */
function maxUnits(item: Item): number {
  const stock = Math.max(item.quantity, 0);
  if ((item.value_cents ?? 0) >= DUP_ELIGIBLE_VALUE_CENTS) return Math.min(stock, 1);
  return Math.min(stock, DUP_MAX_UNITS);
}

export interface BundleGenOptions {
  /**
   * Dominant-item composition (default `true`): the bundle is anchored on one
   * of the priciest eligible items and filled only with items worth ≤ 50% of
   * it, so one piece clearly dominates. `false` = plain weighted-random mix.
   * The dup rules apply in both modes.
   */
  dominant?: boolean;
}

/** Score a trial's fill; null when outside the ±tolerance window. */
function trialScore(
  lines: Map<number, number>,
  running: number,
  targetCents: number,
  toleranceCents: number,
): number | null {
  if (Math.abs(running - targetCents) > toleranceCents) return null;
  // Fill accuracy dominates; the units term only breaks ties between
  // equally-good fills (it never prefers distinct lines over duplicates).
  const units = [...lines.values()].reduce((sum, q) => sum + q, 0);
  return Math.abs(running - targetCents) * 10_000 + Math.abs(units - PREFERRED_UNITS);
}

function toLines(map: Map<number, number>, eligible: Item[]): BundleLine[] {
  return [...map.entries()].map(([index, quantity]) => ({
    item: eligible[index],
    quantity,
    valueCents: eligible[index].value_cents!,
  }));
}

function lineTotal(lines: BundleLine[]): number {
  return lines.reduce((sum, l) => sum + l.valueCents * l.quantity, 0);
}

/**
 * Plain mix: repeated randomized trials drawing value × remaining-stock
 * weighted items until the fill window is reached; best-scoring trial wins.
 */
function mixBundle(
  eligible: Item[],
  targetCents: number,
  toleranceCents: number,
  rng: () => number,
): BundleResult {
  let best: Map<number, number> | null = null;
  let bestScore = Infinity;

  for (let trial = 0; trial < 150; trial++) {
    const lines = new Map<number, number>(); // eligible index -> units picked
    const remaining = eligible.map((item) => maxUnits(item));
    let running = 0;
    let safety = 0;

    const weightOf = (i: number) =>
      remaining[i] > 0 ? Math.sqrt(eligible[i].value_cents!) * Math.sqrt(remaining[i]) : 0;

    while (running < targetCents && safety < 500) {
      safety++;
      let weightSum = 0;
      for (let i = 0; i < eligible.length; i++) weightSum += weightOf(i);
      if (weightSum <= 0) break; // everything capped or out of stock

      // Draw a weighted-random item: value weight (sublinear, favors cheaper
      // pieces) scaled by remaining allowed units so duplicates can happen.
      let pick = rng() * weightSum;
      let chosenIndex = -1;
      for (let i = 0; i < eligible.length; i++) {
        const w = weightOf(i);
        if (w <= 0) continue;
        pick -= w;
        if (pick <= 0) {
          chosenIndex = i;
          break;
        }
      }
      if (chosenIndex < 0) {
        chosenIndex = remaining.findIndex((r) => r > 0); // float drift
        if (chosenIndex < 0) break;
      }

      const chosen = eligible[chosenIndex];
      const unit = chosen.value_cents!;
      const current = lines.get(chosenIndex) ?? 0;

      // Adding this unit would overshoot the window: try something smaller first.
      if (running + unit > targetCents + toleranceCents * 2) {
        const smallerIndex = eligible.findIndex(
          (s, i) =>
            remaining[i] > 0 &&
            s.value_cents! <= targetCents + toleranceCents - running &&
            s.value_cents! < unit,
        );
        if (smallerIndex < 0) break;
        lines.set(smallerIndex, (lines.get(smallerIndex) ?? 0) + 1);
        remaining[smallerIndex]--;
        running += eligible[smallerIndex].value_cents!;
        continue;
      }

      // `chosenIndex` always has allowed room: zero-weight items can't be drawn.
      lines.set(chosenIndex, current + 1);
      remaining[chosenIndex]--;
      running += unit;
    }

    const score = trialScore(lines, running, targetCents, toleranceCents);
    if (score !== null && score < bestScore) {
      bestScore = score;
      best = lines;
    }
  }

  if (!best) {
    // Fallback: fill greedily without ever passing target + tolerance, and
    // stop as soon as we've reached the target.
    const fallback: BundleLine[] = [];
    let fallbackRunning = 0;
    for (const item of eligible) {
      if (fallbackRunning >= targetCents) break;
      const unit = item.value_cents!;
      const room = targetCents + toleranceCents - fallbackRunning;
      const perItem = Math.min(maxUnits(item), Math.floor(room / unit));
      if (perItem <= 0) continue;
      fallback.push({ item, quantity: perItem, valueCents: unit });
      fallbackRunning += perItem * unit;
    }
    return { lines: fallback, totalCents: fallbackRunning, targetCents };
  }

  const lines = toLines(best, eligible);
  return { lines, totalCents: lineTotal(lines), targetCents };
}

/**
 * Dominant-item composition: each trial anchors on one of the top-5 priciest
 * eligible items (sqrt(value)-weighted so Regenerate cycles) and fills the
 * rest ONLY with items worth ≤ 50% of that anchor, drawn sqrt(value)-weighted
 * and never overshooting the window — one piece clearly dominates, the rest
 * are its lower tier. Lines come back anchor-first, fillers value-descending.
 * Fallback keeps the anchor but drops the tier cap (dup caps still apply).
 */
function dominantBundle(
  eligible: Item[],
  targetCents: number,
  toleranceCents: number,
  rng: () => number,
): BundleResult {
  const top = eligible
    .map((_, index) => index)
    .sort((a, b) => eligible[b].value_cents! - eligible[a].value_cents!)
    .slice(0, 5);
  const topWeight = top.reduce((sum, i) => sum + Math.sqrt(eligible[i].value_cents!), 0);

  let best: Map<number, number> | null = null;
  let bestAnchor = top[0];
  let bestScore = Infinity;

  for (let trial = 0; trial < 150; trial++) {
    // Anchor: sqrt(value)-weighted draw from the priciest eligible items.
    let pick = rng() * topWeight;
    let anchorIndex = top[top.length - 1];
    for (const i of top) {
      pick -= Math.sqrt(eligible[i].value_cents!);
      if (pick <= 0) {
        anchorIndex = i;
        break;
      }
    }

    const lines = new Map<number, number>([[anchorIndex, 1]]);
    const remaining = eligible.map((item) => maxUnits(item));
    remaining[anchorIndex]--;
    const tierCap = eligible[anchorIndex].value_cents! * 0.5;
    let running = eligible[anchorIndex].value_cents!;
    let safety = 0;

    const fillerWeight = (i: number) => {
      const v = eligible[i].value_cents!;
      return remaining[i] > 0 && v <= tierCap && v <= targetCents + toleranceCents - running
        ? Math.sqrt(v)
        : 0;
    };

    while (running < targetCents && safety < 500) {
      safety++;
      let weightSum = 0;
      for (let i = 0; i < eligible.length; i++) weightSum += fillerWeight(i);
      if (weightSum <= 0) break; // no filler fits under the tier cap / room

      let fpick = rng() * weightSum;
      let idx = -1;
      for (let i = 0; i < eligible.length; i++) {
        const w = fillerWeight(i);
        if (w <= 0) continue;
        fpick -= w;
        if (fpick <= 0) {
          idx = i;
          break;
        }
      }
      if (idx < 0) break; // float drift

      lines.set(idx, (lines.get(idx) ?? 0) + 1);
      remaining[idx]--;
      running += eligible[idx].value_cents!;
    }

    const score = trialScore(lines, running, targetCents, toleranceCents);
    if (score !== null && score < bestScore) {
      bestScore = score;
      best = lines;
      bestAnchor = anchorIndex;
    }
  }

  // Fallback: priciest anchor + largest-first fill (tier cap dropped; caps stay).
  if (!best) {
    best = new Map<number, number>([[top[0], 1]]);
    bestAnchor = top[0];
    const remaining = eligible.map((item) => maxUnits(item));
    remaining[top[0]]--;
    let running = eligible[top[0]].value_cents!;
    while (running < targetCents) {
      const room = targetCents + toleranceCents - running;
      let idx = -1;
      let largest = -1;
      for (let i = 0; i < eligible.length; i++) {
        const v = eligible[i].value_cents!;
        if (remaining[i] > 0 && v <= room && v > largest) {
          largest = v;
          idx = i;
        }
      }
      if (idx < 0) break;
      best.set(idx, (best.get(idx) ?? 0) + 1);
      remaining[idx]--;
      running += eligible[idx].value_cents!;
    }
  }

  // Anchor line first, then fillers by value (desc).
  const anchor = bestAnchor;
  const ordered = new Map(
    [...best.entries()].sort((a, b) => {
      if (a[0] === anchor) return -1;
      if (b[0] === anchor) return 1;
      return eligible[b[0]].value_cents! - eligible[a[0]].value_cents!;
    }),
  );
  const lines = toLines(ordered, eligible);
  return { lines, totalCents: lineTotal(lines), targetCents };
}

/**
 * Builds a random bundle from in-stock items summing to `targetCents` within
 * an absolute window (`toleranceCents`, default ±$15).
 *
 * Two composition modes (see `BundleGenOptions`): dominant-item (default) —
 * one priciest anchor + lower-tier fillers; or plain weighted-random mix.
 *
 * Duplicates (both modes): items under $20 may repeat — up to
 * `DUP_MAX_UNITS` of the same product per bundle, bounded by stock; anything
 * $20+ appears at most once.
 *
 * Slots carry the item itself and are indexed locally — never with a position
 * from the pre-filter array (that mix caused TypeErrors when expensive items
 * were filtered out).
 *
 * @param items items with quantity > 0 and value_cents > 0
 * @param targetCents desired bundle value
 * @param toleranceCents absolute tolerance in cents, e.g. 1500 for ±$15
 */
export function generateBundle(
  items: Item[],
  targetCents: number,
  toleranceCents = BUNDLE_TOLERANCE_CENTS,
  opts: BundleGenOptions = {},
): BundleResult {
  const rng = mulberry32(Math.floor(Math.random() * 2 ** 31));

  // Mystery bundles should hold several items: a single unit may not be worth
  // more than ~60% of the target.
  const eligible = items.filter(
    (item) => item.quantity > 0 && (item.value_cents ?? 0) > 0 && item.value_cents! <= targetCents * 0.6,
  );

  if (!eligible.length) return { lines: [], totalCents: 0, targetCents };

  if (opts.dominant ?? true) return dominantBundle(eligible, targetCents, toleranceCents, rng);
  return mixBundle(eligible, targetCents, toleranceCents, rng);
}

export interface GameBundleResult extends BundleResult {
  /** Game the bundle was built from (first word of category; "" = uncategorized). */
  game: string;
}

/**
 * Builds a bundle from a single game's stock so MTG/Pokemon/etc. never mix.
 *
 * @param game specific game label to restrict to; `null`/`undefined` = "Any"
 *   (games are tried in random order and the first result landing inside the
 *   tolerance wins, else the closest).
 * @param opts composition options forwarded to `generateBundle`
 * @returns null when no game could produce a non-empty bundle.
 */
export function buildBundleAcrossGames(
  items: Item[],
  targetCents: number,
  toleranceCents = BUNDLE_TOLERANCE_CENTS,
  game?: string | null,
  opts: BundleGenOptions = {},
): GameBundleResult | null {
  const groups = new Map<string, { label: string; items: Item[] }>();
  for (const item of items) {
    const label = gameOf(item.category);
    const key = label.toLowerCase();
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { label, items: [item] });
  }

  if (game != null) {
    const group = groups.get(game.trim().toLowerCase());
    if (!group) return null;
    const result = generateBundle(group.items, targetCents, toleranceCents, opts);
    return result.lines.length ? { ...result, game: group.label } : null;
  }

  // Any: shuffle games and prefer one that lands inside the window.
  const order = [...groups.values()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let closest: GameBundleResult | null = null;
  for (const group of order) {
    const result = generateBundle(group.items, targetCents, toleranceCents, opts);
    if (!result.lines.length) continue;
    const candidate: GameBundleResult = { ...result, game: group.label };
    if (Math.abs(candidate.totalCents - targetCents) <= toleranceCents) return candidate;
    if (!closest || Math.abs(candidate.totalCents - targetCents) < Math.abs(closest.totalCents - targetCents)) {
      closest = candidate;
    }
  }
  return closest;
}

/**
 * Human/marketing name for a bundle, e.g. "MTG Mystery Bundle — ~$100".
 */
export function defaultBundleName(targetCents: number, includesSealed: boolean): string {
  const retail = (targetCents / 100).toFixed(0);
  return `MTG Mystery Bundle ~$${retail}${includesSealed ? " (sealed + bulk)" : " (bulk cards)"}`;
}

/**
 * Generates the eBay listing title + description for a bundle.
 *
 * No prices and no generator attribution. Title is
 * "<name> Sealed Lot — <priciest item>" (≤ 80 chars, eBay's limit).
 */
export function generateListingText(opts: {
  name: string;
  lines: BundleLine[];
}): { title: string; description: string } {
  const { name, lines } = opts;
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);

  const priciest = lines.reduce<BundleLine | null>(
    (best, l) => (!best || l.valueCents > best.valueCents ? l : best),
    null,
  );
  const base = `${name.trim()} Sealed Lot`.trim();
  const title = truncated(priciest ? `${base} — ${priciest.item.name}` : base, 80);

  const itemLines = lines
    .map(
      (l, i) =>
        `${i + 1}. ${l.quantity}× ${l.item.name}${l.item.set_code ? ` (${l.item.set_code})` : ""}`,
    )
    .join("\n");

  const description = [
    `Contents (${pluralize(count, "item")}):`,
    ``,
    itemLines,
    ``,
    `Items are sold as-is. Photos shown are examples of condition unless stated.`,
    `Fast shipping with tracking.`,
  ].join("\n");

  return { title, description };
}

/** CSV export for a bundle (shopify/ebay-ish friendly). */
export function bundleToCsv(lines: BundleLine[], totalCents: number): string {
  const rows: string[][] = [
    ["Item", "Set", "Quantity", "Value (USD)", "Line Total (USD)"],
    ...lines.map((l) => [
      l.item.name,
      l.item.set_code ?? "",
      String(l.quantity),
      (l.valueCents / 100).toFixed(2),
      ((l.valueCents * l.quantity) / 100).toFixed(2),
    ]),
    [],
    ["Contents value (USD)", "", "", "", (totalCents / 100).toFixed(2)],
    [`Bundle price (${BUNDLE_DISCOUNT_PCT}% off, USD)`, "", "", "", (bundlePriceCents(totalCents) / 100).toFixed(2)],
  ];
  return rows
    .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}