import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InventoryClient } from "@/components/InventoryClient";

export const metadata = { title: "Inventory · GoodWHill" };

export default async function InventoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase
    .from("items")
    .select("*")
    .eq("owner_id", user.id)
    .eq("active", true)
    .order("updated_at", { ascending: false });

  return <InventoryClient initial={data ?? []} />;
}