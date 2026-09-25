import { generateBundle } from "@/lib/bundle";
import type { Item } from "@/lib/types";

/**
 * Prints duplicate/cap statistics for generateBundle over synthetic stock:
 * - under-$20 items are duplicate-eligible (max 5 of the same per bundle)
 * - $20+ items must appear at most once
 * Exits non-zero when a rule is violated.
 *
 * Usage: npx tsx scripts/probe-bundle-dupes.ts [runs] [targetCents]
 */

const DUP_ELIGIBLE_VALUE_CENTS = 2000; // strictly under $20 may repeat
const DUP_MAX_UNITS = 5;

function mk(name: string, value: number, quantity: number): Item {
  return {
    id: `probe-${name.replace(/\W+/g, "-").toLowerCase()}`,
    owner_id: "probe",
    name,
    kind: "sealed",
    upc: null,
    set_code: null,
    category: "MTG Sealed",
    quantity,
    unit_cost_cents: null,
    value_cents: value,
    ebay_avg_value_cents: null,
    price_source: "manual",
    price_sample_count: null,
    price_checked_at: null,
    image_url: null,
    notes: null,
    location_id: null,
    acquired_at: null,
    active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const items: Item[] = [
  // Cheap, deep stock — duplicate-eligible.
  ...Array.from({ length: 8 }, (_, i) =>
    mk(`Cheap ${i + 1}`, 500 + i * 170, 3 + (i % 5)),
  ),
  // Exactly $20 and up — quantity > 1 in stock, but must never duplicate.
  ...Array.from({ length: 4 }, (_, i) => mk(`Mid ${i + 1}`, 2000 + i * 700, 1 + (i % 3))),
  // Bigger pieces (still within the 60%-of-target single-unit cap).
  ...Array.from({ length: 3 }, (_, i) => mk(`Big ${i + 1}`, 4500 + i * 700, 1 + (i % 2))),
];

function main() {
  const runs = Number(process.argv[2] ?? 200);
  const targetCents = Number(process.argv[3] ?? 11111); // $100 price → fill target

  let withDup = 0;
  let empty = 0;
  let units = 0;
  let distinct = 0;
  let fillSum = 0;
  let maxQty = 0;
  const violations: string[] = [];

  for (let run = 0; run < runs; run++) {
    const result = generateBundle(items, targetCents);
    if (!result.lines.length) {
      empty++;
      continue;
    }
    fillSum += result.totalCents;
    let dupInBundle = false;
    const seenUnits = new Map<string, number>();
    for (const line of result.lines) {
      const q = line.quantity;
      units += q;
      distinct++;
      if (q > maxQty) maxQty = q;
      if (q >= 2) dupInBundle = true;
      seenUnits.set(line.item.name, (seenUnits.get(line.item.name) ?? 0) + q);

      const value = line.item.value_cents ?? 0;
      if (value >= DUP_ELIGIBLE_VALUE_CENTS && q > 1) {
        violations.push(`${line.item.name} ($${(value / 100).toFixed(2)}) duplicated ×${q}`);
      }
      if (q > DUP_MAX_UNITS) {
        violations.push(`${line.item.name} ×${q} exceeds the ${DUP_MAX_UNITS}-cap`);
      }
      if (q > line.item.quantity) {
        violations.push(`${line.item.name} ×${q} exceeds stock ${line.item.quantity}`);
      }
    }
    if (dupInBundle) withDup++;
  }

  const filled = runs - empty;
  console.log(`runs=${runs} (target fill $${(targetCents / 100).toFixed(2)}, ±$15 window)`);
  console.log(`empty:            ${empty}`);
  console.log(`bundles w/ dup:   ${withDup}${filled ? ` (${((withDup / filled) * 100).toFixed(0)}%)` : ""}`);
  console.log(`max qty of one:   ${maxQty}`);
  console.log(`avg units/bundle: ${(units / Math.max(filled, 1)).toFixed(1)}`);
  console.log(`avg distinct:     ${(distinct / Math.max(filled, 1)).toFixed(1)}`);
  console.log(`avg fill:         $${(fillSum / Math.max(filled, 1) / 100).toFixed(2)}`);

  if (violations.length) {
    console.error(`\nVIOLATIONS (${violations.length}):`);
    for (const v of [...new Set(violations)].slice(0, 20)) console.error(` - ${v}`);
    process.exit(1);
  }
  console.log("\nAll rules held: no $20+ duplicates, no line over 5 or over stock.");
}

main();
