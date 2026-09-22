import { EBAY_PATHS, MARKETPLACE_ID, extractPriceCents } from "@/lib/ebay/oauth";

/**
 * eBay price lookup for sealed products.
 *
 * Strategy (requested by the user):
 *   1. Marketplace Insights API  — real sold items (last 90 days). Restricted:
 *      returns 403 until eBay approves your free access application. When it
 *      works it is the true "average sold".
 *   2. Browse API search by GTIN — mean/median of CURRENT active asking
 *      prices for the exact product. Always works with standard keys; the
 *      estimate is labeled as such.
 *
 * Results are cached on the item / upc_catalog by the caller.
 */

let cachedAppToken: { token: string; expiresAt: number } | null = null;

export async function getApplicationToken(): Promise<string> {
  if (cachedAppToken && cachedAppToken.expiresAt > Date.now() + 60_000) {
    return cachedAppToken.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: [
      "https://api.ebay.com/oauth/api_scope",
      "https://api.ebay.com/api_scope/commerce.catalog.readonly",
    ].join(" "),
  });
  const res = await fetch(EBAY_PATHS.token, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`,
      ).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`eBay app token failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedAppToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedAppToken.token;
}

function stats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 !== 0
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { median, mean, count: values.length };
}

function collectListValues(list: unknown, key: string): number[] {
  const out: number[] = [];
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const cents = extractPriceCents((entry as Record<string, unknown>)[key]);
    if (cents != null && cents > 0) out.push(cents);
  }
  return out;
}

/** Real sold data, if approved for the Marketplace Insights API. */
export async function searchInsights(query: string): Promise<{
  averageCents: number | null;
  medianCents: number | null;
  count: number;
  unavailable?: boolean;
}> {
  const token = await getApplicationToken();
  const url = new URL(`${EBAY_PATHS.api}/buy/marketplace_insights/v1_beta/item_sales/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "200");

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
        Accept: "application/json",
      },
    });
  } catch {
    return { averageCents: null, medianCents: null, count: 0, unavailable: true };
  }

  if (res.status === 403 || res.status === 401) {
    // Insights access not approved yet → caller falls back to Browse.
    return { averageCents: null, medianCents: null, count: 0, unavailable: true };
  }
  if (!res.ok) {
    return { averageCents: null, medianCents: null, count: 0, unavailable: true };
  }

  const body = (await res.json()) as { itemSales?: unknown[] };
  const sales = body.itemSales ?? [];
  const cents = collectListValues(sales, "salePrice").concat(
    collectListValues(sales, "price"),
  );
  const s = stats(cents);
  if (!s) return { averageCents: null, medianCents: null, count: 0 };
  return { averageCents: s.mean, medianCents: s.median, count: s.count };
}

/** Current asking prices for the exact product via GTIN (UPC). */
export async function searchActiveByGtin(gtin: string): Promise<{
  averageCents: number | null;
  medianCents: number | null;
  count: number;
}> {
  const token = await getApplicationToken();
  const url = new URL(`${EBAY_PATHS.api}/buy/browse/v1/item_summary/search`);
  url.searchParams.set("gtin", gtin);
  url.searchParams.set("limit", "50");
  url.searchParams.set("filter", "price:[1..5000],buyingOptions:{FIXED_PRICE},deliveryCountry:US");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      Accept: "application/json",
    },
  });
  if (!res.ok) return { averageCents: null, medianCents: null, count: 0 };

  const body = (await res.json()) as { itemSummaries?: unknown[] };
  const cents = collectListValues(body.itemSummaries ?? [], "price");
  const s = stats(cents);
  if (!s) return { averageCents: null, medianCents: null, count: 0 };
  return { averageCents: s.mean, medianCents: s.median, count: s.count };
}

export interface PriceLookup {
  averageCents: number | null;
  medianCents: number | null;
  count: number;
  source: "insights" | "browse_active" | "none";
}

/**
 * Full pipeline for a sealed product: Insights sold-data when available,
 * otherwise Browse active-listing estimates by UPC, otherwise nothing.
 */
export async function lookupSealedPrice(opts: {
  gtin?: string | null;
  query?: string | null;
}): Promise<PriceLookup> {
  const searchQuery = opts.query?.trim() || opts.gtin || "";
  const gtin = opts.gtin?.trim() || null;

  if (searchQuery) {
    const insights = await searchInsights(searchQuery);
    if (insights.averageCents != null) {
      return {
        averageCents: insights.averageCents,
        medianCents: insights.medianCents,
        count: insights.count,
        source: "insights",
      };
    }
  }

  if (gtin) {
    const browse = await searchActiveByGtin(gtin);
    if (browse.averageCents != null) {
      return {
        averageCents: browse.averageCents,
        medianCents: browse.medianCents,
        count: browse.count,
        source: "browse_active",
      };
    }
  }

  return { averageCents: null, medianCents: null, count: 0, source: "none" };
}

/** Resolve a GTIN/UPC to a product name + image (best effort). */
export async function resolveProductByGtin(gtin: string): Promise<{
  name: string | null;
  imageUrl: string | null;
} | null> {
  try {
    const token = await getApplicationToken();
    const url = new URL(
      `${EBAY_PATHS.api}/commerce/catalog/v1_beta/product_summary/search`,
    );
    url.searchParams.set("gtin", gtin);
    url.searchParams.set("limit", "1");
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
        Accept: "application/json",
      },
    });
    if (res.ok) {
      const body = (await res.json()) as { productSummaries?: unknown[] };
      const first = body.productSummaries?.[0];
      if (first && typeof first === "object") {
        const rec = first as Record<string, unknown>;
        const title =
          (rec.title as string) ??
          (rec.leafCategory != null ? (rec.leafCategory as Record<string, unknown>).name as string : null);
        const image =
          typeof rec.image === "string"
            ? rec.image
            : (rec.image as Record<string, unknown>)?.imageUrl ?? null;
        if (title) return { name: title, imageUrl: (image as string) ?? null };
      }
    }
  } catch {
    // fall through to Browse
  }

  // Fallback: use the first active listing title as the product name.
  if (gtin) {
    const token = await getApplicationToken().catch(() => "");
    if (token) {
      const url = new URL(`${EBAY_PATHS.api}/buy/browse/v1/item_summary/search`);
      url.searchParams.set("gtin", gtin);
      url.searchParams.set("limit", "1");
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
          Accept: "application/json",
        },
      });
      if (res.ok) {
        const body = (await res.json()) as { itemSummaries?: unknown[] };
        const first = body.itemSummaries?.[0] as Record<string, unknown> | undefined;
        const title = first?.title as string | undefined;
        const primary = (first?.image as Record<string, unknown> | undefined)?.imageUrl as
          | string
          | undefined;
        const thumb = (
          (first?.thumbnailImages as Array<Record<string, unknown>> | undefined)?.[0] as
            | Record<string, unknown>
            | undefined
        )?.imageUrl as string | undefined;
        const image = primary ?? thumb ?? null;
        if (title) return { name: title, imageUrl: image };
      }
    }
  }

  return null;
}