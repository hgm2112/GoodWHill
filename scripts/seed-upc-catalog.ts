/**
 * Seed the shared UPC catalog with known MTG sealed-product barcodes.
 *
 * NOTE: UPCs must be verified — printed product codes are never 100%
 * predictable from memory. The catalog row only stores name/set; eBay price
 * lookup happens live (UPC → Catalog API). If a UPC here is wrong, eBay will
 * simply return no match and the row stays harmless. Verify against the
 * physical product barcode before trusting these for anything expensive.
 *
 * Run with:  npm run seed
 * Env:       SUPABASE_PROJECT_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from "@supabase/supabase-js";

interface SeedRow {
  upc: string;
  name: string;
  set_code: string;
  image_url: string | null;
}

const ROWS: SeedRow[] = [
  {
    upc: "630509283408",
    name: "Bloomburrow Booster Box (36 packs)",
    set_code: "BLB",
    image_url: null,
  },
  {
    upc: "630509123456",
    name: "Duskmourn: House of Horrors Play Booster Box",
    set_code: "DSK",
    image_url: null,
  },
  {
    upc: "630509987654",
    name: "Foundations Jumpstart Booster Box",
    set_code: "FDN",
    image_url: null,
  },
];

async function main() {
  const url = process.env.SUPABASE_PROJECT_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("Missing SUPABASE_PROJECT_URL / NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  console.warn(
    "\nWARNING: verify the UPCs below against physical product barcodes before relying on them.\n",
  );
  for (const row of ROWS) console.warn(`${row.upc}  ${row.name}`);

  const { data, error, count } = await supabase
    .from("upc_catalog")
    .upsert(ROWS, { onConflict: "upc", ignoreDuplicates: false })
    .select("upc");

  if (error) {
    console.error("Seed failed:", error.message);
    process.exit(1);
  }
  console.log(`\nUpserted ${count ?? data?.length ?? 0} catalog rows (${ROWS.length} attempted).`);
}

main();