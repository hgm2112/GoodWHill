import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam } from "@/lib/api-helper";

/** GET /api/inventory?kind=&q=&includeInactive= */
export async function GET(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind");
  const q = searchParams.get("q")?.trim();
  const includeInactive = searchParams.get("includeInactive") === "true";

  let query = supabase
    .from("items")
    .select("*")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });

  if (kind && kind !== "all") query = query.eq("kind", kind);
  if (!includeInactive) query = query.eq("active", true);
  if (q) {
    query = query.or(`name.ilike.%${q}%,upc.ilike.%${q}%,set_code.ilike.%${q}%`);
  }

  const { data, error } = await query;
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json(data);
}

/** POST /api/inventory — create an inventory item. */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiError("Invalid body");

  const name = String(body.name ?? "").trim();
  if (!name) return apiError("Name is required");

  const kindRaw = String(body.kind ?? "other");
  if (!["sealed", "bulk_cards", "other"].includes(kindRaw)) {
    return apiError("Invalid kind");
  }
  const upc = body.upc ? String(body.upc).replace(/\D/g, "").slice(0, 32) : null;

  if (kindRaw === "sealed" && upc) {
    const { data: dup } = await supabase
      .from("items")
      .select("id")
      .eq("owner_id", user.id)
      .eq("upc", upc)
      .maybeSingle();
    if (dup) {
      return apiError("An item with this UPC already exists", 409, { existingItemId: dup.id });
    }
  }

  const payload = {
    owner_id: user.id,
    name,
    kind: kindRaw,
    upc,
    set_code: body.set_code ? String(body.set_code).toUpperCase().trim() || null : null,
    category: body.category ? String(body.category).trim() || null : null,
    quantity: Math.max(0, getIntParam(String(body.quantity ?? 0)) ?? 0),
    unit_cost_cents: body.unit_cost_cents ?? null,
    value_cents: body.value_cents ?? null,
    image_url: body.image_url ? String(body.image_url).trim() || null : null,
    notes: body.notes ? String(body.notes).trim() || null : null,
    active: body.active !== false,
  };

  const { data, error } = await supabase.from("items").insert(payload).select().single();
  if (error) return apiError(error.message, 500, { code: "DB" });

  await supabase.from("item_movements").insert({
    item_id: data.id,
    owner_id: user.id,
    delta: payload.quantity,
    reason: "add",
    note: "Initial stock",
  });

  return NextResponse.json(data);
}