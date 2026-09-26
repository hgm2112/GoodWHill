/**
 * Read-only probe: does GetMyeBaySelling (ActiveList) carry shipping info?
 *
 * Fetches ONE page of the seller's active listings and reports which
 * shipping-related tags appear in each <Item>. Decides the shipping source
 * for the bundle "fill from eBay" flow:
 *   - ShippingServiceCost present  → parse it during sync (store listings.shipping_cents)
 *   - absent                       → fall back to a per-listing GetItem call
 *
 * Nothing is written to the DB. Run:  npx tsx scripts/probe-trading-shipping.ts
 * Env:  .env.local (auto-loaded) — NEXT_PUBLIC_SUPABASE_URL,
 *       SUPABASE_SERVICE_ROLE_KEY, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET,
 *       EBAY_TOKEN_ENCRYPTION_KEY, EBAY_DEV_ID
 */
import { readFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";

const TRADING_API = "https://api.ebay.com/ws/api.dll";

function loadEnvLocal(): void {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.trim().startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // env may already be exported
  }
}

function decryptSecret(stored: string): string {
  const prefix = "enc:";
  if (!stored.startsWith(prefix)) return stored;
  const hex = process.env.EBAY_TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error("EBAY_TOKEN_ENCRYPTION_KEY missing; cannot decrypt tokens");
  const key = Buffer.from(hex, "hex");
  const raw = Buffer.from(stored.slice(prefix.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function grab(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

async function getAccessToken(baseUrl: string, serviceKey: string): Promise<string> {
  const res = await fetch(`${baseUrl}/rest/v1/ebay_tokens?select=access_token,refresh_token,expires_at&limit=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) throw new Error(`token read failed (${res.status}): ${await res.text()}`);
  const rows = (await res.json()) as Array<{ access_token: string; refresh_token: string; expires_at: string | null }>;
  if (!rows.length) throw new Error("no ebay_tokens row — connect eBay first");
  const row = rows[0];

  const expires = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (row.access_token && expires - Date.now() > 120_000) return decryptSecret(row.access_token);

  const refresh = decryptSecret(row.refresh_token);
  const tokenRes = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope:
        "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.listing.read https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
    }),
  });
  if (!tokenRes.ok) throw new Error(`refresh failed (${tokenRes.status}): ${await tokenRes.text()}`);
  const fresh = (await tokenRes.json()) as { access_token: string };
  return fresh.access_token;
}

const SHIP_TAGS = [
  "ShippingServiceCost",
  "ShippingDetails",
  "ShippingType",
  "ShippingServiceOptions",
  "ShippingService",
  "FlatShippingCost",
  "CalculatedShippingRate",
] as const;

async function main(): Promise<void> {
  loadEnvLocal();
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error("missing Supabase env");
  if (!process.env.EBAY_DEV_ID) console.warn("[warn] EBAY_DEV_ID not set — X-EBAY-API-DEV-NAME will be empty");

  const token = await getAccessToken(baseUrl, serviceKey);
  console.log("access token acquired\n");

  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </ActiveList>
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
</GetMyeBaySellingRequest>`;

  const res = await fetch(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-VERSION": "1207",
      "X-EBAY-API-APP-NAME": process.env.EBAY_CLIENT_ID ?? "",
      "X-EBAY-API-DEV-NAME": process.env.EBAY_DEV_ID ?? "",
      "X-EBAY-API-CERT-NAME": process.env.EBAY_CLIENT_SECRET ?? "",
      "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
      "Content-Type": "text/xml",
    },
    body,
  });
  const xml = await res.text();
  const ack = grab(xml, "Ack");
  console.log(`HTTP ${res.status} · Ack=${ack ?? "?"}`);
  if (ack !== "Success") {
    console.log(xml.slice(0, 1200));
    process.exit(1);
  }

  const items = [...xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((m) => m[1]);
  console.log(`items on page: ${items.length}\n`);

  let anyTag = false;
  for (const item of items) {
    const id = grab(item, "ItemID") ?? "?";
    const title = (grab(item, "Title") ?? "").slice(0, 50);
    const hits = SHIP_TAGS.filter((t) => item.includes(`<${t}`));
    if (hits.length) anyTag = true;
    console.log(`${hits.length ? "HAS " : "none"} · ${id} · ${title}${hits.length ? ` · ${hits.join(", ")}` : ""}`);
  }

  if (anyTag) {
    const sample = items.find((i) => i.includes("<ShippingServiceCost"));
    if (sample) {
      const idx = sample.indexOf("ShippingServiceCost");
      console.log(`\nSAMPLE ShippingServiceCost context:\n…${sample.slice(Math.max(0, idx - 250), idx + 200)}…`);
    }
    console.log("\nRESULT: branch A — parse shipping during sync.");
  } else {
    const shipIdx = xml.search(/<Shipping/);
    console.log(`\nany "<Shipping*" anywhere in payload: ${shipIdx >= 0}`);
    if (shipIdx >= 0) console.log(`context: …${xml.slice(shipIdx, shipIdx + 400)}…`);
    console.log("RESULT: branch B — GetItem per linked listing for shipping.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
