import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authUser, apiError, getIntParam, getCents } from "@/lib/api-helper";
import {
  buildBundleAcrossGames,
  contentsTargetForPrice,
  gameOf,
  type GameBundleResult,
} from "@/lib/bundle";
import { BUNDLE_KINDS, ITEM_KINDS } from "@/lib/utils";
import type { Item } from "@/lib/types";

const VALID_KINDS = ITEM_KINDS as readonly string[];

/** Max copies of one product inside a single bundle (mirrors `bundle.ts`). */
const DUP_MAX_UNITS = 5;
/** Duplicates only below this value (strictly under $20). */
const DUP_ELIGIBLE_VALUE_CENTS = 2000;

/**
 * Validates caller-supplied preview lines (`{ itemId, quantity }[]`) and turns
 * them into a result built from CURRENT DB rows — money never comes from the
 * client. Returns a caller-facing `{ error, status, code }` instead of a
 * result when the preview no longer matches inventory (deleted, paused, sold
 * out, over stock, or breaching the duplicate rules).
 */
async function resultFromLines(
  supabase: SupabaseClient,
  ownerId: string,
  rawLines: unknown[],
): Promise<{ result: GameBundleResult } | { error: string; status: number; code?: string }> {
  const invalid = { error: "Invalid bundle lines", status: 400 };
  if (!rawLines.length) return invalid;
  const merged = new Map<string, number>();
  for (const entry of rawLines) {
    if (typeof entry !== "object" || entry === null) return invalid;
    const { itemId, quantity } = entry as { itemId?: unknown; quantity?: unknown };
    if (typeof itemId !== "string" || !itemId.trim()) return invalid;
    const qty = typeof quantity === "number" ? quantity : NaN;
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return invalid;
    const id = itemId.trim();
    merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  for (const qty of merged.values()) {
    if (qty > 99) return invalid;
  }

  const { data: rows, error } = await supabase
    .from("items")
    .select("*")
    .eq("owner_id", ownerId)
    .in("id", [...merged.keys()]);
  if (error) return { error: error.message, status: 500, code: "DB" };
  const byId = new Map<string, Item>((rows ?? []).map((r: Item) => [r.id, r]));

  const stale = {
    error: "Inventory changed since this preview — regenerate the bundle.",
    status: 409,
    code: "STALE_PREVIEW",
  };
  const lines: GameBundleResult["lines"] = [];
  let totalCents = 0;
  for (const [itemId, qty] of merged) {
    const item = byId.get(itemId);
    const value = item?.value_cents ?? 0;
    if (!item || !item.active || item.quantity <= 0 || value <= 0) return stale;
    const cap =
      value >= DUP_ELIGIBLE_VALUE_CENTS ? Math.min(item.quantity, 1) : Math.min(item.quantity, DUP_MAX_UNITS);
    if (qty > cap) return stale;
    lines.push({ item, quantity: qty, valueCents: value });
    totalCents += value * qty;
  }
  return { result: { lines, totalCents, targetCents: totalCents, game: gameOf(lines[0].item.category) } };
}

/**
 * GET  /api/bundles — list bundles (with item counts).
 * POST /api/bundles — persist + ALLOCATE stock for a bundle.
 *   Body: { name, targetCents, kinds?, game?, dominant?, lines?, targetValueCents? }
 *   `lines` = the previewed lines (`{ itemId, quantity }[]`) from
 *   /api/bundles/generate — when present the bundle is persisted EXACTLY as
 *   previewed (values re-read from the DB; no re-roll), so what you see is
 *   what you get. Omitting `lines` falls back to generating a fresh bundle.
 *   `targetCents` is the selling price; `target_value_cents` stores the
 *   contents-fill target (`targetValueCents` from the preview, else
 *   price ÷ 0.9, the 10% bundle discount).
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
  const nameRaw = String(body?.name ?? "").trim();
  const rawLines = Array.isArray(body?.lines) ? (body.lines as unknown[]) : null;

  let result: GameBundleResult;
  let targetValueCents: number;

  if (rawLines) {
    // Persist the previewed bundle exactly as shown — no re-roll.
    const built = await resultFromLines(supabase, user.id, rawLines);
    if ("error" in built) {
      return apiError(built.error, built.status, built.code ? { code: built.code } : undefined);
    }
    result = built.result;
    targetValueCents = getCents(body?.targetValueCents) ?? result.totalCents;
  } else {
    // Legacy path: no previewed lines given, so generate a fresh bundle.
    const priceCents = getIntParam(String(body?.targetCents ?? ""));
    if (!priceCents || priceCents < 500) return apiError("targetCents must be >= $5");
    targetValueCents = contentsTargetForPrice(priceCents);

    const kindsRaw = Array.isArray(body?.kinds)
      ? (body.kinds as unknown[]).map(String)
      : [...BUNDLE_KINDS];
    const kinds = kindsRaw.filter((k) => VALID_KINDS.includes(k));
    const game = body?.game != null ? String(body.game).trim() : null;
    const dominant = body?.dominant !== false; // default on

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

    let generated: GameBundleResult | null = null;
    try {
      generated = buildBundleAcrossGames(items as Item[], targetValueCents, undefined, game, { dominant });
    } catch {
      return apiError("Bundle generation failed", 500, { code: "GEN" });
    }
    if (!generated) {
      return apiError(
        game
          ? `Couldn't build a bundle from ${game} stock near $${(priceCents / 100).toFixed(0)}`
          : "Could not build a bundle near the target",
        409,
      );
    }
    result = generated;
  }
  const name = nameRaw || result.game || "MTG";

  // ── Persist + allocate ────────────────────────────────────────────────────
  const { data: bundle, error: bundleError } = await supabase
    .from("bundles")
    .insert({
      owner_id: user.id,
      name,
      target_value_cents: targetValueCents,
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