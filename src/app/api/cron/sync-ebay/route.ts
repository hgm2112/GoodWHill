import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncEbaysListings } from "@/lib/ebay/listings";

/**
 * Vercel Cron endpoint (daily). Syncs active listings for every user that
 * has connected an eBay account. Guards itself with CRON_SECRET.
 *
 * crons:
 *   - schedule: "0 9 * * *"
 *     path: /api/cron/sync-ebay
 */
export const maxDuration = 120;

export async function GET(request: Request) {
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"; support that and
  // the older ?secret= query form (when CRON_SECRET is unset locally, anyone
  // can call this — it is a no-op without a service-role key anyway).
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const querySecret = new URL(request.url).searchParams.get("secret");
  const secretOk = process.env.CRON_SECRET
    ? (bearer === process.env.CRON_SECRET || querySecret === process.env.CRON_SECRET)
    : true;
  if (!secretOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  const admin = createAdminClient();
  const { data: users } = await admin.from("ebay_tokens").select("owner_id");
  const results: Record<string, unknown> = {};
  for (const row of users ?? []) {
    try {
      results[row.owner_id] = await syncEbaysListings(row.owner_id);
    } catch (err) {
      results[row.owner_id] = { error: err instanceof Error ? err.message : "failed" };
    }
  }
  return NextResponse.json({ ok: true, users: results });
}