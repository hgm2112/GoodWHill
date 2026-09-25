import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam, getDateOnly, todayDateOnly } from "@/lib/api-helper";
import { normalizeName } from "@/lib/utils";

/**
 * GET  /api/scan?upc=XXXXXXXX — resolve a scanned barcode.
 *   Returns { catalog, items } where items are the user's inventory rows that
 *   carry this UPC (or match the catalog product).
 *
 * POST /api/scan — quick "I have this item" flow.
 *   Body: { upc, delta, name?, set_code?, image_url?, location_id?, category? }
 *   1. Upserts the UPC into the shared catalog with a best-effort product
 *      name (from the request, or auto-resolved by GTIN when eBay configured).
 *   2. Finds the sealed item for (owner, upc, box, name) — `name` defaults to
 *      the catalog main name (a resolved product title or `Product <upc>`),
 *      else the caller-provided name for a specific deck row — and merges
 *      stock into it; creates the row if missing.
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
  //    `product_name` is the catalog "main" name (e.g. "Final Fantasy");
  //    `name` is the full item name for a specific deck row (e.g.
  //    "Final Fantasy: Limit Break") and must never become the shared title.
  const { data: existingCatalog } = await supabase
    .from("upc_catalog")
    .select("*")
    .eq("upc", upc)
    .maybeSingle();

  const userProvidedMain = body?.product_name ? String(body.product_name).trim() : null;
  let catalogName = userProvidedMain;
  let imageUrl = body?.image_url ? String(body.image_url).trim() : null;

  const tryResolveFromEbay = async () => {
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
  };

  const backfillPlaceholders = async (oldName: string) => {
    if (!catalogName || oldName === catalogName) return;
    await supabase
      .from("items")
      .update({ name: catalogName })
      .eq("owner_id", user.id)
      .eq("upc", upc)
      .in("name", [oldName, `Product ${upc}`]);
  };

  if (existingCatalog) {
    const oldName = existingCatalog.name;
    if (!catalogName) catalogName = oldName;
    if (!imageUrl) imageUrl = existingCatalog.image_url;
    if (userProvidedMain && userProvidedMain !== oldName) {
      // User named the product during scan — persist it to the shared catalog
      // and keep the placeholder rows in step.
      await supabase
        .from("upc_catalog")
        .update({ name: userProvidedMain, image_url: imageUrl ?? existingCatalog.image_url })
        .eq("upc", upc);
      await backfillPlaceholders(oldName);
    } else if (/^Product\s+\d+$/.test(catalogName ?? "")) {
      // Upgrade an unresolved placeholder catalog to a real name via eBay.
      await tryResolveFromEbay();
      if (catalogName && catalogName !== oldName) {
        await supabase
          .from("upc_catalog")
          .update({ name: catalogName, image_url: imageUrl ?? existingCatalog.image_url })
          .eq("upc", upc);
        await backfillPlaceholders(oldName);
      }
    }
  } else {
    // Auto-resolve product name by GTIN when eBay is configured.
    if (!catalogName && body?.name) catalogName = String(body.name).trim();
    if (!catalogName) {
      await tryResolveFromEbay();
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

  // 2. Find or create the user's item for this UPC + box + name.
  //    Products that share a barcode (e.g. Final Fantasy commander decks) live
  //    as SEPARATE rows keyed by their full name. The item name is the catalog
  //    "main" name (e.g. `Final Fantasy`) for unnamed scans, or the caller-
  //    provided name (a deck row like `Final Fantasy: Limit Break`) when the
  //    scan targets a specific existing row.
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
  const effectiveName = body?.name ? String(body.name).trim() : (catalogName ?? `Product ${upc}`);

  // Match name the same way the unique index does (case-insensitive trimmed) so
  // a deck typed with different casing merges instead of violating the index.
  const findItem = async () => {
    let query = supabase
      .from("items")
      .select("*")
      .eq("owner_id", user.id)
      .eq("upc", upc);
    query = locationId ? query.eq("location_id", locationId) : query.is("location_id", null);
    const { data: rows } = await query;
    return (rows ?? []).find((r) => normalizeName(r.name) === normalizeName(effectiveName)) ?? null;
  };

  let item: { id: string; quantity: number; location_id: (string | null) | undefined } | null = null;
  item = await findItem();

  if (!item) {
    const setCode = body?.set_code ? String(body.set_code).toUpperCase().slice(0, 12) : null;
    const category = body?.category ? String(body.category).trim().slice(0, 64) : "";
    // Deck variants (shared barcode) get their own box art by name — the item
    // carries it while the shared catalog keeps the generic pack image.
    let itemImageUrl = imageUrl;
    const providedName = body?.name ? String(body.name).trim() : null;
    if (providedName) {
      try {
        const { nameHasVariant, resolveVariantImage } = await import("@/lib/ebay/pricing");
        if (nameHasVariant(providedName)) {
          itemImageUrl = (await resolveVariantImage(providedName)) ?? imageUrl;
        }
      } catch {
        /* ignore */
      }
    }
    const { data: created, error } = await supabase
      .from("items")
      .insert({
        owner_id: user.id,
        name: effectiveName,
        kind: "sealed",
        upc,
        set_code: setCode,
        image_url: itemImageUrl,
        location_id: locationId,
        quantity: 0,
        active: true,
        category: category || "MTG Sealed",
        // New rows stamp the scan date (client sends its local date; server
        // falls back to today UTC when the field is missing/invalid).
        acquired_at: getDateOnly(body?.acquired_at) ?? todayDateOnly(),
      })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        // Race: another request inserted the same row a moment ago — merge into it.
        item = await findItem();
        if (!item) return apiError(error.message, 500, { code: "DB" });
      } else {
        return apiError(error.message, 500, { code: "DB" });
      }
    } else {
      item = created;
      finalCatalog.createdItem = true;
    }
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