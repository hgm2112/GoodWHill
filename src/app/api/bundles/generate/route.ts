import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam } from "@/lib/api-helper";
import { buildBundleAcrossGames, type GameBundleResult } from "@/lib/bundle";
import { BUNDLE_KINDS, ITEM_KINDS } from "@/lib/utils";
import type { Item } from "@/lib/types";

const VALID_KINDS = ITEM_KINDS as readonly string[];

/**
 * POST /api/bundles/generate — preview a random bundle (no persistence).
 * Body: { targetCents, kinds?: ["sealed","loose",...], game?: "MTG" }
 * Every call re-randomizes; the client calls this for "Regenerate".
 * Bundles never mix games: `game` restricts to one game; omitted = pick one
 * game at random from the qualifying stock.
 */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const targetCents = getIntParam(String(body?.targetCents ?? ""));
  if (!targetCents || targetCents < 500) return apiError("targetCents must be >= $5");
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
  if (!items?.length) {
    return apiError(
      "No in-stock items with a value set. Add inventory (and value) first.",
      409,
    );
  }

  let result: GameBundleResult | null = null;
  try {
    result = buildBundleAcrossGames(items as Item[], targetCents, undefined, game);
  } catch {
    return apiError("Bundle generation failed", 500, { code: "GEN" });
  }
  if (!result) {
    return apiError(
      game
        ? `Couldn't build a bundle from ${game} stock near $${(targetCents / 100).toFixed(0)} — try another target or item types.`
        : "Couldn't build a bundle within $15 of the target — try another target or item types.",
      409,
    );
  }

  const hasSealed = result.lines.some((l) => l.item.kind === "sealed");
  const includesBulk = result.lines.some((l) => l.item.kind !== "sealed");

  return NextResponse.json({
    targetCents,
    totalCents: result.totalCents,
    game: result.game,
    lines: result.lines.map((l) => ({
      item: l.item,
      quantity: l.quantity,
      valueCents: l.valueCents,
      lineTotalCents: l.valueCents * l.quantity,
    })),
    suggestedName: `${result.game || "MTG"} Mystery Bundle ~$${(targetCents / 100).toFixed(0)}${
      hasSealed ? " (sealed + bulk)" : includesBulk ? " (bulk cards)" : ""
    }`,
  });
}