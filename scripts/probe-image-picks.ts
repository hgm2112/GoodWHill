import { readFileSync } from "node:fs";
import { nameHasVariant, matchingPool, pickBestImage } from "@/lib/ebay/pricing";

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
loadEnvLocal();
const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const rest = (url: string) =>
  fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });

async function main() {
  const res = await rest(
    `${baseUrl}/rest/v1/items?select=id,name,upc,image_url&kind=in.(sealed,open)&limit=1000`,
  );
  const items = (await res.json()) as { id: string; name: string; upc: string | null; image_url: string | null }[];
  const variants = items.filter((it) => nameHasVariant(it.name));
  for (const it of variants) {
    const pool = await matchingPool(it.name, it.upc);
    const pick = pickBestImage(pool);
    console.log(`\n--- ${it.name} (UPC ${it.upc ?? "-"})`);
    console.log(`  old: ${it.image_url ?? "NULL"}`);
    console.log(`  pick: ${pick ?? "NULL"}`);
    for (const e of pool.slice(0, 5)) {
      console.log(`    [${e.cents}] ${e.title}`);
      console.log(`        ${e.image}`);
    }
  }
}
main();