import { NextResponse } from "next/server";
import { authUser, apiError, getCents } from "@/lib/api-helper";
import { parseCsv } from "@/lib/utils";

/**
 * POST /api/inventory/import — bulk import from CSV.
 * Expected header row (order-independent): name, kind, upc, set_code,
 * category, quantity, unit_cost (USD), value (USD)
 * Existing rows are matched by UPC (when present) or name+kind, and the
 * imported quantity is ADDED to them. New rows are created.
 */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const csv = String(body?.csv ?? "").trim();
  if (!csv) return apiError("csv is required");

  const rows = parseCsv(csv);
  if (rows.length < 2) return apiError("CSV needs a header row plus data");
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

  const idx = (name: string) => {
    const i = header.indexOf(name);
    return i === -1 ? null : i;
  };
  const get = (row: string[], name: string) => {
    const i = idx(name);
    return i == null ? "" : (row[i] ?? "").trim();
  };

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const name = get(row, "name");
    if (!name) {
      skipped++;
      continue;
    }
    const kindRaw = get(row, "kind").toLowerCase();
    const kind = ["sealed", "bulk_cards", "other"].includes(kindRaw) ? kindRaw : "other";
    const upc = get(row, "upc").replace(/\D/g, "").slice(0, 32) || null;
    const quantityRaw = Number.parseInt(get(row, "quantity") || "0", 10);
    const quantity = Number.isFinite(quantityRaw) ? Math.max(0, quantityRaw) : 0;
    const unitCost = getCents(get(row, "unit_cost"));
    const value = getCents(get(row, "value"));

    const payload: Record<string, unknown> = {
      name,
      kind,
      upc,
      set_code: get(row, "set_code")?.toUpperCase() || null,
      category: get(row, "category") || null,
      unit_cost_cents: unitCost,
      value_cents: value,
      notes: get(row, "notes") || null,
    };

    let match: { id: string } | null = null;
    if (upc) {
      const { data } = await supabase
        .from("items")
        .select("id")
        .eq("owner_id", user.id)
        .eq("upc", upc)
        .maybeSingle();
      match = data;
    }
    if (!match) {
      const { data } = await supabase
        .from("items")
        .select("id")
        .eq("owner_id", user.id)
        .eq("name", name)
        .eq("kind", kind)
        .maybeSingle();
      match = data;
    }

    if (match) {
      const { data: existing } = await supabase
        .from("items")
        .select("quantity")
        .eq("id", match.id)
        .single();
      const added = quantity;
      await supabase
        .from("items")
        .update({ quantity: (existing?.quantity ?? 0) + added })
        .eq("id", match.id);
      if (added > 0) {
        await supabase.from("item_movements").insert({
          item_id: match.id,
          owner_id: user.id,
          delta: added,
          reason: "import",
          note: "CSV bulk import",
        });
      }
      updated++;
    } else {
      const { data: createdItem, error } = await supabase
        .from("items")
        .insert({ ...payload, owner_id: user.id, quantity })
        .select()
        .single();
      if (error) {
        skipped++;
        continue;
      }
      if (quantity > 0) {
        await supabase.from("item_movements").insert({
          item_id: createdItem.id,
          owner_id: user.id,
          delta: quantity,
          reason: "import",
          note: "CSV bulk import",
        });
      }
      created++;
    }
  }

  return NextResponse.json({ created, updated, skipped, totalRows: rows.length - 1 });
}