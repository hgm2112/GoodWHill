import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SalesClient } from "@/components/SalesClient";
import type { SaleRow } from "@/components/SalesClient";

export const metadata = { title: "Sales · GoodWHill" };

export default async function SalesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [sales, items, bundles] = await Promise.all([
    supabase
      .from("sales")
      .select("*, item:items!sales_item_id_fkey(name, kind), bundle:bundles!sales_bundle_id_fkey(name)")
      .eq("owner_id", user.id)
      .order("sold_at", { ascending: false })
      .limit(500),
    supabase.from("items").select("*").eq("owner_id", user.id).eq("active", true).order("name"),
    supabase
      .from("bundles")
      .select("*")
      .eq("owner_id", user.id)
      .not("status", "in", '("cancelled")'),
  ]);

  return (
    <SalesClient
      initial={(sales.data ?? []) as unknown as SaleRow[]}
      items={items.data ?? []}
      bundles={bundles.data ?? []}
    />
  );
}