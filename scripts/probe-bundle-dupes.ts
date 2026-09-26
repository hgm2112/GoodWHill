import { generateBundle } from "@/lib/bundle";
import type { Item } from "@/lib/types";

/**
 * Prints duplicate/cap + composition statistics for generateBundle over
 * synthetic stock, in BOTH modes (dominant anchor vs plain mix):
 * - under-$20 items are duplicate-eligible (max 5 of the same per bundle)
 * - $20+ items must appear at most once
 * - dominant mode: first line = most valuable, every filler ≤ 50% of anchor
 * Plus anchor scenarios (`anchorItemId`): the picked item is ALWAYS in the
 * bundle, leads it in anchor mode, and bypasses the 60%-of-target rule.
 * Exits non-zero when a hard rule (dup caps/stock/anchor) is violated.
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
    release_date: null,
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

interface ModeStats {
  empty: number;
  withDup: number;
  units: number;
  distinct: number;
  fillSum: number;
  maxQty: number;
  anchorFirst: number; // first line carries the max unit value
  tierOk: number; // every non-first line ≤ 50% of the first line's value
  anchorShare: number; // anchor line total / bundle total
  violations: string[];
}

function runMode(dominant: boolean, runs: number, targetCents: number): ModeStats {
  const s: ModeStats = {
    empty: 0,
    withDup: 0,
    units: 0,
    distinct: 0,
    fillSum: 0,
    maxQty: 0,
    anchorFirst: 0,
    tierOk: 0,
    anchorShare: 0,
    violations: [],
  };

  for (let run = 0; run < runs; run++) {
    const result = generateBundle(items, targetCents, undefined, { dominant });
    if (!result.lines.length) {
      s.empty++;
      continue;
    }
    s.fillSum += result.totalCents;

    const anchor = result.lines[0];
    const anchorValue = anchor.item.value_cents ?? 0;
    const maxLineValue = Math.max(...result.lines.map((l) => l.item.value_cents ?? 0));
    if ((anchor.item.value_cents ?? 0) === maxLineValue) s.anchorFirst++;
    if (result.lines.slice(1).every((l) => (l.item.value_cents ?? 0) <= anchorValue * 0.5)) {
      s.tierOk++;
    }
    s.anchorShare += (anchorValue * anchor.quantity) / result.totalCents;

    let dupInBundle = false;
    for (const line of result.lines) {
      const q = line.quantity;
      s.units += q;
      s.distinct++;
      if (q > s.maxQty) s.maxQty = q;
      if (q >= 2) dupInBundle = true;

      const value = line.item.value_cents ?? 0;
      if (value >= DUP_ELIGIBLE_VALUE_CENTS && q > 1) {
        s.violations.push(`${line.item.name} ($${(value / 100).toFixed(2)}) duplicated ×${q}`);
      }
      if (q > DUP_MAX_UNITS) {
        s.violations.push(`${line.item.name} ×${q} exceeds the ${DUP_MAX_UNITS}-cap`);
      }
      if (q > line.item.quantity) {
        s.violations.push(`${line.item.name} ×${q} exceeds stock ${line.item.quantity}`);
      }
    }
    if (dupInBundle) s.withDup++;
  }

  return s;
}

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(0)}%` : "n/a";
}

interface AnchorStats {
  runs: number;
  present: number;
  first: number;
  tierOk: number;
  fillSum: number;
  violations: string[];
}

/** `anchorItemId` scenarios: presence + (dominant) first/tier are hard rules. */
function runAnchor(
  anchor: Item,
  dominant: boolean,
  runs: number,
  targetCents: number,
): AnchorStats {
  const s: AnchorStats = { runs, present: 0, first: 0, tierOk: 0, fillSum: 0, violations: [] };
  const anchorValue = anchor.value_cents ?? 0;

  for (let run = 0; run < runs; run++) {
    const result = generateBundle(items, targetCents, undefined, {
      dominant,
      anchorItemId: anchor.id,
    });
    if (!result.lines.length) {
      s.violations.push(`empty bundle with anchor ${anchor.name} (dominant=${dominant})`);
      continue;
    }
    s.fillSum += result.totalCents;

    const anchorLine = result.lines.find((l) => l.item.id === anchor.id);
    if (!anchorLine) {
      s.violations.push(
        `anchor ${anchor.name} MISSING from bundle (dominant=${dominant}, target=${targetCents})`,
      );
      continue;
    }
    s.present++;
    if (dominant) {
      if (result.lines[0].item.id === anchor.id) s.first++;
      else s.violations.push(`anchor ${anchor.name} not first (got ${result.lines[0].item.name})`);
      if (result.lines.slice(1).every((l) => (l.item.value_cents ?? 0) <= anchorValue * 0.5)) {
        s.tierOk++;
      }
    }

    for (const line of result.lines) {
      const q = line.quantity;
      const value = line.item.value_cents ?? 0;
      if (value >= DUP_ELIGIBLE_VALUE_CENTS && q > 1) {
        s.violations.push(`${line.item.name} ($${(value / 100).toFixed(2)}) duplicated ×${q}`);
      }
      if (q > DUP_MAX_UNITS) {
        s.violations.push(`${line.item.name} ×${q} exceeds the ${DUP_MAX_UNITS}-cap`);
      }
      if (q > line.item.quantity) {
        s.violations.push(`${line.item.name} ×${q} exceeds stock ${line.item.quantity}`);
      }
    }
  }
  return s;
}

function main() {
  const runs = Number(process.argv[2] ?? 200);
  const targetCents = Number(process.argv[3] ?? 11111); // $100 price → fill target

  console.log(`runs/mode=${runs} (target fill $${(targetCents / 100).toFixed(2)}, ±$15 window)`);

  const violations: string[] = [];
  for (const { label, dominant } of [
    { label: "dominant", dominant: true },
    { label: "mix     ", dominant: false },
  ]) {
    const s = runMode(dominant, runs, targetCents);
    const filled = runs - s.empty;
    console.log(`\n[${label}]`);
    console.log(`  empty:            ${s.empty}`);
    console.log(`  bundles w/ dup:   ${s.withDup} (${pct(s.withDup, filled)})`);
    console.log(`  max qty of one:   ${s.maxQty}`);
    console.log(`  avg units/bundle: ${(s.units / Math.max(filled, 1)).toFixed(1)}`);
    console.log(`  avg distinct:     ${(s.distinct / Math.max(filled, 1)).toFixed(1)}`);
    console.log(`  avg fill:         $${(s.fillSum / Math.max(filled, 1) / 100).toFixed(2)}`);
    if (dominant) {
      console.log(`  anchor first:     ${pct(s.anchorFirst, filled)} (want 100%)`);
      console.log(`  fillers ≤50%:     ${pct(s.tierOk, filled)} (fallbacks may miss)`);
      console.log(`  avg anchor share: ${pct(Math.round((s.anchorShare / Math.max(filled, 1)) * 100), 100)}`);
    }
    violations.push(...s.violations);
  }

  // --- anchorItemId scenarios ---
  const expensiveAnchor = items.find((i) => i.name === "Big 3")!; // $59, qty 1
  const cheapAnchor = items.find((i) => i.name === "Cheap 1")!; // $5, qty 3
  const smallTarget = 5556; // $50 price → ~$55.56 contents (60% rule = $33.33)

  const scenarios: Array<{ label: string; stats: AnchorStats; wantFirst: boolean }> = [
    {
      label: `anchor · dominant · ${expensiveAnchor.name} ($${(expensiveAnchor.value_cents! / 100).toFixed(0)})`,
      stats: runAnchor(expensiveAnchor, true, runs, targetCents),
      wantFirst: true,
    },
    {
      label: `anchor · mix     · ${cheapAnchor.name} ($${(cheapAnchor.value_cents! / 100).toFixed(0)})`,
      stats: runAnchor(cheapAnchor, false, runs, targetCents),
      wantFirst: false,
    },
    {
      label: `anchor · 60% bypass · Big 1 ($45) @ target $${(smallTarget / 100).toFixed(2)} (60% = $${((smallTarget * 0.6) / 100).toFixed(2)})`,
      stats: runAnchor(items.find((i) => i.name === "Big 1")!, true, Math.min(runs, 50), smallTarget),
      wantFirst: true,
    },
  ];

  for (const { label, stats, wantFirst } of scenarios) {
    console.log(`\n[${label}]`);
    console.log(`  runs:             ${stats.runs}`);
    console.log(`  anchor present:   ${pct(stats.present, stats.runs)} (want 100%)`);
    if (wantFirst) {
      console.log(`  anchor first:     ${pct(stats.first, stats.runs)} (want 100%)`);
      console.log(`  fillers ≤50%:     ${pct(stats.tierOk, stats.runs)} (fallbacks may miss)`);
    }
    console.log(`  avg fill:         $${(stats.fillSum / Math.max(stats.present, 1) / 100).toFixed(2)}`);
    violations.push(...stats.violations);
  }

  if (violations.length) {
    console.error(`\nVIOLATIONS (${violations.length}):`);
    for (const v of [...new Set(violations)].slice(0, 20)) console.error(` - ${v}`);
    process.exit(1);
  }
  console.log(
    "\nAll rules held: no $20+ duplicates, no line over 5 or over stock, anchors always present (and first in anchor mode).",
  );
}

main();
