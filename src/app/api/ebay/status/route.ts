import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET /api/ebay/status — eBay connection state for the current user. */
export async function GET() {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);

  const configured = Boolean(
    process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && process.env.EBAY_RUNAME,
  );

  // Insight access can only be detected at request time; report config here.
  const admin = createAdminClient();
  const { data } = await admin
    .from("ebay_tokens")
    .select("connected_at, updated_at")
    .eq("owner_id", auth.user.id)
    .maybeSingle();

  return NextResponse.json({
    configured,
    connected: Boolean(data),
    env: process.env.EBAY_ENV === "sandbox" ? "sandbox" : "prod",
    connectedAt: data?.connected_at ?? null,
    lastUpdated: data?.updated_at ?? null,
  });
}