import { createAdminClient } from "@/lib/supabase/admin";
import { MARKETPLACE_ID, EBAY_PATHS, extractPriceCents } from "@/lib/ebay/oauth";

export interface SyncStats {
  inserted: number;
  updated: number;
  total: number;
}

function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return null;
}

interface ParsedOffer {
  offerId: string | null;
  sku: string | null;
  listingId: string | null;
  status: string;
  priceCents: number | null;
  currency: string;
  availableQuantity: number | null;
}

/** One active offer from GET /sell/inventory/v1/offer. */
function parseOffer(raw: Record<string, unknown>): ParsedOffer | null {
  const offerId = firstString(raw.offerId);
  const listingId = firstString(raw.listingId);
  if (!offerId && !listingId) return null;

  const price = raw.price as Record<string, unknown> | undefined;
  return {
    offerId,
    sku: firstString(raw.sku),
    listingId,
    status: firstString(raw.status) ?? "ACTIVE",
    priceCents: extractPriceCents(raw.price),
    currency: typeof price?.currency === "string" ? price.currency : "USD",
    availableQuantity: typeof raw.availableQuantity === "number" ? raw.availableQuantity : null,
  };
}

/** ProductTitle + images for an inventory SKU (best effort). */
async function fetchInventoryItem(
  accessToken: string,
  sku: string,
): Promise<{ title: string | null; images: string[] }> {
  const url = new URL(
    `${EBAY_PATHS.api}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
  );
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Accept-Language": "en-US",
      Accept: "application/json",
    },
  });
  if (!res.ok) return { title: null, images: [] };

  const body = (await res.json()) as Record<string, unknown>;
  const product = (body.product as Record<string, unknown> | undefined) ?? {};
  const title = firstString(product.title);
  const images: string[] = [];
  const urls = Array.isArray(product.imageUrls) ? (product.imageUrls as unknown[]) : [];
  for (const u of urls) {
    if (typeof u === "string" && u.startsWith("http")) images.push(u);
  }
  return { title, images };
}

/**
 * Pulls the seller's active listings via the Inventory API and upserts them.
 *
 * The legacy Listings API (/sell/listings/v1/listing) needs the `sell.listings`
 * scope, which is not granted to legacy eBay apps. The Inventory API offer set
 * needs only `sell.inventory.readonly` and reflects the seller's active
 * fixed-price listings. Sold-quantity is not reported by this API, so
 * quantity_sold is null.
 *
 * https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/getOffers
 */
export async function syncEbaysListings(ownerId: string): Promise<SyncStats> {
  const supabase = createAdminClient();
  let accessToken: string;

  const { getUserAccessToken } = await import("@/lib/ebay/oauth");
  try {
    accessToken = await getUserAccessToken(ownerId);
  } catch (err) {
    if (err instanceof Error && err.message === "EBAY_NOT_CONNECTED") throw err;
    // One forced refresh attempt then re-try.
    accessToken = await getUserAccessToken(ownerId, true);
  }

  let inserted = 0;
  let updated = 0;
  let total = 0;
  let offset = 0;

  for (let page = 0; page < 20; page++) {
    const url = new URL(`${EBAY_PATHS.api}/sell/inventory/v1/offer`);
    url.searchParams.set("limit", "200");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("status", "ACTIVE");
    url.searchParams.set("format", "FIXED_PRICE");

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`eBay inventory sync failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const body = (await res.json()) as Record<string, unknown>;
    const offers = Array.isArray(body.offers) ? (body.offers as unknown[]) : [];
    const pageTotal = typeof body.total === "number" ? body.total : 0;

    for (const raw of offers) {
      const offer = parseOffer(raw as Record<string, unknown>);
      if (!offer) continue;

      const listingId = offer.listingId ?? offer.offerId;
      if (!listingId) continue;

      let title: string | null = null;
      let images: string[] = [];
      if (offer.sku) {
        const item = await fetchInventoryItem(accessToken, offer.sku);
        title = item.title;
        images = item.images;
      }

      const payload = {
        ebay_listing_id: listingId,
        title: title ?? `eBay listing ${listingId}`,
        price_cents: offer.priceCents,
        currency: offer.currency,
        status: offer.status,
        quantity_available: offer.availableQuantity,
        quantity_sold: null,
        item_uri: offer.listingId ? `https://www.ebay.com/itm/${offer.listingId}` : null,
        image_urls: images,
        ended_at: null,
        last_synced_at: new Date().toISOString(),
      };

      const { data: existing } = await supabase
        .from("listings")
        .select("id")
        .eq("owner_id", ownerId)
        .eq("ebay_listing_id", listingId)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("listings")
          .update(payload)
          .eq("id", existing.id);
        if (!error) updated++;
      } else {
        const { error } = await supabase
          .from("listings")
          .insert({ ...payload, owner_id: ownerId });
        if (!error) inserted++;
      }
      total++;
    }

    const next = firstString(body.next as string);
    if (next && next.includes("offset=")) {
      try {
        offset = Number(new URL(next).searchParams.get("offset")) || offset + offers.length;
      } catch {
        offset += offers.length;
      }
    } else if (offers.length === 0 || pageTotal <= offset + offers.length) {
      break;
    } else {
      offset += offers.length;
    }
  }

  return { inserted, updated, total };
}