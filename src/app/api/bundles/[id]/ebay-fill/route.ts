import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import { syncEbaysListings } from "@/lib/ebay/listings";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/bundles/:id/ebay-fill — link an eBay listing and/or fill the
 * bundle's Actual Listing Price + Shipping Fee from it.
 * Body: { ebayListingId? } — a new link; omitted = refresh the current one.
 * Syncs the seller's listings FIRST (falls back to the last-synced row when
 * eBay errors), then copies `price_cents`/`shipping_cents` from the linked
 * `listings` row. Bundle status is never changed. Returns the updated bundle
 * plus `_synced` and the listing title/URI.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const { data: bundle, error } = await supabase
    .from("bundles")
    .select("id, ebay_listing_id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();
  if (error || !bundle) return apiError("Bundle not found", 404);

  const linkRaw = typeof body?.ebayListingId === "string" ? body.ebayListingId.trim() : "";
  const linkId = linkRaw || bundle.ebay_listing_id;
  if (!linkId) return apiError("Pick an eBay listing to link first", 400, { code: "NO_LINK" });

  // Sync first so the price/shipping are current; fall back to stored rows.
  let synced = true;
  try {
    await syncEbaysListings(user.id);
  } catch {
    synced = false;
  }

  const { data: listing } = await supabase
    .from("listings")
    .select("*")
    .eq("owner_id", user.id)
    .eq("ebay_listing_id", linkId)
    .maybeSingle();
  if (!listing) {
    return apiError(
      synced
        ? "That eBay listing isn't among your active listings — it may have ended."
        : "Couldn't reach eBay and there's no stored listing to match — try Sync now on the Listings tab.",
      409,
      { code: "LISTING_NOT_FOUND" },
    );
  }
  if (listing.price_cents == null) {
    return apiError("That listing has no price yet — run Sync now on the Listings tab first.", 409, {
      code: "NO_PRICE",
    });
  }

  const update: Record<string, unknown> = {
    ebay_listing_id: linkId,
    listing_price_cents: listing.price_cents,
  };
  // Shipping unknown (absent from the listing) → keep whatever is stored
  // (manual entries win); present (incl. 0 = free) → overwrite.
  if (listing.shipping_cents != null) update.shipping_cents = listing.shipping_cents;

  const { data: updated, error: updateError } = await supabase
    .from("bundles")
    .update(update)
    .eq("id", id)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (updateError) return apiError(updateError.message, 500, { code: "DB" });

  return NextResponse.json({
    ...updated,
    _synced: synced,
    listingTitle: listing.title,
    listingUri: listing.item_uri,
  });
}
