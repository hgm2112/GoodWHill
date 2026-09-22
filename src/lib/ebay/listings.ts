import { createAdminClient } from "@/lib/supabase/admin";
import { MARKETPLACE_ID, EBAY_PATHS, extractPriceCents } from "@/lib/ebay/oauth";

export interface SyncStats {
  inserted: number;
  updated: number;
  total: number;
}

interface ParsedListing {
  listingId: string;
  title: string;
  priceCents: number | null;
  currency: string;
  status: string;
  availableQuantity: number | null;
  soldQuantity: number | null;
  itemHref: string | null;
  images: string[];
  endsAt: string | null;
}

function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return null;
}

function dig(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function parseImages(images: unknown): string[] {
  const out: string[] = [];
  const push = (u: unknown) => {
    if (typeof u === "string" && u.startsWith("http")) out.push(u);
  };
  if (Array.isArray(images)) {
    for (const img of images) {
      if (typeof img === "string") push(img);
      else if (img && typeof img === "object") {
        push(dig(img, ["imageUrl"]));
        push(dig(img, ["url"]));
      }
    }
  } else if (images && typeof images === "object") {
    push(dig(images, ["images", "imageUrl"]));
  }
  return [...new Set(out)];
}

/**
 * Normalizes one entry from the Listings API. The API has had several
 * response shapes since its launch, so we defensively probe multiple field
 * paths (Offer / listing / activeListing containers).
 */
function parseListing(raw: Record<string, unknown>): ParsedListing | null {
  const listingId = firstString(
    raw.itemId,
    raw.listingId,
    dig(raw, ["listing", "itemId"]),
    dig(raw, ["offer", "listing", "listingId"]),
    dig(raw, ["activeListing", "itemId"]),
  );
  if (!listingId) return null;

  const priceCents =
    extractPriceCents(raw.price) ??
    extractPriceCents(dig(raw, ["offer", "price"])) ??
    extractPriceCents(dig(raw, ["listing", "price"])) ??
    extractPriceCents(dig(raw, ["activeListing", "price"]));

  const title = firstString(
    raw.title,
    dig(raw, ["listing", "title"]),
    dig(raw, ["activeListing", "title"]),
  );

  const status =
    firstString(raw.status, raw.sellingState) ??
    firstString(dig(raw, ["listing", "status"])) ??
    "ACTIVE";

  const available =
    typeof raw.availableQuantity === "number"
      ? raw.availableQuantity
      : (dig(raw, ["offer", "availableQuantity"]) as number | undefined) ?? null;

  const sold =
    typeof raw.soldQuantity === "number"
      ? raw.soldQuantity
      : (dig(raw, ["offer", "soldQuantity"]) as number | undefined) ?? null;

  const endsAt = firstString(
    raw.listingEndDate as string,
    dig(raw, ["listing", "listingEndDate"]) as string,
  )?.replace("Z", "Z");

  const itemHref = firstString(
    raw.itemHref,
    dig(raw, ["listing", "itemHref"]) as string,
  );

  return {
    listingId,
    title: title ?? `eBay listing ${listingId}`,
    priceCents,
    currency: "USD",
    status,
    availableQuantity: available,
    soldQuantity: sold,
    itemHref,
    images: parseImages(raw.images),
    endsAt: endsAt ?? null,
  };
}

/**
 * Pulls the seller's active listings via the Listings API and upserts them.
 * https://developer.ebay.com/api-docs/sell/listings/resources/listing/methods/getListing
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

  const url = new URL(`${EBAY_PATHS.api}/sell/listings/v1/listing`);
  url.searchParams.set("limit", "200");
  url.searchParams.set("status", "ACTIVE");

  let inserted = 0;
  let updated = 0;
  let total = 0;

  for (let page = 0; page < 20; page++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`eBay listings sync failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const body = (await res.json()) as Record<string, unknown>;
    const rawListings = Array.isArray(body.listings)
      ? (body.listings as unknown[])
      : Array.isArray(body.activeListings)
        ? (body.activeListings as unknown[])
        : [];

    for (const raw of rawListings) {
      const parsed = parseListing(raw as Record<string, unknown>);
      if (!parsed) continue;

      const payload = {
        ebay_listing_id: parsed.listingId,
        title: parsed.title,
        price_cents: parsed.priceCents,
        currency: parsed.currency,
        status: parsed.status,
        quantity_available: parsed.availableQuantity,
        quantity_sold: parsed.soldQuantity,
        item_uri: parsed.itemHref,
        image_urls: parsed.images,
        ended_at: parsed.endsAt,
        last_synced_at: new Date().toISOString(),
      };

      const { data: existing } = await supabase
        .from("listings")
        .select("id")
        .eq("owner_id", ownerId)
        .eq("ebay_listing_id", parsed.listingId)
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

    const next = body.next as Record<string, unknown> | undefined;
    const nextHref = typeof body.href === "string" ? body.href : null;
    const continuation =
      firstString(dig(next, ["continuationToken"]) as string, next?.continuationToken as string) ??
      null;
    const href = nextHref ?? firstString((body.next as string) ?? null);

    if (continuation) {
      url.searchParams.set("continuationToken", continuation);
    } else if (href) {
      const nextUrl = new URL(href);
      url.searchParams.set("continuationToken", nextUrl.searchParams.get("continuationToken") ?? "");
      if (!url.searchParams.get("continuationToken")) break;
    } else {
      break;
    }
  }

  return { inserted, updated, total };
}