import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

type Params = { params: Promise<{ id: string }> };

/** GET /api/inventory/:id/price-history — snapshots, oldest → newest. */
export async function GET(_request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;

  const { data, error } = await supabase
    .from("item_price_history")
    .select("*")
    .eq("item_id", id)
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(500);
  if (error) return apiError(error.message, 500, { code: "DB" });

  return NextResponse.json({ points: data ?? [] });
}
