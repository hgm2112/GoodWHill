import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

/** GET /api/listings — synced eBay listings for the user. */
export async function GET() {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("owner_id", user.id)
    .order("last_synced_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return apiError(error.message, 500, { code: "DB" });

  return NextResponse.json(data ?? []);
}