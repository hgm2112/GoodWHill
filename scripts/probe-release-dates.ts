import { readFileSync } from "node:fs";
import { getCardByName, getSetReleaseDate } from "@/lib/scryfall";
import { resolveReleaseDateDetailed } from "@/lib/release-dates";

/**
 * Verifies the release-date autofill sources (eBay has none — see AGENTS.md):
 * the Scryfall set/card dates, the product-name → set match, and the
 * membership-verified mtg.wiki Secret Lair lookup.
 *
 * Usage:
 *   npx tsx scripts/probe-release-dates.ts --inventory
 *       runs the EXACT production resolver over every item and prints each
 *       pick + source (set name / wiki page) so wrong dates are reviewable
 *       before filling.
 *   npx tsx scripts/probe-release-dates.ts <set_code> [<set_code> ...]
 *   npx tsx scripts/probe-release-dates.ts --card "<card name>" [set_code]
 */

function loadEnvLocal(): void {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.trim().startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // optional
  }
}

async function probeInventory(): Promise<void> {
  loadEnvLocal();
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (check .env.local)");
    process.exit(1);
  }
  const res = await fetch(
    `${baseUrl}/rest/v1/items?select=name,kind,set_code,release_date&order=kind,name`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) {
    console.error(`items query failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const items = (await res.json()) as {
    name: string;
    kind: string;
    set_code: string | null;
    release_date: string | null;
  }[];

  let dated = 0;
  let manual = 0;
  const counts: Record<string, number> = {};
  for (const item of items) {
    const r = await resolveReleaseDateDetailed(item);
    if (r.date) {
      dated++;
      counts[r.source] = (counts[r.source] ?? 0) + 1;
      const source =
        r.source === "set_name" ? `set ${r.detail}` :
        r.source === "set_code" ? `set_code ${r.detail}` :
        r.source === "secret_lair" ? `wiki "${r.detail}"` :
        r.source;
      console.log(`DATE  ${r.date}  [${source}]  ${item.name}`);
    } else {
      manual++;
      console.log(`—     (manual)  ${item.name}`);
    }
  }
  console.log(
    `\n${dated}/${items.length} resolvable · ${manual} stay manual` +
      ` · sources: ${Object.entries(counts).map(([s, n]) => `${s}=${n}`).join(", ")}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error(
      'Usage: npx tsx scripts/probe-release-dates.ts --inventory | <set_code>... | --card "<name>" [set]',
    );
    process.exit(1);
  }

  if (args[0] === "--inventory") {
    await probeInventory();
    return;
  }

  if (args[0] === "--card") {
    const name = args[1];
    if (!name) {
      console.error('Usage: npx tsx scripts/probe-release-dates.ts --card "<card name>" [set_code]');
      process.exit(1);
    }
    const set = args[2] ?? null;
    const card = await getCardByName(name, set);
    if (!card) {
      console.error(`Scryfall found no card for "${name}"${set ? ` in ${set}` : ""}`);
      process.exit(1);
    }
    console.log(`${card.name}${card.set ? ` (${card.set})` : ""} → released_at: ${card.released_at ?? "null"}`);
    return;
  }

  for (const code of args) {
    const date = await getSetReleaseDate(code);
    console.log(`set ${code} → ${date ?? "null (no match)"}`);
  }
}

main();
