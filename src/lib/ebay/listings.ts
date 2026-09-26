import { createAdminClient } from "@/lib/supabase/admin";
import { extractPriceCents } from "@/lib/ebay/oauth";

export interface SyncStats {
  inserted: number;
  updated: number;
  total: number;
}

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const TRADING_HEADERS = {
  "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
  "X-EBAY-API-SITEID": "0",
  "X-EBAY-API-VERSION": "1207",
  "X-EBAY-API-APP-NAME": process.env.EBAY_CLIENT_ID ?? "",
  "X-EBAY-API-DEV-NAME": process.env.EBAY_DEV_ID ?? "",
  "X-EBAY-API-CERT-NAME": process.env.EBAY_CLIENT_SECRET ?? "",
  "Content-Type": "text/xml",
} as const;

function grab(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface TradingItem {
  itemId: string;
  title: string;
  priceCents: number | null;
  shippingCents: number | null;
  currency: string;
  quantityAvailable: number | null;
  quantitySold: number | null;
  listingStatus: string;
  endTime: string | null;
  imageUrl: string | null;
}

/** One <Item> from the GetMyeBaySelling ActiveList payload. */
function parseTradingItem(xml: string): TradingItem | null {
  const itemId = grab(xml, "ItemID");
  if (!itemId) return null;

  const title = grab(xml, "Title");

  const priceMatch =
    xml.match(/<CurrentPrice([^>]*)>([\s\S]*?)<\/CurrentPrice>/) ??
    xml.match(/<BuyItNowPrice([^>]*)>([\s\S]*?)<\/BuyItNowPrice>/) ??
    xml.match(/<StartPrice([^>]*)>([\s\S]*?)<\/StartPrice>/);
  const currency = priceMatch?.[1]?.match(/currencyID="([^"]+)"/)?.[1] ?? "USD";

  const endTime = grab(xml, "EndTime");
  const listingStatus = grab(xml, "ListingStatus") ?? "ACTIVE";
  const gallery = grab(xml, "GalleryURL");

  // First ShippingServiceCost under ShippingDetails = the dominant service's
  // flat rate (absent for some free-shipping/calculated listings → null).
  const shippingCost = grab(xml, "ShippingServiceCost");

  return {
    itemId,
    title: title ? xmlUnescape(title) : "",
    priceCents: priceMatch ? extractPriceCents(priceMatch[2]) : null,
    shippingCents: shippingCost != null ? extractPriceCents(shippingCost) : null,
    currency,
    quantityAvailable: Number(grab(xml, "QuantityAvailable") ?? grab(xml, "Quantity") ?? NaN) || null,
    quantitySold: Number(grab(xml, "QuantitySold") ?? NaN) || null,
    listingStatus,
    endTime: endTime && listingStatus !== "ACTIVE" ? endTime : null,
    imageUrl: gallery?.startsWith("http") ? gallery : null,
  };
}

function buildRequest(accessToken: string, pageNumber: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
  <RequesterCredentials><eBayAuthToken>${accessToken}</eBayAuthToken></RequesterCredentials>
</GetMyeBaySellingRequest>`;
}

/**
 * Pulls the seller's currently-active listings via the legacy Trading API
 * `GetMyeBaySelling` (ActiveList) and upserts them into `listings`.
 *
 * The newer Listings API (`/sell/listings/v1/listing`) needs the `sell.listings`
 * scope, which is not granted to legacy eBay apps, and the Inventory API only
 * covers listings created through it (this account lists via the classic flow,
 * so it has zero inventory items). The Trading API works with the existing
 * OAuth token passed in `<RequesterCredentials><eBayAuthToken>` plus the
 * App/Dev/Cert ID headers, with no extra scope. ActiveList is capped at ~400
 * results, which is fine for this seller.
 *
 * https://developer.ebay.com/api-docs/legacy/selling/retired/overview.html
 */
export async function syncEbaysListings(ownerId: string): Promise<SyncStats> {
  if (!process.env.EBAY_DEV_ID) {
    throw new Error("EBAY_NOT_CONFIGURED: EBAY_DEV_ID is required for listing sync");
  }

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

  for (let page = 1; page <= 30; page++) {
    const res = await fetch(TRADING_API, {
      method: "POST",
      headers: { ...TRADING_HEADERS, "X-EBAY-API-CALL-NAME": "GetMyeBaySelling" },
      body: buildRequest(accessToken, page),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`eBay listing sync failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const xml = await res.text();
    const ack = grab(xml, "Ack");
    if (ack !== "Success") {
      const messages = [...xml.matchAll(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/g)]
        .slice(0, 2)
        .map((m) => m[1].trim());
      throw new Error(`eBay listing sync failed: ${messages.join("; ") || "unknown Trading API error"}`);
    }

    const items = [...xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)]
      .map((m) => parseTradingItem(m[1]))
      .filter((item): item is TradingItem => Boolean(item && item.listingStatus !== "Ended"));

    for (const item of items) {
      const payload = {
        ebay_listing_id: item.itemId,
        title: item.title || `eBay listing ${item.itemId}`,
        price_cents: item.priceCents,
        shipping_cents: item.shippingCents,
        currency: item.currency,
        status: item.listingStatus || "ACTIVE",
        quantity_available: item.quantityAvailable,
        quantity_sold: item.quantitySold,
        item_uri: `https://www.ebay.com/itm/${item.itemId}`,
        image_urls: item.imageUrl ? [item.imageUrl] : [],
        ended_at: item.endTime,
        last_synced_at: new Date().toISOString(),
      };

      const { data: existing } = await supabase
        .from("listings")
        .select("id")
        .eq("owner_id", ownerId)
        .eq("ebay_listing_id", item.itemId)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase.from("listings").update(payload).eq("id", existing.id);
        if (!error) updated++;
      } else {
        const { error } = await supabase
          .from("listings")
          .insert({ ...payload, owner_id: ownerId });
        if (!error) inserted++;
      }
      total++;
    }

    const pages = Number(grab(xml, "TotalNumberOfPages") ?? "0");
    if (!pages || page >= pages) break;
  }

  return { inserted, updated, total };
}