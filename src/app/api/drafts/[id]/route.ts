import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/drafts/:id — update fields / status (draft → published). */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const update: Record<string, unknown> = {};
  if (typeof body?.title === "string" && body.title.trim()) update.title = body.title.trim();
  if (typeof body?.description === "string") update.description = body.description;
  if (typeof body?.status === "string" && ["draft", "published"].includes(body.status)) {
    update.status = body.status;
  }
  if (typeof body?.ebayListingId === "string") update.ebay_listing_id = body.ebayListingId;

  const { data, error } = await supabase
    .from("listing_drafts")
    .update(update)
    .eq("id", id)
    .eq("owner_id", user.id)
    .select()
    .single();
  if (error || !data) return apiError(error ? error.message : "Draft not found", error ? 500 : 404);
  return NextResponse.json(data);
}

/** DELETE /api/drafts/:id */
export async function DELETE(_request: Request, { params }: Params) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase, user } = auth;
  const { id } = await params;
  const { error } = await supabase
    .from("listing_drafts")
    .delete()
    .eq("id", id)
    .eq("owner_id", user.id);
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json({ ok: true });
}