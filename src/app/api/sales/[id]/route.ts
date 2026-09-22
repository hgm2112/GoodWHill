import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

type Params = { params: Promise<{ id: string }> };

/** DELETE /api/sales/:id — remove a sale record and restore stock. */
export async function DELETE(_request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;

  const { data: sale } = await supabase
    .from("sales")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();
  if (!sale) return apiError("Sale not found", 404);

  if (sale.item_id) {
    await supabase
      .from("items")
      .update({
        quantity: (
          (await supabase.from("items").select("quantity").eq("id", sale.item_id).single()).data
            ?.quantity ?? 0
        ) + sale.quantity,
      })
      .eq("id", sale.item_id);
    await supabase.from("item_movements").insert({
      item_id: sale.item_id,
      owner_id: user.id,
      delta: sale.quantity,
      reason: "adjust",
      note: `Sale #${sale.id} deleted`,
    });
  }

  if (sale.bundle_id) {
    await supabase.from("bundles").update({ status: "listed" }).eq("id", sale.bundle_id);
  }

  const { error } = await supabase.from("sales").delete().eq("id", id).eq("owner_id", user.id);
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json({ ok: true });
}