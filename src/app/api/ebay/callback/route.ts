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

  const appUrl = process.env.APP_URL || request.headers.get("origin") || "";
  const settingsUrl = `${appUrl}/settings?success=ebay_connected`;

  if (error || !code) {
    return NextResponse.redirect(
      `${appUrl}/settings?error=${encodeURIComponent(error || "no_code")}`,
    );
  }
  if (expectedState && state !== expectedState) {
    return NextResponse.redirect(`${appUrl}/settings?error=state_mismatch`);
  }

  if (!ebayConfigured()) {
    return NextResponse.redirect(`${appUrl}/settings?error=not_configured`);
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
  if (!user) return NextResponse.redirect(`${appUrl}/login?error=auth_callback`);

  try {
    const tokens = await exchangeCodeForTokens(code);
    await storeUserTokens(user.id, tokens);
  } catch (err) {
    console.error("[ebay callback]", err);
    return NextResponse.redirect(`${appUrl}/settings?error=token_exchange`);
  }

  return NextResponse.redirect(settingsUrl);
}