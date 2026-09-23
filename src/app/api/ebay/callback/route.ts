import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { exchangeCodeForTokens, storeUserTokens, ebayConfigured } from "@/lib/ebay/oauth";

/**
 * GET /api/ebay/callback?code=…&state=… — eBay lands here after the user
 * authorizes. Exchanges the code for a refresh token and stores it encrypted.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("ebay_oauth_state")?.value;

  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, request.url));

  if (error || !code) {
    return redirectTo(`/settings?error=${encodeURIComponent(error || "no_code")}`);
  }
  if (expectedState && state !== expectedState) {
    return redirectTo("/settings?error=state_mismatch");
  }

  if (!ebayConfigured()) {
    return redirectTo("/settings?error=not_configured");
  }

  // Resolve the current user from the session cookie.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll() {},
      },
    },
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirectTo("/login?error=auth_callback");

  try {
    const tokens = await exchangeCodeForTokens(code);
    await storeUserTokens(user.id, tokens);
  } catch (err) {
    console.error("[ebay callback]", err);
    return redirectTo("/settings?error=token_exchange");
  }

  return redirectTo("/settings?success=ebay_connected");
}