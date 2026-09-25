import { getCardByName, getSetReleaseDate, findSetForProduct } from "@/lib/scryfall";
import { lookupSecretLairDate } from "@/lib/secret-lair";

export type ReleaseDateSource = "card" | "set_code" | "secret_lair" | "set_name" | "none";

export interface ReleaseDateResolution {
  date: string | null;
  source: ReleaseDateSource;
  /** Matched set name / card name / wiki page title, for eyeballing. */
  detail?: string;
}

/**
 * Best-effort product release date for a blank `release_date`, in order:
 *   loose      → the card's own printing date (Scryfall `released_at`);
 *   set_code   → the set's release date by code;
 *   sealed/open→ Secret Lairs via mtg.wiki (membership-verified superdrop
 *                pages), everything else via the product-name → Scryfall set
 *                match. eBay is NOT a source (Browse search never returns
 *                item aspects; TCG listing details only carry a year-only
 *                "Year Manufactured"). Never throws; when nothing credible
 *                matches the date simply stays blank — never guessed.
 */
export async function resolveReleaseDateDetailed(
  item: { kind: string; name: string; set_code?: string | null },
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
    if (item.kind === "sealed" || item.kind === "open") {
      const name = item.name.trim();
      if (/^secret lair/i.test(name)) {
        const sl = await lookupSecretLairDate(name);
        if (sl?.date) return { date: sl.date, source: "secret_lair", detail: sl.pageTitle };
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
  item: { kind: string; name: string; set_code?: string | null },
  knownCard?: { released_at: string | null; name?: string } | null,
): Promise<string | null> {
  return (await resolveReleaseDateDetailed(item, knownCard)).date;
}
