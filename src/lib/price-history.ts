import type { SupabaseClient } from "@supabase/supabase-js";
import type { PriceHistoryPoint } from "@/lib/types";

/**
 * Records a price snapshot for an item — but only when the value actually
 * moved: skipped when it equals the item's latest snapshot, when it is null,
 * or on any read/write failure (history must never break a price write). The
 * first snapshot for an item always lands (the baseline). Returns the
 * recorded point, or null when nothing was written.
 */
export async function recordPriceHistory(
  supabase: SupabaseClient,
  args: { ownerId: string; itemId: string; valueCents: number | null; priceSource?: string | null },
): Promise<PriceHistoryPoint | null> {
  const { ownerId, itemId, valueCents } = args;
  if (valueCents == null) return null;

  try {
    const { data: latest } = await supabase
      .from("item_price_history")
      .select("value_cents")
      .eq("item_id", itemId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest && latest.value_cents === valueCents) return null;

    const { data: inserted, error } = await supabase
      .from("item_price_history")
      .insert({
        owner_id: ownerId,
        item_id: itemId,
        value_cents: valueCents,
        price_source: args.priceSource || "manual",
      })
      .select("*")
      .single();

    if (error) {
      console.warn("[price-history]", error.message);
      return null;
    }
    return inserted as PriceHistoryPoint;
  } catch (err) {
    console.warn("[price-history]", err instanceof Error ? err.message : "failed");
    return null;
  }
}
