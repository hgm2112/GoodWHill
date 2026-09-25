import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Auth {
  supabase: SupabaseClient;
  user: User;
}

interface User {
  id: string;
  email?: string | null;
}

/** Server-client + verified user for API route handlers. */
export async function authUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { supabase, user: { id: user.id, email: user.email } } satisfies Auth;
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function apiError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function getIntParam(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

export function getCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.-]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

/** Validated calendar date as `YYYY-MM-DD` (e.g. an acquired date), else null. */
export function getDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const n = [Number(y), Number(mo) - 1, Number(d)];
  const date = new Date(Date.UTC(n[0], n[1], n[2]));
  if (date.getUTCFullYear() !== n[0] || date.getUTCMonth() !== n[1] || date.getUTCDate() !== n[2]) {
    return null;
  }
  return `${y}-${mo}-${d}`;
}

/** Today's date as `YYYY-MM-DD` (UTC). */
export function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}