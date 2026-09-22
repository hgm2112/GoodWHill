import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

/**
 * GET  /api/locations — the user's named storage locations plus the
 *   remembered quick-scan default ({ locations, default_location_id }).
 * POST /api/locations — create a location: { name }
 */
export async function GET() {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const { data: locations, error } = await supabase
    .from("locations")
    .select("*")
    .eq("owner_id", user.id)
    .order("name", { ascending: true });
  if (error) return apiError(error.message, 500, { code: "DB" });

  const { data: profile } = await supabase
    .from("profiles")
    .select("default_location_id")
    .eq("id", user.id)
    .maybeSingle();

  return NextResponse.json({
    locations: locations ?? [],
    default_location_id: profile?.default_location_id ?? null,
  });
}

export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const name = String(body?.name ?? "").trim();
  if (!name) return apiError("Location name is required");
  if (name.length > 80) return apiError("Location name is too long");

  const { data: dup } = await supabase
    .from("locations")
    .select("id")
    .eq("owner_id", user.id)
    .eq("name", name)
    .maybeSingle();
  if (dup) return apiError("A location with this name already exists", 409);

  const { data, error } = await supabase
    .from("locations")
    .insert({ owner_id: user.id, name })
    .select()
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json(data);
}