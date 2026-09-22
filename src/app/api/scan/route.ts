import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam } from "@/lib/api-helper";

/**
 * GET  /api/scan?upc=XXXXXXXX — resolve a scanned barcode.
 *   Returns { catalog, items } where items are the user's inventory rows that
 *   carry this UPC (or match the catalog product).
 *
 * POST /api/scan — quick "I have this item" flow.
 *   Body: { upc, delta, name?, set_code?, image_url?, location_id? }
 *   1. Upserts the UPC into the shared catalog with a best-effort product
 *      name (from the request, or auto-resolved by GTIN when eBay configured).
 *   2. Creates a sealed item if the user has none for that UPC (stamped with
 *      `location_id` when provided). Existing items are left where they are.
 *   3. Adjusts stock by `delta` and logs a movement.
 *   Returns { item, catalog }.
 */
export async function GET(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const { searchParams } = new URL(request.url);
  const upc = searchParams.get("upc")?.replace(/\D/g, "").slice(0, 32);

  if (!upc) return apiError("upc query param required");

  const { data: catalog } = await supabase
    .from("upc_catalog")
    .select("*")
    .eq("upc", upc)
    .eq("active", true)
    .maybeSingle();

  const { data: items } = await supabase
    .from("items")
    .select("*")
    .eq("owner_id", user.id)
    .eq("active", true)
    .eq("upc", upc)
    .order("created_at", { ascending: false });

  return NextResponse.json({ catalog, items: items ?? [] });
}

export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const upc = String(body?.upc ?? "").replace(/\D/g, "").slice(0, 32);
  if (!upc) return apiError("upc required");
  const delta = getIntParam(String(body?.delta ?? "1")) ?? 1;
  if (delta <= 0 || delta > 10000) return apiError("delta must be 1..10000");

  // 1. UPSERT catalog entry.
  const { data: existingCatalog } = await supabase
    .from("upc_catalog")
    .select("*")
    .eq("upc", upc)
    .maybeSingle();

  let catalogName = body?.name ? String(body.name).trim() : null;
  let imageUrl = body?.image_url ? String(body.image_url).trim() : null;

  if (existingCatalog) {
    catalogName = existingCatalog.name;
    imageUrl = existingCatalog.image_url;
  } else {
    // Auto-resolve product name by GTIN when eBay is configured.
    if (!catalogName) {
      const { resolveProductByGtin } = await import("@/lib/ebay/pricing");
      try {
        const product = await resolveProductByGtin(upc);
        if (product?.name) {
          catalogName = product.name;
          imageUrl = imageUrl ?? product.imageUrl;
        }
      } catch {
        /* ignore */
      }
    }
    if (!catalogName) catalogName = `Product ${upc}`;

    const setCode = body?.set_code ? String(body.set_code).toUpperCase().slice(0, 12) : null;
    await supabase.from("upc_catalog").upsert(
      {
        upc,
        name: catalogName,
        set_code: setCode,
        image_url: imageUrl,
      },
      { onConflict: "upc" },
    );
  }

  const finalCatalog = { upc, name: catalogName, image_url: imageUrl } as Record<string, unknown>;

  // 2. Find or create the user's item for this UPC.
  let item: { id: string; quantity: number } | null = null;
  const { data: existingItem } = await supabase
    .from("items")
    .select("*")
    .eq("owner_id", user.id)
    .eq("upc", upc)
    .maybeSingle();

  if (existingItem) {
    item = existingItem;
  } else {
    const setCode = body?.set_code ? String(body.set_code).toUpperCase().slice(0, 12) : null;
    const rawLoc = body?.location_id ? String(body.location_id) : null;
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
    const { data: created, error } = await supabase
      .from("items")
      .insert({
        owner_id: user.id,
        name: catalogName!,
        kind: "sealed",
        upc,
        set_code: setCode,
        image_url: imageUrl,
        location_id: locationId,
        quantity: 0,
        category: "MTG Sealed",
      })
      .select()
      .single();
    if (error) return apiError(error.message, 500, { code: "DB" });
    item = created;
    finalCatalog.createdItem = true;
  }

  // 3. Add stock.
  if (!item) return apiError("Item could not be created", 500);
  const newQuantity = (item.quantity ?? 0) + delta;
  const { data: updated, error } = await supabase
    .from("items")
    .update({ quantity: newQuantity })
    .eq("id", item.id)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });

  await supabase.from("item_movements").insert({
    item_id: item.id,
    owner_id: user.id,
    delta,
    reason: "add",
    note: `Scanned barcode ${upc}`,
  });

  return NextResponse.json({ item: updated, catalog: finalCatalog });
}