import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-helper";
import { searchCards } from "@/lib/scryfall";

/** GET /api/scryfall/search?q=MTG+card+name — trimmed card list for the picker. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length < 3) return NextResponse.json([]);
  try {
    const cards = await searchCards(q, "cards");
    return NextResponse.json(
      cards.map((c) => ({
        id: c.id,
        name: c.name,
        set: c.set,
        set_name: c.set_name,
        collector_number: c.collector_number,
        rarity: c.rarity,
        value_cents: c.prices.usd
          ? Math.round(Number.parseFloat(c.prices.usd) * 100)
          : c.prices.usd_foil
            ? Math.round(Number.parseFloat(c.prices.usd_foil) * 100)
            : null,
        image_url: c.image_uris?.small ?? null,
        released_at: c.released_at,
      })),
    );
  } catch {
    return apiError("Scryfall unavailable", 502);
  }
}