import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/inventory/:id — update an item. */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;

  const { data: existing } = await supabase
    .from("items")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!existing) return apiError("Item not found", 404);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiError("Invalid body");

  const next: Record<string, unknown> = {};
  if ("name" in body) next.name = String(body.name ?? "").trim() || existing.name;
  if ("kind" in body) {
    if (!["sealed", "bulk_cards", "other"].includes(String(body.kind))) {
      return apiError("Invalid kind");
    }
    next.kind = body.kind;
  }
  if ("upc" in body) {
    const upc = body.upc ? String(body.upc).replace(/\D/g, "").slice(0, 32) : null;
    if (upc && upc !== existing.upc) {
      const { data: dup } = await supabase
        .from("items")
        .select("id")
        .eq("owner_id", user.id)
        .eq("upc", upc)
        .maybeSingle();
      if (dup) return apiError("Another item already has this UPC", 409);
    }
    next.upc = upc;
  }
  if ("set_code" in body)
    next.set_code = body.set_code ? String(body.set_code).toUpperCase().trim() || null : null;
  if ("category" in body)
    next.category = body.category ? String(body.category).trim() || null : null;
  if ("unit_cost_cents" in body) next.unit_cost_cents = body.unit_cost_cents ?? null;
  if ("value_cents" in body) next.value_cents = body.value_cents ?? null;
  if ("image_url" in body)
    next.image_url = body.image_url ? String(body.image_url).trim() || null : null;
  if ("notes" in body) next.notes = body.notes ? String(body.notes).trim() || null : null;
  if ("active" in body) next.active = body.active !== false;

  const { data, error } = await supabase
    .from("items")
    .update(next)
    .eq("id", id)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json(data);
}

/** DELETE /api/inventory/:id — remove an item. */
export async function DELETE(_request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;

  const { data: existing } = await supabase
    .from("items")
    .select("id, quantity")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!existing) return apiError("Item not found", 404);
  if (existing.quantity > 0) {
    return apiError(
      "This item still has stock. Set quantity to 0 first, or deactivate it instead.",
      409,
    );
  }

  const { error } = await supabase
    .from("items")
    .delete()
    .eq("id", id)
    .eq("owner_id", user.id);
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json({ ok: true });
}