import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

/** GET /api/drafts — all listing drafts for the user. */
export async function GET() {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { data, error } = await supabase
    .from("listing_drafts")
    .select("*")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json(data ?? []);
}