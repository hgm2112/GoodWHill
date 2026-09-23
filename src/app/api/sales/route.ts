import { NextResponse } from "next/server";
import { authUser, apiError, getIntParam } from "@/lib/api-helper";
import { toCsv, formatDateTime } from "@/lib/utils";

/** GET /api/sales — list sales (optionally ?export=csv). */
export async function GET(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { searchParams } = new URL(request.url);

  const { data, error } = await supabase
    .from("sales")
    .select("*, item:items!sales_item_id_fkey(name, kind), bundle:bundles!sales_bundle_id_fkey(name)")
    .eq("owner_id", user.id)
    .order("sold_at", { ascending: false })
    .limit(searchParams.get("limit") ? Number(searchParams.get("limit")) : 500);

  if (error) return apiError(error.message, 500, { code: "DB" });

  if (searchParams.get("export") === "csv") {
    const rows = [
      [
        "Date",
        "Item / Bundle",
        "Gross (USD)",
        "Fee (USD)",
        "Shipping (USD)",
        "Net (USD)",
        "Qty",
        "Buyer",
        "eBay order",
        "eBay item",
        "Note",
      ],
      ...(data ?? []).map((s: {
  sold_at: string;
  item?: { name?: string } | null;
  bundle?: { name?: string } | null;
  gross_cents: number;
  fee_cents: number;
  shipping_cents: number;
  net_cents: number;
  quantity: number;
  buyer?: string | null;
  ebay_order_id?: string | null;
  ebay_item_id?: string | null;
  note?: string | null;
}) => [
        formatDateTime(s.sold_at),
        s.item?.name ?? s.bundle?.name ?? "—",
        (s.gross_cents / 100).toFixed(2),
        (s.fee_cents / 100).toFixed(2),
        (s.shipping_cents / 100).toFixed(2),
        (s.net_cents / 100).toFixed(2),
        String(s.quantity),
        s.buyer ?? "",
        s.ebay_order_id ?? "",
        s.ebay_item_id ?? "",
        s.note ?? "",
      ]),
    ];
    return new NextResponse(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="goodwhilly-sales.csv"',
      },
    });
  }

  return NextResponse.json(data ?? []);
}

/** POST /api/sales — record a sale (item or bundle). */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiError("Invalid body");

  const itemId = body.itemId ? String(body.itemId) : null;
  const bundleId = body.bundleId ? String(body.bundleId) : null;
  if (!itemId && !bundleId) return apiError("Link the sale to an item or a bundle");

  const gross = getIntParam(String(body.grossCents ?? ""));
  if (!gross || gross <= 0) return apiError("grossCents must be > 0");
  const fee = getIntParam(String(body.feeCents ?? "0")) ?? 0;
  const shipping = getIntParam(String(body.shippingCents ?? "0")) ?? 0;
  const net = gross - fee;

  const soldAt = body.soldAt ? String(body.soldAt) : new Date().toISOString();
  const quantity = Math.max(1, getIntParam(String(body.quantity ?? "1")) ?? 1);

  const ebayOrderId = body.ebayOrderId ? String(body.ebayOrderId) : null;
  const ebayItemId = body.ebayItemId ? String(body.ebayItemId) : null;

  // Checks + inventory side-effects.
  if (itemId) {
    const { data: item } = await supabase
      .from("items")
      .select("quantity, name")
      .eq("id", itemId)
      .eq("owner_id", user.id)
      .single();
    if (!item) return apiError("Item not found", 404);
    if ((item.quantity ?? 0) < quantity) {
      return apiError("Not enough stock to record this sale", 409, {
        available: item.quantity,
      });
    }
    await supabase.from("items").update({ quantity: (item.quantity ?? 0) - quantity }).eq("id", itemId);
    await supabase.from("item_movements").insert({
      item_id: itemId,
      owner_id: user.id,
      delta: -quantity,
      reason: "sale",
      note: body.note ? String(body.note).slice(0, 300) : null,
    });
  }

  if (bundleId) {
    const { data: bundle } = await supabase
      .from("bundles")
      .select("status")
      .eq("id", bundleId)
      .eq("owner_id", user.id)
      .single();
    if (!bundle) return apiError("Bundle not found", 404);
    await supabase.from("bundles").update({ status: "sold" }).eq("id", bundleId);
    await supabase
      .from("allocations")
      .update({ status: "sold" })
      .eq("bundle_id", bundleId)
      .eq("status", "allocated");
  }

  const { data: created, error } = await supabase
    .from("sales")
    .insert({
      owner_id: user.id,
      item_id: itemId,
      bundle_id: bundleId,
      ebay_order_id: ebayOrderId,
      ebay_item_id: ebayItemId,
      gross_cents: gross,
      fee_cents: fee,
      shipping_cents: shipping,
      net_cents: net,
      quantity: itemId ? quantity : 1,
      buyer: body.buyer ? String(body.buyer).slice(0, 120) : null,
      note: body.note ? String(body.note).slice(0, 500) : null,
      sold_at: soldAt,
    })
    .select()
    .single();

  if (error) {
    if (String(error.message).toLowerCase().includes("duplicate")) {
      return apiError("A sale with this eBay order ID is already recorded", 409);
    }
    return apiError(error.message, 500, { code: "DB" });
  }
  return NextResponse.json(created);
}