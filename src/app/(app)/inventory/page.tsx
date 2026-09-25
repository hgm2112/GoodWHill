import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InventoryClient } from "@/components/InventoryClient";
import type { PriceHistoryPoint } from "@/lib/types";

export const metadata = { title: "Inventory · goodwhilly" };

export default async function InventoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [items, historyRows] = await Promise.all([
    supabase
      .from("items")
      .select("*")
      .eq("owner_id", user.id)
      .eq("active", true)
      .order("updated_at", { ascending: false }),
    supabase
      .from("item_price_history")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(5000),
  ]);

  // Grouped oldest → newest per item for the card sparklines.
  const history: Record<string, PriceHistoryPoint[]> = {};
  for (const point of historyRows.data ?? []) {
    (history[point.item_id] ??= []).push(point);
  }

  return <InventoryClient initial={items.data ?? []} initialHistory={history} />;
}
