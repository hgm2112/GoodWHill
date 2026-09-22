import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";

/** GET /api/catalog?upc= — shared product catalog lookup. */
export async function GET(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase } = auth;

  const { searchParams } = new URL(request.url);
  const upc = searchParams.get("upc")?.replace(/\D/g, "").slice(0, 32);
  if (!upc) return apiError("upc required");
  const { data } = await supabase
    .from("upc_catalog")
    .select("*")
    .eq("upc", upc)
    .maybeSingle();
  return NextResponse.json(data ?? null);
}

/** POST /api/catalog — upsert a product entry. Body: { upc, name?, set_code?, image_url? } */
export async function POST(request: Request) {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  const { supabase } = auth;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const upc = String(body?.upc ?? "").replace(/\D/g, "").slice(0, 32);
  if (!upc) return apiError("upc required");
  const name = String(body?.name ?? "").trim();
  if (!name) return apiError("name required");

  const { data, error } = await supabase
    .from("upc_catalog")
    .upsert(
      {
        upc,
        name,
        set_code: body?.set_code ? String(body.set_code).toUpperCase().slice(0, 12) : null,
        image_url: body?.image_url ? String(body.image_url).trim() || null : null,
      },
      { onConflict: "upc" },
    )
    .select()
    .single();
  if (error) return apiError(error.message, 500, { code: "DB" });
  return NextResponse.json(data ?? null);
}