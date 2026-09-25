export type ItemKind = "sealed" | "loose" | "open" | "used" | "other";
export type BundleStatus = "draft" | "allocated" | "listed" | "sold" | "cancelled";
export type PriceSource = "insights" | "browse_active" | "scryfall" | "manual" | null;

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  ebay_username: string | null;
  default_location_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: string;
  owner_id: string;
  name: string;
  kind: ItemKind;
  upc: string | null;
  set_code: string | null;
  category: string | null;
  quantity: number;
  unit_cost_cents: number | null;
  value_cents: number | null;
  ebay_avg_value_cents: number | null;
  price_source: PriceSource;
  price_sample_count: number | null;
  price_checked_at: string | null;
  image_url: string | null;
  notes: string | null;
  location_id: string | null;
  acquired_at: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Location {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ItemMovement {
  id: number;
  item_id: string;
  owner_id: string;
  delta: number;
  reason: string;
  ref_id: string | null;
  note: string | null;
  created_at: string;
}

export interface CatalogEntry {
  upc: string;
  name: string;
  set_code: string | null;
  ebay_category_id: string | null;
  image_url: string | null;
  ebay_avg_value_cents: number | null;
  ebay_median_value_cents: number | null;
  price_source: PriceSource;
  price_sample_count: number | null;
  price_checked_at: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Bundle {
  id: string;
  owner_id: string;
  name: string;
  target_value_cents: number;
  total_value_cents: number;
  status: BundleStatus;
  ebay_listing_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BundleItem {
  id: string;
  bundle_id: string;
  item_id: string;
  quantity: number;
  value_cents: number;
  unit_cost_cents: number | null;
}

export interface Allocation {
  id: string;
  bundle_id: string;
  item_id: string;
  quantity: number;
  status: "allocated" | "sold" | "released";
  created_at: string;
  released_at: string | null;
  release_note: string | null;
}

export interface Sale {
  id: string;
  owner_id: string;
  item_id: string | null;
  bundle_id: string | null;
  ebay_order_id: string | null;
  ebay_item_id: string | null;
  gross_cents: number;
  fee_cents: number;
  shipping_cents: number;
  net_cents: number;
  quantity: number;
  buyer: string | null;
  note: string | null;
  sold_at: string;
  created_at: string;
}

export interface Listing {
  id: string;
  owner_id: string;
  ebay_listing_id: string;
  title: string;
  price_cents: number | null;
  currency: string;
  status: string;
  quantity_available: number | null;
  quantity_sold: number | null;
  item_uri: string | null;
  image_urls: string[];
  item_id: string | null;
  bundle_id: string | null;
  ended_at: string | null;
  last_synced_at: string;
  created_at: string;
}

export interface ListingDraft {
  id: string;
  owner_id: string;
  bundle_id: string | null;
  title: string;
  description: string;
  image_urls: string[];
  ebay_listing_id: string | null;
  status: "draft" | "published";
  created_at: string;
  updated_at: string;
}

export interface BundleWithItems extends Bundle {
  items: Array<BundleItem & { item: Item }>;
}

export interface InventorySummary {
  totalValueCents: number;
  totalUnits: number;
  byKind: Record<ItemKind, { valueCents: number; units: number }>;
}

/** Mobile-friendly value snapshot for a scanned UPC / item lookup. */
export interface ScanResult {
  catalog: CatalogEntry | null;
  items: Item[];
}

export interface PriceLookupResult {
  estimateCents: number | null;
  medianCents: number | null;
  sampleCount: number;
  source: Exclude<PriceSource, null>;
  checkedAt: string;
  error?: string;
}

/** Current/default card price fields returned by Scryfall. */
export interface ScryfallPrices {
  usd: string | null;
  usd_foil: string | null;
  usd_etched: string | null;
  eur: string | null;
  eur_foil: string | null;
  tix: string | null;
}

export interface ScryfallCard {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  prices: ScryfallPrices;
  image_uris?: { small?: string; normal?: string; large?: string };
  oracle_id: string;
  legalities?: Record<string, string>;
}