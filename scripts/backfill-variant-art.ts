/**
 * Backfill box art for sealed deck variants ("Set: Variant" names) whose
 * image_url predates name-aware artwork and still carries the shared-pack/UPC
 * image. Resolution runs once per distinct name (one Browse call each) and
 * only rows where the resolver returns a NEW image are updated (idempotent).
 * Search pools are narrowed by the item's UPC when present.
 *
 * Run with:  npm run backfill-art
 * Env:       .env.local (loaded automatically) — NEXT_PUBLIC_SUPABASE_URL,
 *            SUPABASE_SERVICE_ROLE_KEY, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET
 */
import { readFileSync } from "node:fs";
import { nameHasVariant, resolveVariantImage } from "@/lib/ebay/pricing";

interface VariantItem {
  id: string;
  name: string;
  upc: string | null;
  image_url: string | null;
}

async function rest(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
}

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
    // .env.local is optional when the env vars are already exported.
  }
}

function short(url: string | null): string {
  return (url ?? "").split("/").pop() ?? "NULL";
}

async function main() {
  loadEnvLocal();
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!baseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (check .env.local)");
    process.exit(1);
  }

  const listRes = await rest(
    `${baseUrl}/rest/v1/items?select=id,name,upc,image_url&kind=in.(sealed,open)&limit=1000`,
  );
  if (!listRes.ok) {
    console.error("Failed to load items:", listRes.status, await listRes.text());
    process.exit(1);
  }
  const items = (await listRes.json()) as VariantItem[];

  const variants = items.filter((it) => nameHasVariant(it.name));
  if (!variants.length) {
    console.log("No sealed deck-variant items to backfill.");
    return;
  }

  const imageCache = new Map<string, string | null>();
  let updated = 0;
  let failures = 0;

  for (const it of variants) {
    console.log(`\n${it.name}`);
    try {
      if (!imageCache.has(it.name)) {
        imageCache.set(it.name, await resolveVariantImage(it.name, it.upc));
      }
      const fresh = imageCache.get(it.name) ?? null;
      console.log(`  ${short(it.image_url)} -> ${short(fresh)}`);
      if (fresh && fresh !== it.image_url) {
        const updateRes = await fetch(`${baseUrl}/rest/v1/items?id=eq.${it.id}`, {
          method: "PATCH",
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ image_url: fresh }),
        });
        if (!updateRes.ok) {
          console.error("  update failed:", updateRes.status, await updateRes.text());
          failures++;
          continue;
        }
        updated++;
      }
    } catch (e) {
      console.error("  resolve failed:", (e as Error).message);
      failures++;
    }
  }

  console.log(`\nBackfill done: ${updated} updated, ${failures} failures.`);
}

main();