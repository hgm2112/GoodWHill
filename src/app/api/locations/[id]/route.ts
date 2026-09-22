import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/locations/:id — rename a location: { name }. */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;

  const { data: existing } = await supabase
    .from("locations")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!existing) return apiError("Location not found", 404);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const name = String(body?.name ?? "").trim();
  if (!name) return apiError("Location name is required");
  if (name.length > 80) return apiError("Location name is too long");

  const { data: dup } = await supabase
    .from("locations")
    .select("id")
    .eq("owner_id", user.id)
    .eq("name", name)
    .neq("id", id)
    .maybeSingle();
  if (dup) return apiError("A location with this name already exists", 409);

  const { data, error } = await supabase
    .from("locations")
    .update({ name })
    .eq("id", id)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json(data);
}

/** DELETE /api/locations/:id — removes the box. Items and the profile
 *  default referencing it fall back to Unassigned (FK ON DELETE SET NULL). */
export async function DELETE(_request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;

  const { data: existing } = await supabase
    .from("locations")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!existing) return apiError("Location not found", 404);

  const { error } = await supabase
    .from("locations")
    .delete()
    .eq("id", id)
    .eq("owner_id", user.id);
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json({ ok: true });
}