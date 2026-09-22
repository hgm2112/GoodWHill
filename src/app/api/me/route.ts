import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

/**
 * PATCH /api/me — update the signed-in user's profile settings.
 * Currently only { default_location_id } (the remembered quick-scan box).
 */
export async function PATCH(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiError("Invalid body");

  const next: Record<string, unknown> = {};
  if ("default_location_id" in body) {
    const value = body.default_location_id ? String(body.default_location_id) : null;
    if (value) {
      const { data: loc } = await supabase
        .from("locations")
        .select("id")
        .eq("id", value)
        .eq("owner_id", user.id)
        .maybeSingle();
      if (!loc) return apiError("Unknown location", 400);
    }
    next.default_location_id = value;
  }

  const { data, error } = await supabase
    .from("profiles")
    .update(next)
    .eq("id", user.id)
    .select()
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json(data);
}