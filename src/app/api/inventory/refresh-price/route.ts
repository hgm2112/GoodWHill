import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import { lookupSealedPrice, resolveProductByGtin } from "@/lib/ebay/pricing";
import { ebayConfigured } from "@/lib/ebay/oauth";
import { getCardByName, cardUsdCents } from "@/lib/scryfall";

/**
 * POST /api/inventory/refresh-price — value autofill for one item.
 *   sealed      → eBay Insights (sold) then Browse (active) by UPC; updates
 *                 name/image from the product if those are empty.
 *   bulk_cards  → Scryfall current price for the card.
 *   other       → manual only (no-op).
 */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const itemId = String(body?.itemId ?? "");
  if (!itemId) return apiError("itemId required");

  const { data: item, error } = await supabase
    .from("items")
    .select("*")
    .eq("id", itemId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (error || !item) return apiError("Item not found", 404);

  const update: Record<string, unknown> = {
    price_checked_at: new Date().toISOString(),
  };

  if (item.kind === "sealed") {
    if (!item.upc) {
      return apiError("Sealed items need a UPC before eBay can price them", 400);
    }
    if (!ebayConfigured()) {
      return apiError(
        "eBay is not configured yet. Add EBAY_CLIENT_ID/SECRET/RUNAME to use price autofill; for now set the value manually.",
        409,
        { code: "EBAY_NOT_CONFIGURED" },
      );
    }

    const gtin = item.upc;
    const lookup = await lookupSealedPrice({ gtin, query: item.name });
    const filledValue = lookup.averageCents ?? lookup.medianCents ?? null;

    update.value_cents = filledValue;
    update.ebay_avg_value_cents = filledValue;
    update.price_source = lookup.source === "none" ? "manual" : lookup.source;
    update.price_sample_count = lookup.count;

    // Best-effort product resolution to backfill an empty name/image.
    if (!item.name || !item.image_url) {
      const product = await resolveProductByGtin(gtin);
      if (product?.name && product.name !== item.name) {
        if (!item.name) update.name = product.name;
        if (!item.image_url && product.imageUrl) update.image_url = product.imageUrl;
      }
    }
  } else if (item.kind === "bulk_cards") {
    const card = await getCardByName(item.name, item.set_code);
    if (!card) {
      return apiError("Could not find this card on Scryfall", 404, { code: "SCRYFAIL" });
    }
    const cents = cardUsdCents(card);
    update.value_cents = cents;
    update.ebay_avg_value_cents = cents;
    update.price_source = "scryfall";
    update.price_sample_count = 1;
    if (!item.image_url && card.image_uris?.small) update.image_url = card.image_uris.small;
  } else {
    return apiError("This item kind has no automatic price source; set the value manually.", 400);
  }

  const { data: updated, error: updateError } = await supabase
    .from("items")
    .update(update)
    .eq("id", itemId)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (updateError) return apiError(updateError.message, 500, { code: "DB" });

  return NextResponse.json(updated);
}