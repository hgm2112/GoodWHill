import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client (bypasses RLS). SERVER ONLY — never import this from a
 * client component or expose the key. Used for:
 *   - applying schema-ish exact updates (e.g. bundle allocations transaction)
 *   - reading/writing the ebay_tokens vault (no app-role access exists)
 *   - scripts and cron
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL");
  }
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}