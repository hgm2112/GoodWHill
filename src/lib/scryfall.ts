import type { ScryfallCard } from "@/lib/types";

const SCRYFALL = "https://api.scryfall.com";

const headers = {
  "User-Agent": "GoodWHill/0.1 (ebay inventory app)",
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