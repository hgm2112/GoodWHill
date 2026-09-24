"use client";

import { useState } from "react";
import { centsToUsd, formatDateTime, truncated } from "@/lib/utils";
import type { Listing } from "@/lib/types";

export function ListingsClient({
  initial,
  ebayConnected,
}: {
  initial: Listing[];
  ebayConnected: boolean;
}) {
  const [listings, setListings] = useState(initial);
  const [syncState, setSyncState] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    setSyncState("working");
    setError(null);
    try {
      const res = await fetch("/api/ebay/sync-listings", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Sync failed");
        setSyncState("error");
        if (data?.code === "EBAY_NOT_CONNECTED") setListings([]);
        return;
      }
      const refreshed = await fetch("/api/listings").then((r) =>
        r.ok ? r.json().catch(() => null) : null,
      );
      if (Array.isArray(refreshed)) setListings(refreshed);
      setSyncState("idle");
    } catch {
      setError("Sync failed");
      setSyncState("error");
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={sync} disabled={syncState === "working"}>
          {syncState === "working" ? "Syncing…" : "Sync now from eBay"}
        </button>
        <span className="text-xs text-slate-400">
          {listings.length} active listing{listings.length === 1 ? "" : "s"}
        </span>
      </div>

      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!ebayConnected && (
        <div className="card text-sm text-slate-500">
          You haven&apos;t connected your eBay account yet. Go to{" "}
          <a href="/settings" className="text-indigo-600 underline">
            Settings
          </a>{" "}
          to link it, then your active listings will appear here (manual sync or the automated daily
          cron).
        </div>
      )}

      {ebayConnected && listings.length === 0 && (
        <div className="card text-sm text-slate-500">
          No active eBay listings found yet. If you know you have some, double-check the sync above.
        </div>
      )}

      {listings.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {listings.map((l) => (
            <li key={l.id}>
              <a
                href={l.item_uri || `https://www.ebay.com/itm/${l.ebay_listing_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="card flex items-start gap-3 p-3 transition hover:border-slate-300 hover:shadow-md"
              >
                {l.image_urls?.[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={l.image_urls[0]}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded-md border border-slate-200 object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800" title={l.title}>
                    {truncated(l.title, 60)}
                  </p>
                  <p className="mt-0.5 text-sm text-emerald-700">
                    {l.price_cents != null ? centsToUsd(l.price_cents) : "—"}
                    <span className="ml-1 text-xs font-normal text-slate-400">{l.currency}</span>
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                    <span className="badge badge-slate">{l.status}</span>
                    {l.quantity_available != null && <span>{l.quantity_available} avail</span>}
                    {l.quantity_sold != null && (
                      <span className="text-emerald-600">{l.quantity_sold} sold</span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-300">
                    synced {l.last_synced_at ? formatDateTime(l.last_synced_at) : "—"}
                  </p>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}