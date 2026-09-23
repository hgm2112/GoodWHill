import { createAdminClient } from "@/lib/supabase/admin";

export const EBAY_IS_SANDBOX = process.env.EBAY_ENV === "sandbox";

export const EBAY_PATHS = {
  authorize: EBAY_IS_SANDBOX
    ? "https://auth.sandbox.ebay.com/oauth2/authorize"
    : "https://auth.ebay.com/oauth2/authorize",
  token: EBAY_IS_SANDBOX
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token",
  api: EBAY_IS_SANDBOX ? "https://api.sandbox.ebay.com" : "https://api.ebay.com",
};

/**
 * Scopes this app's user token needs. MUST be a subset of the scopes granted
 * to the eBay app (see developer portal → OAuth scopes). The newer Listings
 * API scope (`sell.listings`) is not granted to legacy apps — requesting it
 * makes authorization fail with `invalid_scope`. Sync uses the Inventory API
 * (`sell.inventory.readonly`) and price lookup uses an app token instead.
 */
export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.listing.read",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
].join(" ");

export const MARKETPLACE_ID = "EBAY_US";

export function ebayConfigured(): boolean {
  return Boolean(
    process.env.EBAY_CLIENT_ID &&
      process.env.EBAY_CLIENT_SECRET &&
      process.env.EBAY_RUNAME,
  );
}

/**
 * Best-effort helper that pulls numeric cents out of the many slightly
 * different price shapes eBay returns depending on which API/version is
 * responding. Handles: "12.34", 12.34, { value: "12.34" },
 * { amount: { value: "12.34" } }, { value: { value: "12.34", currency } }.
 */
export function extractPriceCents(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === "number") {
    return Number.isFinite(input) ? Math.round(input * 100) : null;
  }
  if (typeof input === "string") {
    const n = Number.parseFloat(input);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["amount", "value", "salePrice", "priceId"]) {
      const v = obj[key];
      const direct = extractPriceCents(v);
      if (direct != null) return direct;
      if (v && typeof v === "object") {
        const inner = extractPriceCents((v as Record<string, unknown>).value);
        if (inner != null) return inner;
      }
    }
  }
  return null;
}

export interface EbayTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  scope?: string;
}

function basicAuth() {
  const id = process.env.EBAY_CLIENT_ID!;
  const secret = process.env.EBAY_CLIENT_SECRET!;
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

export async function exchangeCodeForTokens(code: string): Promise<EbayTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.EBAY_RUNAME!,
    scope: EBAY_SCOPES,
  });
  return postTokens(body);
}

export async function refreshUserTokens(refreshToken: string): Promise<EbayTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: EBAY_SCOPES,
  });
  return postTokens(body);
}

async function postTokens(body: URLSearchParams): Promise<EbayTokens> {
  const res = await fetch(EBAY_PATHS.token, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`eBay token endpoint failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Token vault (encrypted at rest via AES-256-GCM)
// ---------------------------------------------------------------------------
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

function getEncryptionKey(): Buffer | null {
  const hex = process.env.EBAY_TOKEN_ENCRYPTION_KEY;
  if (!hex) return null;
  const key = Buffer.from(hex, "hex");
  return key.length === 32 ? key : null;
}

const ENC_PREFIX = "enc:";

export function encryptSecret(plain: string): string {
  const key = getEncryptionKey();
  if (!key) {
    // Dev convenience: no key configured → store plaintext (document this).
    console.warn("[ebay] EBAY_TOKEN_ENCRYPTION_KEY not set; storing token unencrypted.");
    return plain;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${Buffer.concat([iv, tag, enc]).toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const key = getEncryptionKey();
  if (!key) throw new Error("EBAY_TOKEN_ENCRYPTION_KEY missing; cannot decrypt tokens");
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export async function storeUserTokens(ownerId: string, tokens: EbayTokens): Promise<void> {
  const admin = createAdminClient();
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await admin.from("ebay_tokens").upsert(
    {
      owner_id: ownerId,
      access_token: tokens.access_token ? encryptSecret(tokens.access_token) : "",
      refresh_token: encryptSecret(tokens.refresh_token),
      expires_at: expiresAt,
      scope: EBAY_SCOPES,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_id" },
  );
}

export async function getStoredTokens(ownerId: string): Promise<EbayTokens | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ebay_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    access_token: data.access_token ? decryptSecret(data.access_token) : "",
    refresh_token: decryptSecret(data.refresh_token),
  };
}

export async function deleteStoredTokens(ownerId: string): Promise<void> {
  const admin = createAdminClient();
  await admin.from("ebay_tokens").delete().eq("owner_id", ownerId);
}

/**
 * Returns a valid user access token, transparently refreshing from the
 * encrypted refresh token when close to expiry / after 401s.
 */
export async function getUserAccessToken(
  ownerId: string,
  forceRefresh = false,
): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ebay_tokens")
    .select("access_token, refresh_token, expires_at, updated_at")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("EBAY_NOT_CONNECTED");

  const now = Date.now();
  const expires = data.expires_at ? new Date(data.expires_at).getTime() : 0;
  const needsRefresh = forceRefresh || expires - now < 120_000;

  if (!needsRefresh && data.access_token) {
    return decryptSecret(data.access_token);
  }

  const refreshToken = decryptSecret(data.refresh_token);
  const fresh = await refreshUserTokens(refreshToken);
  // eBay's refresh-token grant omits the refresh_token; keep the current one.
  await storeUserTokens(ownerId, { ...fresh, refresh_token: fresh.refresh_token ?? refreshToken });
  return fresh.access_token;
}