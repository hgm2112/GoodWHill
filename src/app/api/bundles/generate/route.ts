import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam } from "@/lib/api-helper";
import {
  buildBundleAcrossGames,
  bundlePriceCents,
  contentsTargetForPrice,
  type GameBundleResult,
} from "@/lib/bundle";
import { BUNDLE_KINDS, ITEM_KINDS } from "@/lib/utils";
import type { Item } from "@/lib/types";

const VALID_KINDS = ITEM_KINDS as readonly string[];

/**
 * POST /api/bundles/generate — preview a random bundle (no persistence).
 * Body: { targetCents, kinds?: ["sealed","loose",...], game?: "MTG" }
 * `targetCents` is the bundle's SELLING PRICE; contents are filled to the
 * value whose 10% discount lands on it (a $100 bundle packs ~$111).
 * Every call re-randomizes; the client calls this for "Regenerate".
 * Bundles never mix games: `game` restricts to one game; omitted = pick one
 * game at random from the qualifying stock.
 */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const priceCents = getIntParam(String(body?.targetCents ?? ""));
  if (!priceCents || priceCents < 500) return apiError("targetCents must be >= $5");
  const contentsTarget = contentsTargetForPrice(priceCents);
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
  if (!items?.length) {
    return apiError(
      "No in-stock items with a value set. Add inventory (and value) first.",
      409,
    );
  }

  let result: GameBundleResult | null = null;
  try {
    result = buildBundleAcrossGames(items as Item[], contentsTarget, undefined, game, { dominant });
  } catch {
    return apiError("Bundle generation failed", 500, { code: "GEN" });
  }
  if (!result) {
    return apiError(
      game
        ? `Couldn't build a bundle from ${game} stock near $${(priceCents / 100).toFixed(0)} — try another target or item types.`
        : "Couldn't build a bundle within $15 of the target — try another target or item types.",
      409,
    );
  }

  return NextResponse.json({
    targetCents: contentsTarget,
    priceCents: bundlePriceCents(result.totalCents),
    totalCents: result.totalCents,
    game: result.game,
    lines: result.lines.map((l) => ({
      item: l.item,
      quantity: l.quantity,
      valueCents: l.valueCents,
      lineTotalCents: l.valueCents * l.quantity,
    })),
    suggestedName: result.game || "MTG",
  });
}