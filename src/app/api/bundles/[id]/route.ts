import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import type { SupabaseClient } from "@supabase/supabase-js";

type Params = { params: Promise<{ id: string }> };

const ALLOWED_STATUS = new Set(["draft", "allocated", "listed", "sold", "cancelled"]);

async function releaseAllocations(
  supabase: SupabaseClient,
  ownerId: string,
  bundleId: string,
  note: string,
) {
  const { data: allocations } = await supabase
    .from("allocations")
    .select("*")
    .eq("bundle_id", bundleId)
    .eq("status", "allocated");

  for (const allocation of allocations ?? []) {
    const { data: item } = await supabase
      .from("items")
      .select("quantity")
      .eq("id", allocation.item_id)
      .eq("owner_id", ownerId)
      .single();
    if (item) {
      await supabase
        .from("items")
        .update({ quantity: (item.quantity ?? 0) + allocation.quantity })
        .eq("id", allocation.item_id);
      await supabase.from("item_movements").insert({
        item_id: allocation.item_id,
        owner_id: ownerId,
        delta: allocation.quantity,
        reason: "release",
        ref_id: bundleId,
        note,
      });
    }
    await supabase
      .from("allocations")
      .update({ status: "released", released_at: new Date().toISOString(), release_note: note })
      .eq("id", allocation.id);
  }
  return (allocations ?? []).length;
}

/** GET /api/bundles/:id — full bundle with items + allocations. */
export async function GET(request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;

  const { data: bundle, error } = await supabase
    .from("bundles")
    .select("*, bundle_items(*, item:items(*)), allocations(*)")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });
  if (!bundle) return apiError("Bundle not found", 404);
  return NextResponse.json(bundle);
}

/** PATCH /api/bundles/:id — set status (and/or Actual Listing Price +
 * Shipping Fee via `listingPriceCents`/`shippingCents`). Cancelling releases stock. */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const status = String(body?.status ?? "");
  if (!ALLOWED_STATUS.has(status)) return apiError("Invalid status");

  const { data: bundle, error } = await supabase
    .from("bundles")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();
  if (error || !bundle) return apiError("Bundle not found", 404);

  const update: Record<string, unknown> = { status };
  if (body && "ebayListingId" in body) {
    // string links, null/"" unlinks.
    const raw = body.ebayListingId;
    update.ebay_listing_id = raw == null || raw === "" ? null : String(raw);
  }

  // Actual Listing Price / Shipping Fee (captured when marking listed, editable after).
  const centsFields: Array<[key: string, column: string]> = [
    ["listingPriceCents", "listing_price_cents"],
    ["shippingCents", "shipping_cents"],
  ];
  for (const [wire, column] of centsFields) {
    const raw = body?.[wire];
    if (raw === undefined) continue; // field not sent
    if (raw == null) {
      update[column] = null;
      continue;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return apiError(`${wire} must be null or a non-negative integer (cents)`);
    }
    update[column] = raw;
  }

  let releasedCount: number | null = null;
  if (status === "cancelled" && bundle.status !== "cancelled" && bundle.status !== "sold") {
    releasedCount = await releaseAllocations(supabase, user.id, id, "Bundle cancelled");
  } else if (status === "sold") {
    await supabase
      .from("allocations")
      .update({ status: "sold" })
      .eq("bundle_id", id)
      .eq("status", "allocated");
  }

  const { data: updated, error: updateError } = await supabase
    .from("bundles")
    .update(update)
    .eq("id", id)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (updateError) return apiError(updateError.message, 500, { code: "DB" });
  return NextResponse.json({ ...updated, _released: releasedCount });
}

/** DELETE /api/bundles/:id — release stock and remove the bundle (unless sold). */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;

  const { data: bundle } = await supabase
    .from("bundles")
    .select("status")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();
  if (!bundle) return apiError("Bundle not found", 404);
  if (bundle.status === "sold") {
    return apiError("A sold bundle cannot be deleted. Add a sale adjustment instead.", 409);
  }

  await releaseAllocations(supabase, user.id, id, "Bundle deleted");
  const { error } = await supabase.from("bundles").delete().eq("id", id).eq("owner_id", user.id);
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json({ ok: true });
}