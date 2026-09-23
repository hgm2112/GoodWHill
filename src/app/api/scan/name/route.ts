import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

/**
 * POST /api/scan/name — give a scanned UPC a real product name.
 *   Body: { upc, name?, set_code? }
 *   - If `name` is provided, it is trusted (user typed it) and saved.
 *   - Otherwise the product name is resolved from eBay by GTIN
 *     (resolveProductByGtin) when eBay keys are configured.
 *   Name writes to the shared upc_catalog AND renames every item the current
 *   user has for that UPC. Returns { catalog, updated }.
 */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const upc = String(body?.upc ?? "").replace(/\D/g, "").slice(0, 32);
  if (!upc) return apiError("upc required");

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
      "Couldn't find this product on eBay yet — add your eBay keys in Settings, or type a name below.",
      404,
      { code: "NOT_FOUND", upc },
    );
  }

  const setCode = body?.set_code ? String(body.set_code).toUpperCase().slice(0, 12) : null;

  const { data: catalog, error: catalogError } = await supabase
    .from("upc_catalog")
    .upsert(
      {
        upc,
        name,
        set_code: setCode,
        image_url: imageUrl,
      },
      { onConflict: "upc" },
    )
    .select()
    .single();
  if (catalogError) return apiError(catalogError.message, 500, { code: "DB" });

  const { data: items, error: itemsError } = await supabase
    .from("items")
    .update({ name })
    .eq("owner_id", user.id)
    .eq("upc", upc)
    .select();
  if (itemsError) return apiError(itemsError.message, 500, { code: "DB" });

  if (imageUrl) {
    const { error: imgError } = await supabase
      .from("items")
      .update({ image_url: imageUrl })
      .eq("owner_id", user.id)
      .eq("upc", upc)
      .is("image_url", null);
    if (imgError) return apiError(imgError.message, 500, { code: "DB" });
  }

  return NextResponse.json({ catalog, updated: items?.length ?? 0 });
}