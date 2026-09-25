import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam } from "@/lib/api-helper";
import { buildBundleAcrossGames, contentsTargetForPrice, type GameBundleResult } from "@/lib/bundle";
import { BUNDLE_KINDS, ITEM_KINDS } from "@/lib/utils";
import type { Item } from "@/lib/types";

const VALID_KINDS = ITEM_KINDS as readonly string[];

/**
 * GET  /api/bundles — list bundles (with item counts).
 * POST /api/bundles — generate, persist, and ALLOCATE stock for a bundle.
 *   Body: { name, targetCents, kinds, game? }
 *   `targetCents` is the selling price; `target_value_cents` stores the
 *   contents-fill target (price ÷ 0.9, the 10% bundle discount).
 */
export async function GET() {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const { data, error } = await supabase
    .from("bundles")
    .select("*, bundle_items(*)")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return apiError(error.message, 500, { code: "DB" });

  const list = (data ?? []).map((b: { id: string; name: string; target_value_cents: number; total_value_cents: number; status: string; created_at: string; item_count?: number; bundle_items?: Array<{ quantity: number }> }) => ({
    ...b,
    item_count: (b.bundle_items ?? []).reduce((n: number, bi: { quantity: number }) => n + bi.quantity, 0),
    line_count: (b.bundle_items ?? []).length,
  }));
  return NextResponse.json(list);
}

export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const priceCents = getIntParam(String(body?.targetCents ?? ""));
  if (!priceCents || priceCents < 500) return apiError("targetCents must be >= $5");
  const contentsTarget = contentsTargetForPrice(priceCents);

  const nameRaw = String(body?.name ?? "").trim();
  const kindsRaw = Array.isArray(body?.kinds)
    ? (body.kinds as unknown[]).map(String)
    : [...BUNDLE_KINDS];
  const kinds = kindsRaw.filter((k) => VALID_KINDS.includes(k));
  const game = body?.game != null ? String(body.game).trim() : null;

  const { data: items, error } = await supabase
    .from("items")
    .select("*")
    .eq("owner_id", user.id)
    .eq("active", true)
    .in("kind", kinds)
    .gt("quantity", 0)
    .gt("value_cents", 0)
    .order("created_at", { ascending: false });
  if (error) return apiError(error.message, 500, { code: "DB" });
  if (!items?.length) return apiError("No priced in-stock items available", 409);

  let result: GameBundleResult | null = null;
  try {
    result = buildBundleAcrossGames(items as Item[], contentsTarget, undefined, game);
  } catch {
    return apiError("Bundle generation failed", 500, { code: "GEN" });
  }
  if (!result) {
    return apiError(
      game
        ? `Couldn't build a bundle from ${game} stock near $${(priceCents / 100).toFixed(0)}`
        : "Could not build a bundle near the target",
      409,
    );
  }
  const name = nameRaw || result.game || "MTG";

  // ── Persist + allocate ────────────────────────────────────────────────────
  const { data: bundle, error: bundleError } = await supabase
    .from("bundles")
    .insert({
      owner_id: user.id,
      name,
      target_value_cents: contentsTarget,
      total_value_cents: result.totalCents,
      status: "allocated",
    })
    .select()
    .single();
  if (bundleError) return apiError(bundleError.message, 500, { code: "DB" });

  const applied: string[] = []; // item ids we already decremented (for rollback)
  try {
    for (const line of result.lines) {
      await supabase.from("bundle_items").insert({
        bundle_id: bundle.id,
        item_id: line.item.id,
        quantity: line.quantity,
        value_cents: line.valueCents,
        unit_cost_cents: line.item.unit_cost_cents,
      });

      const { data: current } = await supabase
        .from("items")
        .select("quantity")
        .eq("id", line.item.id)
        .eq("owner_id", user.id)
        .single();
      const qty = current?.quantity ?? 0;
      if (qty < line.quantity) throw new Error("INSUFFICIENT_STOCK");

      const { error: updateError } = await supabase
        .from("items")
        .update({ quantity: qty - line.quantity })
        .eq("id", line.item.id)
        .eq("owner_id", user.id);
      if (updateError) throw updateError;
      applied.push(line.item.id);

      await supabase.from("allocations").insert({
        bundle_id: bundle.id,
        item_id: line.item.id,
        quantity: line.quantity,
        status: "allocated",
      });
      await supabase.from("item_movements").insert({
        item_id: line.item.id,
        owner_id: user.id,
        delta: -line.quantity,
        reason: "reserve",
        ref_id: bundle.id,
        note: `Reserved for bundle "${name}"`,
      });
    }
  } catch (err) {
    // Rollback: restore stock we decremented, then remove the bundle.
    for (const itemId of applied) {
      const { data: cur } = await supabase
        .from("items")
        .select("quantity")
        .eq("id", itemId)
        .single();
      const line = result.lines.find((l) => l.item.id === itemId);
      if (cur && line) {
        await supabase
          .from("items")
          .update({ quantity: (cur.quantity ?? 0) + line.quantity })
          .eq("id", itemId);
      }
    }
    await supabase.from("bundles").delete().eq("id", bundle.id);
    return apiError(
      err instanceof Error ? err.message : "Failed to allocate bundle stock",
      409,
    );
  }

  return NextResponse.json({ bundle, totalCents: result.totalCents, createdAt: bundle.created_at });
}