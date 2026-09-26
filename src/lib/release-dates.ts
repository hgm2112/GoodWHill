import { getCardByName, getSetReleaseDate, findSetForProduct } from "@/lib/scryfall";
import { lookupSecretLairDate } from "@/lib/secret-lair";
import { fetchPokemonSchedule } from "@/lib/releases";

export type ReleaseDateSource =
  | "card"
  | "set_code"
  | "upc_catalog"
  | "secret_lair"
  | "pokemon_schedule"
  | "set_name"
  | "none";

export interface ReleaseDateResolution {
  date: string | null;
  source: ReleaseDateSource;
  /** Matched set name / card name / wiki page title, for eyeballing. */
  detail?: string;
}

/** What the resolver needs from an inventory row. `upc` unlocks the catalog. */
export interface ReleaseDateItem {
  kind: string;
  name: string;
  set_code?: string | null;
  upc?: string | null;
}

// --- shared upc_catalog cache (seeded + earlier discoveries) ----------------

// Plain REST (service-role), like the probe scripts: createAdminClient() inits
// the realtime socket, which throws under plain Node (tsx scripts, Node 20).
// Only NON-null dates are cached — a seed may land later in the same process.
const catalogDateCache = new Map<string, string>();

async function lookupCatalogDate(upc: string): Promise<string | null> {
  const cached = catalogDateCache.get(upc);
  if (cached) return cached;
  try {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) return null;
    const res = await fetch(
      `${base}/rest/v1/upc_catalog?upc=eq.${encodeURIComponent(upc)}&select=release_date`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as { release_date: string | null }[];
    const date = rows[0]?.release_date ?? null;
    if (date) {
      if (catalogDateCache.size > 2000) catalogDateCache.clear();
      catalogDateCache.set(upc, date);
    }
    return date;
  } catch {
    return null;
  }
}

// --- Pokémon: official press-site schedule ----------------------------------

const POKEMON_NAME_RE = /^pok[eé]mon\b/i;

/** Product/boilerplate words that carry no set identity. */
const POKEMON_STOPWORDS = new Set([
  "pokemon", "pokémon", "tcg", "trading", "card", "cards", "game", "games",
  "booster", "pack", "packs", "box", "boxes", "display", "case", "bundle",
  "blister", "tin", "tins", "collection", "elite", "trainer", "etb", "build",
  "battle", "sleeved", "hanger", "blaster", "mega", "evolution", "series",
  "set", "special", "promo", "promos", "the", "a", "an", "of", "and", "with",
  "in", "for", "to",
]);

/** Set-identifying tokens of an item name ("Chaos Rising" of "Pokemon …"). */
function pokemonTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/^pok[eé]mon\b/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !POKEMON_STOPWORDS.has(t));
}

/**
 * Match an item name against the official schedule. Every significant token
 * must appear word-boundary in the matched row(s); resolves only when all
 * matches agree on ONE date — 0 or genuinely ambiguous → null (never guessed).
 */
async function lookupPokemonScheduleDate(
  name: string,
): Promise<{ date: string; row: string } | null> {
  const tokens = pokemonTokens(name);
  if (!tokens.length) return null;
  const rows = await fetchPokemonSchedule();
  const matches = rows.filter((row) =>
    row.date !== null && tokens.every((t) => new RegExp(`\\b${t}\\b`, "i").test(row.name)),
  );
  const dates = [...new Set(matches.map((r) => r.date))];
  if (dates.length !== 1 || !dates[0]) return null;
  return { date: dates[0], row: matches[0].name };
}

/**
 * Best-effort product release date for a blank `release_date`, in order:
 *   loose      → the card's own printing date (Scryfall `released_at`);
 *   set_code   → the set's release date by code;
 *   upc        → `upc_catalog.release_date` (seeded manually or cached from
 *                an earlier discovery — one barcode, one date);
 *   sealed/open→ Secret Lairs via mtg.wiki (membership-verified superdrop
 *                pages), Pokémon names via the official press-site schedule
 *                (press.pokemon.com), everything else via the product-name →
 *                Scryfall set match. eBay is NOT a source (Browse search
 *                never returns item aspects; TCG listing details only carry a
 *                year-only "Year Manufactured"). Never throws; when nothing
 *                credible matches the date simply stays blank — never guessed.
 */
export async function resolveReleaseDateDetailed(
  item: ReleaseDateItem,
  knownCard?: { released_at: string | null; name?: string } | null,
): Promise<ReleaseDateResolution> {
  try {
    if (item.kind === "loose") {
      const card = knownCard ?? (await getCardByName(item.name, item.set_code ?? null));
      if (card?.released_at) {
        return { date: card.released_at, source: "card", detail: card.name };
      }
    }
    if (item.set_code) {
      const fromSet = await getSetReleaseDate(item.set_code);
      if (fromSet) return { date: fromSet, source: "set_code", detail: item.set_code };
    }
    if (item.upc) {
      const fromCatalog = await lookupCatalogDate(item.upc);
      if (fromCatalog) return { date: fromCatalog, source: "upc_catalog", detail: item.upc };
    }
    if (item.kind === "sealed" || item.kind === "open") {
      const name = item.name.trim();
      if (/^secret lair/i.test(name)) {
        const sl = await lookupSecretLairDate(name);
        if (sl?.date) return { date: sl.date, source: "secret_lair", detail: sl.pageTitle };
        return { date: null, source: "none" };
      }
      if (POKEMON_NAME_RE.test(name)) {
        const p = await lookupPokemonScheduleDate(name);
        if (p) return { date: p.date, source: "pokemon_schedule", detail: p.row };
        return { date: null, source: "none" };
      }
      const match = await findSetForProduct(name);
      if (match?.released_at) {
        return { date: match.released_at, source: "set_name", detail: match.name };
      }
    }
  } catch {
    /* best effort */
  }
  return { date: null, source: "none" };
}

/** Date-only wrapper used by the refresh-price route. */
export async function resolveReleaseDate(
  item: ReleaseDateItem,
  knownCard?: { released_at: string | null; name?: string } | null,
): Promise<string | null> {
  return (await resolveReleaseDateDetailed(item, knownCard)).date;
}
