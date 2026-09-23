import { NextResponse } from "next/server";
import { authUser, apiError, getCents } from "@/lib/api-helper";
import { parseCsv, normalizeName } from "@/lib/utils";

/**
 * POST /api/inventory/import — bulk import from CSV.
 * Expected header row (order-independent): name, kind, upc, set_code,
 * category, location, quantity, unit_cost (USD), value (USD), notes
 * Existing rows are matched by UPC (when present) or name+kind, and the
 * imported quantity is ADDED to them. New rows are created. The `location`
 * column is optional; the box is matched/created by name.
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

  // Resolve `location` values to location ids (match existing by name,
  // create when new). Done lazily per row.
  const locationCache = new Map<string, string | null>();
  async function resolveLocation(name: string): Promise<string | null> {
    const key = name.trim();
    if (!key) return null;
    if (locationCache.has(key)) return locationCache.get(key) ?? null;
    const { data: existing } = await supabase
      .from("locations")
      .select("id")
      .eq("owner_id", user.id)
      .eq("name", key)
      .maybeSingle();
    if (existing) {
      locationCache.set(key, existing.id);
      return existing.id;
    }
    const { data: newLoc, error } = await supabase
      .from("locations")
      .insert({ owner_id: user.id, name: key })
      .select("id")
      .single();
    if (!error && newLoc) {
      locationCache.set(key, newLoc.id);
      return newLoc.id;
    }
    locationCache.set(key, null);
    return null;
  }

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
    const locationId = await resolveLocation(get(row, "location"));

    const payload: Record<string, unknown> = {
      name,
      kind,
      upc,
      set_code: get(row, "set_code")?.toUpperCase() || null,
      category: get(row, "category") || null,
      unit_cost_cents: unitCost,
      value_cents: value,
      location_id: locationId,
      notes: get(row, "notes") || null,
      active: true,
    };

    let match: { id: string } | null = null;
    if (upc) {
      const { data } = await supabase
        .from("items")
        .select("id, name, kind")
        .eq("owner_id", user.id)
        .eq("upc", upc)
        .limit(50);
      match = (data ?? []).find((r) => normalizeName(r.name) === normalizeName(name)) ?? null;
    }
    if (!match) {
      const { data } = await supabase
        .from("items")
        .select("id, name, kind")
        .eq("owner_id", user.id)
        .eq("kind", kind)
        .limit(50);
      match = (data ?? []).find((r) => normalizeName(r.name) === normalizeName(name)) ?? null;
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