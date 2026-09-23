import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

/**
 * POST /api/scan/name — rename ONE inventory row for a scanned UPC.
 *   Body: { upc, item_id, name? }
 *   - `name` is trusted (user typed it) when provided.
 *   - Otherwise the real product name is resolved from eBay by GTIN
 *     (resolveProductByGtin) when eBay keys are configured.
 *   - The rename applies to that single item only — products that share a UPC
 *     (e.g. Final Fantasy commander decks) keep their own distinct names.
 *   - Fails with 409 when another item already has this name in the same box.
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
  if (itemError) return apiError("Item not found", 404, { code: "NOT_FOUND" });
  if (!item) return apiError("Item not found", 404, { code: "NOT_FOUND" });
  if (item.upc !== upc) return apiError("upc does not match this item", 400);
  if (item.kind !== "sealed") return apiError("Only sealed products can be named by barcode", 400);

  let name = body?.name ? String(body.name).trim() : null;
  let imageUrl: string | null = null;

  if (!name) {
    const { resolveProductByGtin } = await import("@/lib/ebay/pricing");
    try {
      const product = await resolveProductByGtin(upc);
      name = product?.name ?? null;
      imageUrl = product?.imageUrl ?? null;
    } catch {
      /* ignore */
    }
  }

  if (!name) {
    return apiError(
      "Couldn't find this product on eBay yet — add your eBay keys in Settings, or type a name instead.",
      404,
      { code: "NOT_FOUND", upc },
    );
  }

  // Another item with the same (upc, box, name) would collapse into this one —
  // direct the user to add stock to that row instead.
  let dupQuery = supabase
    .from("items")
    .select("id")
    .eq("owner_id", user.id)
    .eq("upc", upc)
    .eq("name", name)
    .neq("id", itemId);
  dupQuery = item.location_id ? dupQuery.eq("location_id", item.location_id) : dupQuery.is("location_id", null);
  const { data: dup } = await dupQuery.maybeSingle();
  if (dup) {
    return apiError("An item with this name already exists in that box — add stock to it instead.", 409, {
      code: "NAME_EXISTS",
    });
  }

  const patch: Record<string, unknown> = { name };
  if (imageUrl && !item.image_url) patch.image_url = imageUrl;
  const { data: updated, error } = await supabase
    .from("items")
    .update(patch)
    .eq("id", itemId)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });

  return NextResponse.json({ item: updated });
}