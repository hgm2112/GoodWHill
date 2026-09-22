import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-helper";
import { autocomplete } from "@/lib/scryfall";

/** GET /api/scryfall/autocomplete?q=head — type-ahead names. */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json([]);
  try {
    return NextResponse.json(await autocomplete(q));
  } catch {
    return apiError("Scryfall unavailable", 502);
  }
}