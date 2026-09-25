import type { ScryfallCard } from "@/lib/types";

const SCRYFALL = "https://api.scryfall.com";

const headers = {
  "User-Agent": "goodwhilly/0.1 (ebay inventory app)",
  Accept: "application/json",
};

function cardFromJson(json: unknown): ScryfallCard {
  const c = json as Record<string, unknown> & {
    id: string;
    name: string;
    set: string;
    set_name: string;
  };
  const prices = (c.prices ?? {}) as Record<string, string | null>;
  return {
    id: c.id,
    name: c.name,
    set: c.set,
    set_name: c.set_name,
    collector_number: String(c.collector_number ?? ""),
    rarity: String(c.rarity ?? ""),
    prices: {
      usd: prices.usd ?? null,
      usd_foil: prices.usd_foil ?? null,
      usd_etched: prices.usd_etched ?? null,
      eur: prices.eur ?? null,
      eur_foil: prices.eur_foil ?? null,
      tix: prices.tix ?? null,
    },
    image_uris: (c.image_uris as ScryfallCard["image_uris"]) ?? undefined,
    released_at: typeof c.released_at === "string" ? c.released_at.slice(0, 10) : null,
    oracle_id: String(c.oracle_id ?? ""),
  };
}

/** Search cards (used when manually adding bulk loose cards). */
export async function searchCards(query: string, unique: "cards" | "prints" = "cards"): Promise<ScryfallCard[]> {
  const url = `${SCRYFALL}/cards/search?q=${encodeURIComponent(query)}&unique=${unique}&format=json&include_extras=false`;
  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: unknown[] };
  return (body.data ?? []).map(cardFromJson);
}

/** Type-ahead for the card lookup field. */
export async function autocomplete(query: string): Promise<string[]> {
  const url = `${SCRYFALL}/cards/autocomplete?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: string[] };
  return body.data ?? [];
}

/** Look up one card by name (+ optional exact set), used for bulk-card price refresh. */
export async function getCardByName(
  name: string,
  set?: string | null,
): Promise<ScryfallCard | null> {
  const url = `${SCRYFALL}/cards/named?fuzzy=${encodeURIComponent(name)}${set ? `&set=${encodeURIComponent(set)}` : ""}&format=json`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return cardFromJson(await res.json());
}

/** Set release date (YYYY-MM-DD) by set code, e.g. "tdm" → 2025-04-11. Never throws. */
export async function getSetReleaseDate(code: string): Promise<string | null> {
  try {
    const res = await fetch(`${SCRYFALL}/sets/${encodeURIComponent(code.toLowerCase().trim())}`, {
      headers,
    });
    if (!res.ok) return null;
    const set = (await res.json()) as { released_at?: unknown };
    return typeof set.released_at === "string" ? set.released_at.slice(0, 10) : null;
  } catch {
    return null;
  }
}

export interface SetMatch {
  code: string;
  name: string;
  released_at: string | null;
}

interface ScryfallSetRow {
  code: string;
  name: string;
  set_type: string;
  released_at: string | null;
}

let setsCache: { rows: ScryfallSetRow[]; fetchedAt: number } | null = null;
const SETS_TTL_MS = 6 * 60 * 60 * 1000;

async function getSets(): Promise<ScryfallSetRow[]> {
  if (setsCache && Date.now() - setsCache.fetchedAt < SETS_TTL_MS) return setsCache.rows;
  try {
    const res = await fetch(`${SCRYFALL}/sets`, { headers });
    if (!res.ok) return setsCache?.rows ?? [];
    const body = (await res.json()) as { data?: unknown[] };
    const rows = (body.data ?? []).map((s) => {
      const r = s as Record<string, unknown>;
      return {
        code: String(r.code ?? ""),
        name: String(r.name ?? ""),
        set_type: String(r.set_type ?? ""),
        released_at: typeof r.released_at === "string" ? r.released_at.slice(0, 10) : null,
      };
    });
    setsCache = { rows, fetchedAt: Date.now() };
    return rows;
  } catch {
    return setsCache?.rows ?? [];
  }
}

const PRODUCT_NOISE_WORDS = new Set([
  "booster", "pack", "packs", "box", "bundle", "display", "case", "cards", "card", "total",
]);
const EXCLUDE_SET_TYPES = new Set(["token", "promo", "memorabilia", "alchemy"]);
const EXCLUDE_SET_NAME = /tokens|promos?|art series|minigames|front cards|beginner box|showcase/i;

const normSet = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * The product line to match: text before the first ":" minus generic retail
 * words ("Play Booster", "Bundle"…). "commander"/"set"/"play" are NOT noise —
 * dropping them once mis-priced Commander Legends as 1994's Legends.
 */
function productLine(name: string): string {
  let line = name.split(":")[0].trim();
  line = line.replace(/^pokemon\s+/i, "").replace(/^dnd\s*-\s*/i, "");
  const kept = line.split(/\s+/).filter((w) => !PRODUCT_NOISE_WORDS.has(w.toLowerCase()));
  return (kept.join(" ") || line).trim();
}

function usableSet(s: ScryfallSetRow): boolean {
  return !EXCLUDE_SET_TYPES.has(s.set_type) && !EXCLUDE_SET_NAME.test(s.name);
}

/** Prefer real main sets when several candidates survive the filters. */
function pickUnique(cands: ScryfallSetRow[]): ScryfallSetRow | null {
  if (!cands.length) return null;
  const main = cands.filter((s) => s.set_type === "expansion" || s.set_type === "core");
  const pool = main.length ? main : cands;
  return pool.length === 1 ? pool[0] : null;
}

/**
 * Match a sealed product's name to the Scryfall set it belongs to. Returns
 * the set + release date, or null when nothing matches confidently — it never
 * guesses (ambiguous or weak matches stay blank so a wrong date can't land on
 * an item). Secret Lair products are excluded: their individual drops are not
 * Scryfall sets (see `lookupSecretLairDate`). 6h in-memory `/sets` cache.
 * Never throws.
 */
export async function findSetForProduct(name: string): Promise<SetMatch | null> {
  try {
    if (/^secret lair/i.test(name.trim())) return null;
    const line = productLine(name);
    const nm = normSet(line);
    if (nm.length < 4) return null;
    const sets = await getSets();

    const exact = sets.find((s) => normSet(s.name) === nm);
    if (exact) {
      return { code: exact.code, name: exact.name, released_at: exact.released_at };
    }

    // Tier 1: the set's name CONTAINS the product line ("Duskmourn" →
    // "Duskmourn: House of Horror"). The reverse direction is deliberately
    // not used — short set names sitting inside product lines (Legends in
    // "Commander Legends…") are how wrong matches happen.
    let cands = sets.filter(
      (s) => usableSet(s) && normSet(s.name).length >= 4 && normSet(s.name).includes(nm),
    );
    let picked = pickUnique(cands);
    if (!picked) {
      // Tier 2: every product word appears in the set name ("Avatar Last
      // Airbender" → "Avatar: The Last Airbender"), unique candidate only.
      const toks = words(line).filter((w) => w.length >= 3);
      if (toks.length >= 2) {
        cands = sets.filter((s) => {
          if (!usableSet(s)) return false;
          const setToks = new Set(words(s.name));
          return toks.every((t) => setToks.has(t));
        });
        picked = pickUnique(cands);
      }
    }
    if (!picked) return null;
    return { code: picked.code, name: picked.name, released_at: picked.released_at };
  } catch {
    return null;
  }
}

/** Fresh prices for many cards at once (75 per request). */
export async function lookupByIds(ids: string[]): Promise<Map<string, ScryfallCard>> {
  const map = new Map<string, ScryfallCard>();
  for (let i = 0; i < ids.length; i += 75) {
    const chunk = ids.slice(i, i + 75);
    const res = await fetch(`${SCRYFALL}/cards/collection`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        identifiers: chunk.map((id) => ({ id })),
      }),
    });
    if (!res.ok) continue;
    const body = (await res.json()) as { data?: unknown[] };
    for (const c of body.data ?? []) {
      const card = cardFromJson(c);
      map.set(card.id, card);
    }
  }
  return map;
}

/** Best USD price for a card (falls back from normal → foil). */
export function cardUsdCents(card: ScryfallCard): number | null {
  const usd = Number.parseFloat(card.prices.usd ?? "");
  if (Number.isFinite(usd) && usd > 0) return Math.round(usd * 100);
  const foil = Number.parseFloat(card.prices.usd_foil ?? "");
  if (Number.isFinite(foil) && foil > 0) return Math.round(foil * 100);
  return null;
}