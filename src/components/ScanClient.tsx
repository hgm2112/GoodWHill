"use client";

import { useEffect, useState } from "react";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { centsToUsd, formatDateTime, pluralize } from "@/lib/utils";
import type { Item, Location, ScanResult } from "@/lib/types";

export function ScanClient() {
  const [upc, setUpc] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [delta, setDelta] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ upc: string; at: string; added?: number }>>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locId, setLocId] = useState("");

  useEffect(() => {
    fetch("/api/locations")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setLocations(data.locations ?? []);
        setLocId(data.default_location_id ?? "");
      })
      .catch(() => {});
  }, []);

  async function setScanLocation(id: string) {
    setLocId(id);
    await fetch("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_location_id: id || null }),
    });
  }

  useEffect(() => {
    const code = upc.replace(/\D/g, "");
    if (!code) return;
    runLookup(code);
  }, [upc]);

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  }

  async function runLookup(code: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/scan?upc=${encodeURIComponent(code.replace(/\D/g, ""))}`);
      if (!res.ok) {
        setError(`Lookup failed (${res.status})`);
        setResult(null);
        return;
      }
      setResult(await res.json());
    } catch {
      setError("Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  async function addStock(code: string, quantity: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upc: code.replace(/\D/g, ""), delta: quantity, location_id: locId || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not add stock");
        return;
      }
      setResult({ catalog: data.catalog, items: [data.item] });
      setHistory((h) => [{ upc: code.replace(/\D/g, ""), at: new Date().toISOString(), added: quantity }, ...h].slice(0, 8));
      flash(`Added ${pluralize(quantity, "unit")} — new stock ${pluralize(data.item.quantity, "unit")}`);
      runLookup(code.replace(/\D/g, ""));
    } catch {
      setError("Could not add stock");
    } finally {
      setBusy(false);
    }
  }

  const onDetected = (code: string) => {
    setUpc(code.replace(/\D/g, "").slice(0, 32));
  };

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <label className="label">Storing scans in</label>
          <select
            className="input"
            value={locId}
            onChange={(e) => setScanLocation(e.target.value)}
          >
            <option value="">Unassigned</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-400">
            New products get stamped with this box and it&apos;s remembered for next time. Existing
            items keep their current box. Manage boxes under Inventory.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <BarcodeScanner onDetected={onDetected} onError={setError} disabled={busy} />
          <div className="mt-3">
            <label className="label">Or type a barcode manually</label>
            <div className="flex gap-2">
              <input
                className="input"
                inputMode="numeric"
                placeholder="e.g. 630509283408"
                value={upc}
                onChange={(e) => setUpc(e.target.value)}
              />
              <button className="btn btn-primary" onClick={() => runLookup(upc)} disabled={busy}>
                Look up
              </button>
            </div>
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">
            Scanned product
          </h2>
          {busy && !result && <p className="text-sm text-slate-400">Looking up…</p>}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          {result && (
            <div className="space-y-3">
              <div className="card">
                <div className="flex items-start gap-3">
                  {result.catalog?.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={result.catalog.image_url}
                      alt=""
                      className="h-20 w-16 shrink-0 rounded-md border border-slate-200 object-cover"
                    />
                  ) : (
                    <div className="flex h-20 w-16 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-100 text-xs text-slate-400">
                      {result.catalog ? "Sealed" : "Unknown"}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold leading-snug">{result.catalog?.name ?? `Product ${upc}`}</p>
                    <p className="text-xs text-slate-500">UPC {result.catalog?.upc ?? upc}</p>
                    {result.catalog?.set_code && (
                      <p className="text-xs text-slate-500">Set {result.catalog.set_code}</p>
                    )}
                    {result.catalog?.ebay_avg_value_cents != null && (
                      <p className="text-xs text-emerald-700">
                        eBay {result.catalog.price_source === "insights" ? "sold avg" : "est."}{" "}
                        {centsToUsd(result.catalog.ebay_avg_value_cents)}
                        {result.catalog.price_sample_count
                          ? ` · ${pluralize(result.catalog.price_sample_count, "sample")}`
                          : ""}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="card">
                <p className="mb-2 text-sm font-semibold">In your inventory</p>
                {!result.items.length ? (
                  <p className="text-sm text-slate-500">
                    Not in inventory yet. Add stock below to create it as a sealed item.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {result.items.map((item: Item) => (
                      <li key={item.id} className="flex items-center justify-between py-1.5">
                        <span className="text-sm">
                          {item.name}
                          {item.set_code ? ` (${item.set_code})` : ""}
                          {item.location_id ? ` · ${locations.find((l) => l.id === item.location_id)?.name ?? "?"}` : ""}
                        </span>
                        <span className={`text-sm ${item.quantity === 0 ? "text-red-600" : "text-slate-700"}`}>
                          {pluralize(item.quantity, "unit")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="card flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="max-w-28">
                  <label className="label">Add quantity</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={delta}
                    onChange={(e) => setDelta(Math.max(1, Number(e.target.value) || 1))}
                  />
                </div>
                <button
                  className="btn btn-primary flex-1"
                  onClick={() => addStock(upc, delta)}
                  disabled={busy || !upc.replace(/\D/g, "")}
                >
                  {result.items.length ? "Add stock to item" : "Add to inventory & stock"}
                </button>
              </div>
            </div>
          )}

          {!result && !busy && !error && (
            <div className="card text-sm text-slate-500">
              Scan a barcode or enter it above. Sealed MTG product (boxes, packs, bundles) has a
              real barcode. Bulk loose cards don&apos;t — add those from the Inventory page.
            </div>
          )}

          {history.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">
                Recent scans
              </h3>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                {history.map((h, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between px-3 py-1.5 text-sm"
                  >
                    <button className="text-indigo-600 hover:underline" onClick={() => setUpc(h.upc)}>
                      {h.upc}
                    </button>
                    <span className="text-xs text-slate-400">
                      +{h.added} at {formatDateTime(h.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed inset-x-4 bottom-16 z-50 rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white shadow-xl sm:bottom-6">
          {toast}
        </div>
      )}
    </div>
  );
}