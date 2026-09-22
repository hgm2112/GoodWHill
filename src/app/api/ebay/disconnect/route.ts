import { NextResponse } from "next/server";
import { authUser, apiError } from "@/lib/api-helper";
import { deleteStoredTokens } from "@/lib/ebay/oauth";

/** POST /api/ebay/disconnect — revoke the stored eBay connection. */
export async function POST() {
  const auth = await authUser();
  if (!auth) return apiError("Unauthorized", 401);
  await deleteStoredTokens(auth.user.id);
  return NextResponse.json({ ok: true });
}