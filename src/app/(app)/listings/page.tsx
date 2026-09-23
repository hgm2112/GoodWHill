import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ListingsClient } from "@/components/ListingsClient";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "eBay Listings · goodwhilly" };

export default async function ListingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [listings, tokens] = await Promise.all([
    supabase
      .from("listings")
      .select("*")
      .eq("owner_id", user.id)
      .order("last_synced_at", { ascending: false })
      .limit(500),
    createAdminClient()
      .from("ebay_tokens")
      .select("owner_id")
      .eq("owner_id", user.id)
      .maybeSingle(),
  ]);

  return (
    <ListingsClient
      initial={listings.data ?? []}
      ebayConnected={Boolean(tokens.data)}
    />
  );
}