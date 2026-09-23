import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

/**
 * POST /api/scan/name — name ONE inventory row for a scanned UPC.
 *   Body: { upc, item_id, product_name?, sub_name? }
 *   - `product_name` sets the shared catalog "main" name for the UPC (e.g.
 *     "Final Fantasy"). When omitted, it's resolved from eBay by GTIN when
 *     keys are configured, else the existing catalog name is kept.
 *   - `sub_name` is the deck variant (e.g. "Limit Break"); with a sub name the
 *     full item name becomes `${product_name}: ${sub_name}`.
 *   - The rename applies to that single item only — products that share a UPC
 *     keep their own distinct sub names.
 *   - Fails with 409 when another item already has the resulting full name in
 *     the same box.
 *   Returns { item }.
 */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const upc = String(body?.upc ?? "").replace(/\D/g, "").slice(0, 32);
  if (!upc) return apiError("upc required");
  const itemId = String(body?.item_id ?? "");
  if (!itemId) return apiError("item_id required");

  const { data: item, error: itemError } = await supabase
    .from("items")
    .select("*")
    .eq("id", itemId)
    .eq("owner_id", user.id)
    .eq("active", true)
    .maybeSingle();
  if (itemError || !item) return apiError("Item not found", 404, { code: "NOT_FOUND" });
  if (item.upc !== upc) return apiError("upc does not match this item", 400);
  if (item.kind !== "sealed") return apiError("Only sealed products can be named by barcode", 400);

  const { data: catalog } = await supabase
    .from("upc_catalog")
    .select("name, image_url")
    .eq("upc", upc)
    .maybeSingle();

  let productName = body?.product_name ? String(body.product_name).trim() : null;
  let imageUrl: string | null = null;

  if (productName && productName === catalog?.name) productName = catalog.name;

  if (!productName) {
    // Try eBay for the main product name; otherwise keep the existing catalog
    // name (or fall back to the placeholder).
    if (catalog?.name && !/^Product\s+\d+$/.test(catalog.name)) {
      productName = catalog.name;
    } else {
      const { resolveProductByGtin } = await import("@/lib/ebay/pricing");
      try {
        const product = await resolveProductByGtin(upc);
        if (product?.name) {
          productName = product.name;
          imageUrl = product.imageUrl ?? null;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!productName) {
    return apiError(
      "Couldn't find this product on eBay yet — add your eBay keys in Settings, or type the product name.",
      404,
      { code: "NOT_FOUND", upc },
    );
  }

  const subName = body?.sub_name ? String(body.sub_name).trim() : null;
  const fullName = subName ? `${productName}: ${subName}` : productName;

  // Update the shared catalog when the main name changed.
  const catalogNameChanged = !catalog?.name || catalog.name !== productName;
  if (catalogNameChanged) {
    await supabase.from("upc_catalog").upsert(
      {
        upc,
        name: productName,
        image_url: imageUrl ?? catalog?.image_url ?? null,
      },
      { onConflict: "upc" },
    );
    // Keep the user's placeholder rows (`Product <upc>` or the old catalog
    // name) in step so unnamed scans keep merging into one row.
    await supabase
      .from("items")
      .update({ name: productName })
      .eq("owner_id", user.id)
      .eq("upc", upc)
      .in("name", [catalog?.name ?? "", `Product ${upc}`]);
  }

  // Another item with the same (upc, box, full name) would collapse into this
  // one — direct the user to add stock to that row instead.
  let dupQuery = supabase
    .from("items")
    .select("id")
    .eq("owner_id", user.id)
    .eq("upc", upc)
    .eq("name", fullName)
    .neq("id", itemId);
  dupQuery = item.location_id ? dupQuery.eq("location_id", item.location_id) : dupQuery.is("location_id", null);
  const { data: dup } = await dupQuery.maybeSingle();
  if (dup) {
    return apiError("An item with this name already exists in that box — add stock to it instead.", 409, {
      code: "NAME_EXISTS",
    });
  }

  const patch: Record<string, unknown> = { name: fullName };
  const resolvedImage = imageUrl ?? (catalogNameChanged ? catalog?.image_url : null);
  if (resolvedImage && !item.image_url) patch.image_url = resolvedImage;
  const { data: updated, error: updateError } = await supabase
    .from("items")
    .update(patch)
    .eq("id", itemId)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (updateError) return apiError(updateError.message, 500, { code: "DB" });

  return NextResponse.json({ item: updated });
}