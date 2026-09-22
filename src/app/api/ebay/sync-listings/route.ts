import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import { syncEbaysListings } from "@/lib/ebay/listings";

/** POST /api/ebay/sync-listings — pull the user's active listings now. */
export async function POST() {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);

  try {
    const stats = await syncEbaysListings(auth.user.id);
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    if (err instanceof Error && err.message === "EBAY_NOT_CONNECTED") {
      return apiError("Connect your eBay account first.", 409, { code: "EBAY_NOT_CONNECTED" });
    }
    console.error("[sync-listings]", err);
    return apiError(err instanceof Error ? err.message : "Sync failed", 502);
  }
}