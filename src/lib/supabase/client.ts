"use client";

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

/**
 * Singleton browser client. Used by client components for typical queries.
 * (Fetches to the app's own API routes are preferred for anything involving
 * server-only secrets such as eBay.)
 */
let cached: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabaseBrowser() {
  if (!cached) cached = createClient();
  return cached;
}