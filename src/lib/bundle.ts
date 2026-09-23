import type { Item } from "@/lib/types";

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

interface Slot {
  index: number;
  maxQty: number;
}

/**
 * Builds a random bundle from in-stock items summing to `targetCents`.
 *
 * Approach: repeated randomized trials. Each trial greedily draws items
 * (weighted toward their value + some variety) until adding another item
 * would overshoot the target by more than it already undershoots. The trial
 * that lands closest to the target (within tolerance) is returned.
 *
 * @param items items with quantity > 0 and value_cents > 0
 * @param targetCents desired bundle value
 * @param tolerance relative tolerance, e.g. 0.05 for ±5%
 */
export function generateBundle(
  items: Item[],
  targetCents: number,
  tolerance = 0.05,
): BundleResult {
  const rng = mulberry32(Math.floor(Math.random() * 2 ** 31));

  const eligible = items
    .map((item, index) => ({ item, index, maxQty: item.quantity }))
    .filter((s) => s.item.quantity > 0 && (s.item.value_cents ?? 0) > 0)
    .filter((s) => s.item.value_cents! <= targetCents * 0.6);

  let best: BundleLine[] | null = null;
  let bestScore = Infinity;

  const totalWeight = eligible.reduce((sum, s) => sum + Math.sqrt(s.item.value_cents!), 0);

  // Pool of items big enough to matter.
  const pool: Slot[] = eligible.map((s) => ({ index: s.index, maxQty: s.maxQty }));

  for (let trial = 0; trial < 150; trial++) {
    const lines = new Map<number, number>(); // index -> qty
    let running = 0;
    let safety = 0;

    while (running < targetCents && safety < 500) {
      safety++;
      // Draw a weighted-random item. Aim for variety: weight grows with value
      // but lightly favors lower-value items to mix in.
      let pick = rng() * totalWeight;
      let chosen: Slot | null = null;
      for (const s of eligible) {
        pick -= Math.sqrt(s.item.value_cents!);
        if (pick <= 0) {
          chosen = { index: s.index, maxQty: s.maxQty };
          break;
        }
      }
      if (!chosen) chosen = pool[Math.floor(rng() * pool.length)];

      const slotItem = eligible[chosen.index];
      const unit = slotItem.item.value_cents!;
      const current = lines.get(chosen.index) ?? 0;

      // Staying after this unit would still be below target*(1+0.5): allow it.
      if (running + unit > targetCents * (1 + tolerance * 2)) {
        // Try something smaller first.
        const smaller = eligible.find(
          (s) => s.item.value_cents! <= targetCents - running && s.item.value_cents! < unit,
        );
        if (!smaller) break;
        const si = eligible.indexOf(smaller);
        const sc = lines.get(si) ?? 0;
        if (sc + 1 <= smaller.item.quantity) {
          lines.set(si, sc + 1);
          running += smaller.item.value_cents!;
        }
        continue;
      }

      if (current + 1 <= chosen.maxQty) {
        lines.set(chosen.index, current + 1);
        running += unit;
      } else {
        // Pick the closest remaining-cheap item available.
        const alt = eligible.find(
          (s) => (lines.get(s.index) ?? 0) + 1 <= s.item.quantity && running + s.item.value_cents! <= targetCents * (1 + tolerance),
        );
        if (!alt) break;
        lines.set(alt.index, (lines.get(alt.index) ?? 0) + 1);
        running += alt.item.value_cents!;
      }
    }

    // Only consider results within tolerance (±5% of target).
    const accepted = running >= targetCents * (1 - tolerance) && running <= targetCents * (1 + tolerance);
    if (!accepted) continue;

    const score = Math.abs(running - targetCents) * 10_000 + Math.abs(lines.size - 8);
    if (score < bestScore) {
      bestScore = score;
      best = [...lines.entries()].map(([index, qty]) => ({
        item: eligible[index].item,
        quantity: qty,
        valueCents: eligible[index].item.value_cents!,
      }));
    }
  }

  if (!best) {
    // Fallback: closest under target regardless of tolerance.
    let fallback: BundleLine[] = [];
    let fallbackRunning = 0;
    for (const s of eligible) {
      const unit = s.item.value_cents!;
      const perItem = Math.min(s.item.quantity, Math.max(1, Math.floor((targetCents - fallbackRunning) / unit)));
      if (perItem <= 0) continue;
      fallback = [...fallback, { item: s.item, quantity: perItem, valueCents: unit }];
      fallbackRunning += perItem * unit;
      if (fallbackRunning >= targetCents) break;
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

/**
 * Human/marketing name for a bundle, e.g. "MTG Mystery Bundle — ~$100".
 */
export function defaultBundleName(targetCents: number, includesSealed: boolean): string {
  const retail = (targetCents / 100).toFixed(0);
  return `MTG Mystery Bundle ~$${retail}${includesSealed ? " (sealed + bulk)" : " (bulk cards)"}`;
}

/**
 * Generates the eBay listing title + description for a bundle.
 */
export function generateListingText(opts: {
  name: string;
  targetCents: number;
  lines: BundleLine[];
  totalCents: number;
}): { title: string; description: string } {
  const { name, targetCents, lines, totalCents } = opts;
  const approx = Math.round(totalCents / 100);
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);

  const title = `${name} — ~$${approx} Retail Value`;

  const itemLines = lines
    .map(
      (l, i) =>
        `${i + 1}. ${l.quantity}× ${l.item.name} — est. value $${(l.valueCents / 100).toFixed(2)}${l.item.set_code ? ` (${l.item.set_code})` : ""}`,
    )
    .join("\n");

  const description = [
    `Magic: The Gathering mystery bundle — generated by goodwhilly (inventory tracker).`,
    ``,
    `Estimated retail value: ~$${(totalCents / 100).toFixed(2)}`,
    `Target value: ~$${(targetCents / 100).toFixed(0)}`,
    `Contents (${count} item[s]):`,
    ``,
    itemLines,
    ``,
    `Items are sold as-is, selected at random from my in-stock inventory. Photos shown are examples of condition unless stated.`,
    `Fast shipping with tracking. International buyers welcome.`,
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