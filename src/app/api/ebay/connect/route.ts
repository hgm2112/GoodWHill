import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import { EBAY_PATHS, EBAY_SCOPES, ebayConfigured } from "@/lib/ebay/oauth";

/** GET /api/ebay/connect — start the OAuth flow (redirects to eBay). */
export async function GET() {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  if (!ebayConfigured()) {
    return apiError(
      "eBay is not configured on the server yet. Add EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RUNAME.",
      409,
    );
  }

  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: process.env.EBAY_CLIENT_ID!,
    response_type: "code",
    redirect_uri: process.env.EBAY_RUNAME!,
    scope: EBAY_SCOPES,
    state,
    prompt: "login",
  });

  // Remember state for verification in the callback (short-lived cookie).
  const res = NextResponse.redirect(`${EBAY_PATHS.authorize}?${params.toString()}`);
  res.cookies.set("ebay_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
  });
  return res;
}