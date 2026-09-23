import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import {
  lookupSealedPrice,
  primaryCents,
  resolveProductByGtin,
  getApplicationToken,
} from "@/lib/ebay/pricing";
import { ebayConfigured } from "@/lib/ebay/oauth";
import { getCardByName, cardUsdCents } from "@/lib/scryfall";

/**
 * POST /api/ebay/price — eBay price lookup with catalog caching.
 * Body: { upc?, name?, kind }
 *   sealed: Insights sold-data → Browse active (by GTIN), cached on upc_catalog.
 *   bulk_cards: Scryfall current price (no cache needed).
 * Returns { estimateCents, medianCents, sampleCount, source, checkedAt,
 *           product?: { name, image_url } }.
 */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase } = auth;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const upc = body?.upc ? String(body.upc).replace(/\D/g, "").slice(0, 32) : null;
  const name = body?.name ? String(body.name).trim() : null;
  const kind = String(body?.kind ?? "sealed");

  if (kind === "sealed") {
    if (!upc && !name) return apiError("Provide a UPC (preferred) or name for sealed products");
    if (!ebayConfigured()) {
      return apiError(
        "eBay is not configured yet. Add EBAY_CLIENT_ID/SECRET/RUNAME (+ EBAY_RUNAME redirect) to enable price autofill.",
        409,
        { code: "EBAY_NOT_CONFIGURED" },
      );
    }

    // Warm token cache so Insights/Browse calls don't each re-auth.
    await getApplicationToken().catch(() => {});
    const lookup = await lookupSealedPrice({ gtin: upc, query: name });

    let product: { name: string; image_url: string | null } | null = null;
    if (upc) {
      const resolved = await resolveProductByGtin(upc);
      if (resolved?.name) product = { name: resolved.name, image_url: resolved.imageUrl };
    }

    if (upc) {
      await supabase.from("upc_catalog").upsert(
        {
          upc,
          name: product?.name ?? name ?? `Product ${upc}`,
          image_url: product?.image_url ?? null,
          ebay_avg_value_cents: lookup.averageCents,
          ebay_median_value_cents: lookup.medianCents,
          price_source: lookup.source === "none" ? null : lookup.source,
          price_sample_count: lookup.count || null,
          price_checked_at: new Date().toISOString(),
        },
        { onConflict: "upc" },
      );
    }

    return NextResponse.json({
      estimateCents: primaryCents(lookup),
      medianCents: lookup.medianCents,
      sampleCount: lookup.count,
      source: lookup.source === "none" ? "none" : lookup.source,
      checkedAt: new Date().toISOString(),
      product,
    });
  }

  if (kind === "bulk_cards") {
    if (!name) return apiError("Provide a card name");
    const card = await getCardByName(name);
    const cents = card ? cardUsdCents(card) : null;
    return NextResponse.json({
      estimateCents: cents,
      medianCents: null,
      sampleCount: cents != null ? 1 : 0,
      source: cents != null ? "scryfall" : "none",
      checkedAt: new Date().toISOString(),
      card,
    });
  }

  return apiError("kind must be 'sealed' or 'bulk_cards'");
}