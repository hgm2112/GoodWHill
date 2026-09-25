import { NextResponse } from "next/server";
import { authUser, apiError, getDateOnly } from "@/lib/api-helper";
import { ITEM_KINDS, normalizeName } from "@/lib/utils";
import { recordPriceHistory } from "@/lib/price-history";

const VALID_KINDS = ITEM_KINDS as readonly string[];

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
    if (!VALID_KINDS.includes(String(body.kind))) {
      return apiError("Invalid kind");
    }
    next.kind = body.kind;
  }
  if ("upc" in body) {
    next.upc = body.upc ? String(body.upc).replace(/\D/g, "").slice(0, 32) : null;
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
  if ("acquired_at" in body) {
    const acquiredAt = getDateOnly(body.acquired_at);
    if (body.acquired_at != null && !acquiredAt) {
      return apiError("acquired_at must be a YYYY-MM-DD date");
    }
    next.acquired_at = acquiredAt;
  }
  if ("active" in body) next.active = body.active !== false;
  if ("location_id" in body) {
    const value = body.location_id ? String(body.location_id) : null;
    if (value) {
      const { data: loc } = await supabase
        .from("locations")
        .select("id")
        .eq("id", value)
        .eq("owner_id", user.id)
        .maybeSingle();
      if (!loc) return apiError("Unknown location", 400);
    }
    next.location_id = value;
  }

  // Identity is (owner, upc, box, name): edits must not collide with another
  // row that already has the resulting UPC + name in the resulting box.
  // Compare case-insensitively (matches items_upc_loc_name_unique).
  const finalUpc = ("upc" in next ? (next.upc as string | null) : existing.upc) ?? existing.upc;
  const finalName = ("name" in next ? (next.name as string | undefined) : existing.name) ?? existing.name;
  const finalLoc =
    ("location_id" in next ? (next.location_id as string | null) : existing.location_id) ?? null;
  if (finalUpc) {
    let dupQuery = supabase
      .from("items")
      .select("id, name")
      .eq("owner_id", user.id)
      .eq("upc", finalUpc)
      .neq("id", existing.id);
    dupQuery = finalLoc ? dupQuery.eq("location_id", finalLoc) : dupQuery.is("location_id", null);
    const { data: rows } = await dupQuery;
    const dup = (rows ?? []).find((r) => normalizeName(r.name) === normalizeName(finalName));
    if (dup) {
      return apiError("Another item with this UPC & name already exists in that box", 409);
    }
  }

  const { data, error } = await supabase
    .from("items")
    .update(next)
    .eq("id", id)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });

  // Value edits record a snapshot (skipped inside the helper when unchanged).
  if ("value_cents" in next) {
    const historyPoint = await recordPriceHistory(supabase, {
      ownerId: user.id,
      itemId: id,
      valueCents: next.value_cents as number | null,
      priceSource: existing.price_source,
    });
    if (historyPoint) return NextResponse.json({ ...data, historyPoint });
  }
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