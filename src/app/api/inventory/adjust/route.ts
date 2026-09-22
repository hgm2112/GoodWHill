import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam } from "@/lib/api-helper";

/**
 * POST /api/inventory/adjust — change an item's quantity and log a movement.
 * Body: { itemId, delta, reason, note }
 */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiError("Invalid body");

  const itemId = String(body.itemId ?? "");
  const delta = getIntParam(String(body.delta ?? ""));
  const reason = String(body.reason ?? "adjust").slice(0, 40);
  const note = body.note ? String(body.note).slice(0, 300) : null;
  if (!itemId || delta == null || delta === 0) {
    return apiError("itemId and a non-zero delta are required");
  }
  const allowedReasons = new Set([
    "add",
    "remove",
    "sale",
    "reserve",
    "release",
    "adjust",
    "import",
    "return",
  ]);
  if (!allowedReasons.has(reason)) return apiError("Invalid reason");

  const { data: current, error: lookupError } = await supabase
    .from("items")
    .select("*")
    .eq("id", itemId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (lookupError || !current) return apiError("Item not found", 404);

  const newQuantity = current.quantity + delta;
  if (newQuantity < 0) {
    return apiError("Cannot remove more stock than available", 409, {
      available: current.quantity,
    });
  }

  const { data: updated, error } = await supabase
    .from("items")
    .update({ quantity: newQuantity })
    .eq("id", itemId)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });

  await supabase.from("item_movements").insert({
    item_id: itemId,
    owner_id: user.id,
    delta,
    reason,
    note,
  });

  return NextResponse.json(updated);
}