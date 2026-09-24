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
 * First word of a category ("MTG Sealed" → "MTG"); "" when blank.
 * Used to group inventory into games (MTG, Pokemon, …) for bundling.
 */
export function gameOf(category: string | null | undefined): string {
  const c = (category ?? "").trim();
  if (!c) return "";
  return c.split(/\s+/)[0] || "";
}

/**
 * Builds a random bundle from in-stock items summing to `targetCents` within
 * an absolute window (`toleranceCents`, default ±$15).
 *
 * Approach: repeated randomized trials. Each trial greedily draws items
 * (weighted toward their value + some variety) until adding another item
 * would overshoot the window. The trial that lands closest to the target
 * (within tolerance) is returned; otherwise the closest under-fill is.
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
): BundleResult {
  const rng = mulberry32(Math.floor(Math.random() * 2 ** 31));

  // Mystery bundles should hold several items: a single unit may not be worth
  // more than ~60% of the target.
  const eligible = items.filter(
    (item) => item.quantity > 0 && (item.value_cents ?? 0) > 0 && item.value_cents! <= targetCents * 0.6,
  );

  if (!eligible.length) return { lines: [], totalCents: 0, targetCents };

  let best: BundleLine[] | null = null;
  let bestScore = Infinity;

  const totalWeight = eligible.reduce((sum, s) => sum + Math.sqrt(s.value_cents!), 0);

  for (let trial = 0; trial < 150; trial++) {
    const lines = new Map<number, number>(); // eligible index -> qty
    let running = 0;
    let safety = 0;

    while (running < targetCents && safety < 500) {
      safety++;
      // Draw a weighted-random item. Aim for variety: weight grows with value
      // but lightly favors lower-value items to mix in.
      let pick = rng() * totalWeight;
      let chosenIndex = -1;
      for (let i = 0; i < eligible.length; i++) {
        pick -= Math.sqrt(eligible[i].value_cents!);
        if (pick <= 0) {
          chosenIndex = i;
          break;
        }
      }
      if (chosenIndex < 0) chosenIndex = Math.floor(rng() * eligible.length);

      const chosen = eligible[chosenIndex];
      const unit = chosen.value_cents!;
      const current = lines.get(chosenIndex) ?? 0;

      // Adding this unit would overshoot the window: try something smaller first.
      if (running + unit > targetCents + toleranceCents * 2) {
        const smallerIndex = eligible.findIndex(
          (s) => s.value_cents! <= targetCents + toleranceCents - running && s.value_cents! < unit,
        );
        if (smallerIndex < 0) break;
        const sc = lines.get(smallerIndex) ?? 0;
        if (sc + 1 <= eligible[smallerIndex].quantity) {
          lines.set(smallerIndex, sc + 1);
          running += eligible[smallerIndex].value_cents!;
        }
        continue;
      }

      if (current + 1 <= chosen.quantity) {
        lines.set(chosenIndex, current + 1);
        running += unit;
      } else {
        // Pick the closest remaining-cheap item available.
        const altIndex = eligible.findIndex(
          (s, i) =>
            (lines.get(i) ?? 0) + 1 <= s.quantity &&
            running + s.value_cents! <= targetCents + toleranceCents,
        );
        if (altIndex < 0) break;
        lines.set(altIndex, (lines.get(altIndex) ?? 0) + 1);
        running += eligible[altIndex].value_cents!;
      }
    }

    // Only consider results within the absolute window (± toleranceCents).
    if (Math.abs(running - targetCents) > toleranceCents) continue;

    const score = Math.abs(running - targetCents) * 10_000 + Math.abs(lines.size - 8);
    if (score < bestScore) {
      bestScore = score;
      best = [...lines.entries()].map(([index, qty]) => ({
        item: eligible[index],
        quantity: qty,
        valueCents: eligible[index].value_cents!,
      }));
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
      const perItem = Math.min(item.quantity, Math.floor(room / unit));
      if (perItem <= 0) continue;
      fallback.push({ item, quantity: perItem, valueCents: unit });
      fallbackRunning += perItem * unit;
    }
    return {
      lines: fallback,
      totalCents: fallbackRunning,
      targetCents,
    };
  }

  const total = best.reduce((sum, l) => sum + l.valueCents * l.quantity, 0);
  return { lines: best, totalCents: total, targetCents };
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
 * @returns null when no game could produce a non-empty bundle.
 */
export function buildBundleAcrossGames(
  items: Item[],
  targetCents: number,
  toleranceCents = BUNDLE_TOLERANCE_CENTS,
  game?: string | null,
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
    const result = generateBundle(group.items, targetCents, toleranceCents);
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
    const result = generateBundle(group.items, targetCents, toleranceCents);
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
    ["Bundle total (USD)", "", "", "", (totalCents / 100).toFixed(2)],
  ];
  return rows
    .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}