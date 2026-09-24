import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import { generateListingText } from "@/lib/bundle";
import type { Item } from "@/lib/types";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/bundles/:id/draft — generate + save an editable eBay listing
 * draft (title + description) for the bundle.
 * GET  /api/bundles/:id/draft — return the saved draft if one exists.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const { data: bundle, error } = await supabase
    .from("bundles")
    .select("*, bundle_items(*, item:items(*))")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });
  if (!bundle) return apiError("Bundle not found", 404);

  const lines = ((bundle.bundle_items ?? []) as Array<{
  item: Item;
  quantity: number;
  value_cents: number;
}>).map((bi) => ({
  item: bi.item,
  quantity: bi.quantity,
  valueCents: bi.value_cents,
}));

  // Edits are honored if supplied; otherwise generate fresh text from lines.
  const generated =
    body && typeof body?.title === "string" && typeof body?.description === "string"
      ? null
      : (() => {
          const existing = { name: bundle.name };
          const targetCents = bundle.target_value_cents;
          const totalCents = bundle.total_value_cents;
          return generateListingText({ name: existing.name, targetCents, totalCents, lines });
        })();

  const title = generated?.title ?? String(body?.title ?? "").trim();
  const description = generated?.description ?? String(body?.description ?? "");
  if (!title || !description) return apiError("Draft needs a non-empty title and description", 400);

  const images = lines
    .map((l) => l.item?.image_url)
    .filter((u: string | null | undefined): u is string => Boolean(u))
    .slice(0, 12);

  const { data: existing } = await supabase
    .from("listing_drafts")
    .select("id")
    .eq("bundle_id", id)
    .eq("owner_id", user.id)
    .maybeSingle();

  let draft;
  if (existing) {
    const { data: updated, error } = await supabase
      .from("listing_drafts")
      .update({ title, description, image_urls: images })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) return apiError(error.message, 500, { code: "DB" });
    draft = updated;
  } else {
    const { data: created, error } = await supabase
      .from("listing_drafts")
      .insert({
        owner_id: user.id,
        bundle_id: id,
        title,
        description,
        image_urls: images,
      })
      .select()
      .single();
    if (error) return apiError(error.message, 500, { code: "DB" });
    draft = created;
  }

  return NextResponse.json(draft);
}

export async function GET(request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;

  const { data } = await supabase
    .from("listing_drafts")
    .select("*")
    .eq("bundle_id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  return NextResponse.json(data ?? null);
}