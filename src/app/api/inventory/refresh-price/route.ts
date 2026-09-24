import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import { lookupSealedPrice, primaryCents, resolveNameImage, resolveProductByGtin, resolveVariantImage, nameHasVariant } from "@/lib/ebay/pricing";
import { ebayConfigured } from "@/lib/ebay/oauth";
import { getCardByName, cardUsdCents } from "@/lib/scryfall";

/**
 * POST /api/inventory/refresh-price — value autofill for one item.
 *   sealed/open → eBay Insights (sold) then Browse (active) by UPC; falls
 *                 back to a name search for UPC-less products; updates
 *                 name/image from the product if those are empty. Opened items
 *                 are priced on sealed-condition listings.
 *   loose       → Scryfall current price for the card.
 *   used/other  → manual only (no-op).
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

  if (item.kind === "sealed" || item.kind === "open") {
    if (!item.upc && !item.name) {
      return apiError("Sealed/open items need a UPC or name before eBay can price them", 400);
    }
    if (!ebayConfigured()) {
      return apiError(
        "eBay is not configured yet. Add EBAY_CLIENT_ID/SECRET/RUNAME to use price autofill; for now set the value manually.",
        409,
        { code: "EBAY_NOT_CONFIGURED" },
      );
    }

    const lookup = await lookupSealedPrice({ gtin: item.upc ?? null, query: item.name });
    const filledValue = primaryCents(lookup);

    if (filledValue != null) update.value_cents = filledValue;
    update.ebay_avg_value_cents = lookup.averageCents;
    update.price_source = lookup.source === "none" ? "manual" : lookup.source;
    update.price_sample_count = lookup.count;

    // Box art by name: deck variants (shared barcode) and UPC-less products
    // can't rely on the catalog image, so their art comes from a matching
    // listing — refreshed every time so stale art heals. The UPC narrows the
    // search pool to the right product family. A failed lookup either keeps
    // whatever art is already there.
    if (nameHasVariant(item.name)) {
      update.image_url = (await resolveVariantImage(item.name, item.upc).catch(() => null)) ?? item.image_url;
    } else if (!item.upc && item.name) {
      update.image_url = (await resolveNameImage(item.name).catch(() => null)) ?? item.image_url;
    }
    if (!item.name || !item.image_url) {
      const product = item.upc ? await resolveProductByGtin(item.upc) : null;
      if (product?.name && product.name !== item.name) {
        if (!item.name) update.name = product.name;
        if (!item.image_url && product.imageUrl) update.image_url = update.image_url ?? product.imageUrl;
      }
    }
  } else if (item.kind === "loose") {
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
    return apiError(`${item.kind} items have no automatic price source; set the value manually.`, 400);
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