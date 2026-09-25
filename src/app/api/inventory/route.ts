import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam, getDateOnly, todayDateOnly } from "@/lib/api-helper";
import { ITEM_KINDS, normalizeName } from "@/lib/utils";
import { recordPriceHistory } from "@/lib/price-history";

// Union of ITEM_KINDS for `.includes()` checks.
const VALID_KINDS = ITEM_KINDS as readonly string[];

/** GET /api/inventory?kind=&q=&location_id=&unassigned= */
export async function GET(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind");
  const q = searchParams.get("q")?.trim();
  const locationId = searchParams.get("location_id");
  const unassigned = searchParams.get("unassigned") === "true";

  // Paused items are included: the inventory view shows them (marked), and
  // callers that care (sale form, bundle generation) filter themselves.
  let query = supabase
    .from("items")
    .select("*")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });

  if (kind && kind !== "all") query = query.eq("kind", kind);
  if (unassigned) {
    query = query.is("location_id", null);
  } else if (locationId && locationId !== "all") {
    query = query.eq("location_id", locationId);
  }
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
  if (!VALID_KINDS.includes(kindRaw)) {
    return apiError("Invalid kind");
  }
  const upc = body.upc ? String(body.upc).replace(/\D/g, "").slice(0, 32) : null;
  const acquiredAt = getDateOnly(body.acquired_at);
  if (body.acquired_at != null && !acquiredAt) {
    return apiError("acquired_at must be a YYYY-MM-DD date");
  }
  const releaseDate = getDateOnly(body.release_date);
  if (body.release_date != null && !releaseDate) {
    return apiError("release_date must be a YYYY-MM-DD date");
  }

  // Name-aware sealed duplicate check: products that share a UPC (e.g. Final
  // Fantasy commander decks) are separate rows keyed by name, so the same UPC
  // is only a duplicate when the (owner, upc, box, name) tuple already exists.
  if (kindRaw === "sealed" && upc) {
    const rawLoc = body.location_id ? String(body.location_id) : null;
    let locationId: string | null = null;
    if (rawLoc) {
      const { data: loc } = await supabase
        .from("locations")
        .select("id")
        .eq("id", rawLoc)
        .eq("owner_id", user.id)
        .maybeSingle();
      locationId = loc?.id ?? null;
    }

    let dupQuery = supabase
      .from("items")
      .select("id, name")
      .eq("owner_id", user.id)
      .eq("upc", upc);
    dupQuery = locationId
      ? dupQuery.eq("location_id", locationId)
      : dupQuery.is("location_id", null);
    const { data: rows } = await dupQuery;
    const dup = (rows ?? []).find((r) => normalizeName(r.name) === normalizeName(name));
    if (dup) {
      return apiError(
        locationId ? `An item with this name already exists in that box` : "An item with this UPC & name already exists",
        409,
        { existingItemId: dup.id },
      );
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
    // Explicit value wins (even null when the form cleared it); API callers
    // that omit the field get today.
    acquired_at: "acquired_at" in body ? acquiredAt : todayDateOnly(),
    // Never guessed — the product's release date is unknown until told.
    release_date: "release_date" in body ? releaseDate : null,
    location_id: null,
  };

  // Validate location belongs to the user.
  if (body.location_id) {
    const { data: loc } = await supabase
      .from("locations")
      .select("id")
      .eq("id", String(body.location_id))
      .eq("owner_id", user.id)
      .maybeSingle();
    if (!loc) return apiError("Unknown location", 400);
    payload.location_id = loc.id;
  } else {
    payload.location_id = null;
  }

  const { data, error } = await supabase.from("items").insert(payload).select().single();
  if (error) return apiError(error.message, 500, { code: "DB" });

  await supabase.from("item_movements").insert({
    item_id: data.id,
    owner_id: user.id,
    delta: payload.quantity,
    reason: "add",
    note: "Initial stock",
  });

  // First price snapshot (baseline) for a value set at creation time.
  await recordPriceHistory(supabase, {
    ownerId: user.id,
    itemId: data.id,
    valueCents: payload.value_cents as number | null,
    priceSource: "manual",
  });

  return NextResponse.json(data);
}