import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import { lookupSealedPrice, primaryCents, resolveNameImage, resolveProductByGtin, resolveVariantImage, nameHasVariant } from "@/lib/ebay/pricing";
import { ebayConfigured } from "@/lib/ebay/oauth";
import { getCardByName, cardUsdCents } from "@/lib/scryfall";

export const maxDuration = 120;

type PriceResult =
  | { ok: true; update: Record<string, unknown> }
  | { ok: false; error: string; status: number; code?: string };

/**
 * Never overwrite a manual value: when an item already has value_cents, drop
 * the price fields from the update (a picture/name fill still applies).
 */
function withoutManualValue(update: Record<string, unknown>, valueCents: number | null) {
  if (valueCents == null) return update;
  const next = { ...update };
  delete next.value_cents;
  delete next.ebay_avg_value_cents;
  delete next.price_source;
  delete next.price_sample_count;
  return next;
}

/**
 * Value autofill for one item.
 *   sealed/open → eBay Insights (sold) then Browse (active) by UPC; falls
 *                 back to a name search for UPC-less products; updates
 *                 name/image from the product if those are empty. Opened items
 *                 are priced on sealed-condition listings.
 *   loose       → Scryfall current price for the card.
 *   used/other  → manual only (error).
 */
async function priceOne(item: {
  id: string;
  kind: string;
  name: string;
  upc: string | null;
  set_code: string | null;
  image_url: string | null;
  value_cents: number | null;
}): Promise<PriceResult> {
  const update: Record<string, unknown> = {
    price_checked_at: new Date().toISOString(),
  };

  if (item.kind === "sealed" || item.kind === "open") {
    if (!item.upc && !item.name) {
      return { ok: false, status: 400, error: "Sealed/open items need a UPC or name before eBay can price them" };
    }
    if (!ebayConfigured()) {
      return {
        ok: false,
        status: 409,
        code: "EBAY_NOT_CONFIGURED",
        error: "eBay is not configured yet. Add EBAY_CLIENT_ID/SECRET/RUNAME to use price autofill; for now set the value manually.",
      };
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
      return { ok: false, status: 404, code: "SCRYFAIL", error: "Could not find this card on Scryfall" };
    }
    const cents = cardUsdCents(card);
    update.value_cents = cents;
    update.ebay_avg_value_cents = cents;
    update.price_source = "scryfall";
    update.price_sample_count = 1;
    if (!item.image_url && card.image_uris?.small) update.image_url = card.image_uris.small;
  } else {
    return {
      ok: false,
      status: 400,
      error: `${item.kind} items have no automatic price source; set the value manually.`,
    };
  }

  return { ok: true, update: withoutManualValue(update, item.value_cents) };
}

/**
 * POST /api/inventory/refresh-price — value autofill.
 *   { itemId }            → price one item (returns the updated row).
 *   { scope: "unpriced" } → price every item without a value or picture
 *                           (value_cents null OR image_url null), up to 50,
 *                           sequential with per-item try/catch and per-UPC/name
 *                           dedupe. Manual values are never overwritten.
 *                           Returns { refreshed, failed, skipped, errors[] }.
 */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (body?.scope === "unpriced") {
    const { data: items, error } = await supabase
      .from("items")
      .select("id,kind,name,upc,set_code,image_url,value_cents")
      .eq("owner_id", user.id)
      .in("kind", ["sealed", "open", "loose"])
      .or("value_cents.is.null,image_url.is.null")
      .limit(50);
    if (error) return apiError(error.message, 500, { code: "DB" });

    const cache = new Map<string, Record<string, unknown>>();
    let refreshed = 0;
    let failed = 0;
    const errors: { name: string | null; error: string }[] = [];

    for (const item of items ?? []) {
      try {
        const cacheKey = `${item.upc ?? ""}|${item.name ?? ""}`;
        const result: PriceResult = cache.has(cacheKey)
          ? { ok: true, update: withoutManualValue(cache.get(cacheKey) as Record<string, unknown>, item.value_cents) }
          : await priceOne(item);
        if (!result.ok) {
          failed++;
          errors.push({ name: item.name, error: result.error });
          continue;
        }
        if (!cache.has(cacheKey)) cache.set(cacheKey, result.update);
        const { error: updateError } = await supabase
          .from("items")
          .update(result.update)
          .eq("id", item.id)
          .eq("owner_id", user.id);
        if (updateError) {
          failed++;
          errors.push({ name: item.name, error: updateError.message });
        } else {
          refreshed++;
        }
      } catch {
        failed++;
        errors.push({ name: item.name, error: "Price lookup failed" });
      }
    }

    return NextResponse.json({
      refreshed,
      failed,
      skipped: (items?.length ?? 0) - refreshed - failed,
      errors,
    });
  }

  const itemId = String(body?.itemId ?? "");
  if (!itemId) return apiError("itemId required");

  const { data: item, error } = await supabase
    .from("items")
    .select("*")
    .eq("id", itemId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (error || !item) return apiError("Item not found", 404);

  const result = await priceOne(item);
  if (!result.ok) return apiError(result.error, result.status, result.code ? { code: result.code } : undefined);

  const { data: updated, error: updateError } = await supabase
    .from("items")
    .update(result.update)
    .eq("id", itemId)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (updateError) return apiError(updateError.message, 500, { code: "DB" });

  return NextResponse.json(updated);
}