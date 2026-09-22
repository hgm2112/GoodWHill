import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam } from "@/lib/api-helper";
import { generateBundle } from "@/lib/bundle";
import type { Item } from "@/lib/types";

/**
 * POST /api/bundles/generate — preview a random bundle (no persistence).
 * Body: { targetCents, kinds?: ["sealed","bulk_cards","other"] }
 * Every call re-randomizes; the client calls this for "Regenerate".
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
    : ["sealed", "bulk_cards"];
  const kinds = kindsRaw.filter((k) => ["sealed", "bulk_cards", "other"].includes(k));

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

  const result = generateBundle(items as Item[], targetCents, 0.05);
  const hasSealed = result.lines.some((l) => l.item.kind === "sealed");
  const includesBulk = result.lines.some((l) => l.item.kind !== "sealed");

  return NextResponse.json({
    targetCents,
    totalCents: result.totalCents,
    lines: result.lines.map((l) => ({
      item: l.item,
      quantity: l.quantity,
      valueCents: l.valueCents,
      lineTotalCents: l.valueCents * l.quantity,
    })),
    suggestedName: `MTG Mystery Bundle ~$${(targetCents / 100).toFixed(0)}${
      hasSealed ? " (sealed + bulk)" : includesBulk ? " (bulk cards)" : ""
    }`,
  });
}