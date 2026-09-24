"use client";

import { useState } from "react";
import { CardSearchInput, type CardResult } from "@/components/CardSearchInput";
import { NumberDollars } from "@/components/ui/Modal";
import { KIND_OPTIONS, kindLabel } from "@/lib/utils";
import type { Item, ItemKind, Location } from "@/lib/types";

interface Props {
  initial?: Item | null;
  defaultKind?: ItemKind;
  locations?: Location[];
  onSaved: (item: Item) => void;
  onClose: () => void;
}

export function ItemForm({ initial, defaultKind = "sealed", locations = [], onSaved, onClose }: Props) {
  const isEdit = Boolean(initial);
  const [kind, setKind] = useState<ItemKind>(initial?.kind ?? defaultKind);
  const [name, setName] = useState(initial?.name ?? "");
  const [upc, setUpc] = useState(initial?.upc ?? "");
  const [setCode, setSetCode] = useState(initial?.set_code ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [quantity, setQuantity] = useState<number>(initial?.quantity ?? 1);
  const [unitCost, setUnitCost] = useState<number | null>(initial?.unit_cost_cents ?? null);
  const [value, setValue] = useState<number | null>(initial?.value_cents ?? null);
  const [imageUrl, setImageUrl] = useState(initial?.image_url ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [locationId, setLocationId] = useState<string>(initial?.location_id ?? "");
  const [pickingCard, setPickingCard] = useState(!isEdit && defaultKind === "loose");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priceInfo, setPriceInfo] = useState<string | null>(null);

  function applyCard(card: CardResult) {
    setName(card.name);
    setSetCode(card.set);
    setValue(card.value_cents);
    setImageUrl(card.image_url ?? "");
    setPriceInfo(
      `Card price from Scryfall: ${card.value_cents ? `$${(card.value_cents / 100).toFixed(2)}` : "no listed price (set manually)"}`,
    );
    setPickingCard(false);
  }

  async function fetchInfoAndPrice() {
    setBusy(true);
    setError(null);
    setPriceInfo(null);
    try {
      if (kind === "sealed") {
        if (!upc.replace(/\D/g, "") && !name.trim()) {
          setError("Enter a UPC or the item name first so eBay can match the product.");
          return;
        }
        // Prefill name/image from the shared catalog (no eBay call needed).
        if (upc.replace(/\D/g, "")) {
          const catRes = await fetch(`/api/catalog?upc=${encodeURIComponent(upc.trim())}`);
          if (catRes.ok) {
            const cat = await catRes.json();
            if (cat) {
              if (!name) setName(cat.name);
              if (!setCode) setSetCode(cat.set_code ?? "");
              if (!imageUrl && cat.image_url) setImageUrl(cat.image_url);
            }
          }
        }
        const res = await fetch("/api/ebay/price", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ upc: upc.trim() || null, name: name || null, kind: "sealed" }),
        });
        if (res.status === 409 && (await res.json())?.code === "EBAY_NOT_CONFIGURED") {
          setError(
            "eBay isn't configured on this deployment yet, so I can't autofill a price. Add EBAY_CLIENT_ID/SECRET/RUNAME or set the value manually.",
          );
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body?.error ?? "Price lookup failed.");
          return;
        }
        const data = await res.json();
        const est = data.estimateCents ?? data.medianCents;
        if (est != null) setValue(est);
        if (data.product) {
          if (!name) setName(data.product.name);
          if (!imageUrl && data.product.image_url) setImageUrl(data.product.image_url);
        }
        setPriceInfo(
          est == null
            ? "No prices found on eBay yet — set the value manually. (Tip: apply for Marketplace Insights for sold averages.)"
            : data.source === "insights"
              ? `eBay sold average: $${(est / 100).toFixed(2)} · ${data.sampleCount} samples, $${(data.medianCents / 100).toFixed(2)} median`
              : data.source === "browse_active"
                ? `eBay active listings (estimate): $${(est / 100).toFixed(2)} median · ${data.sampleCount} samples`
                : "No prices found on eBay yet — set the value manually.",
        );
      } else if (kind === "loose") {
        if (!name.trim()) {
          setError("Enter the card name first.");
          return;
        }
        const res = await fetch("/api/ebay/price", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), kind: "loose" }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body?.error ?? "Price lookup failed.");
          return;
        }
        const data = await res.json();
        if (data.estimateCents != null) setValue(data.estimateCents);
        setPriceInfo(
          data.estimateCents != null
            ? `Card market price: $${(data.estimateCents / 100).toFixed(2)}`
            : "No market price found — set the value manually.",
        );
      } else {
        setError("Manual items don't have an autofill source.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      kind,
      upc: kind === "sealed" ? upc.trim().replace(/\D/g, "") : upc.trim(),
      set_code: setCode.trim() || null,
      category: category.trim() || null,
      quantity,
      unit_cost_cents: unitCost,
      value_cents: value,
      image_url: imageUrl.trim() || null,
      notes: notes.trim() || null,
      location_id: locationId || null,
    };
    try {
      const res = isEdit
        ? await fetch(`/api/inventory/${initial!.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch("/api/inventory", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Save failed");
        return;
      }
      onSaved(data);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div>
        <label className="label">Item type</label>
        <div className="grid grid-cols-3 gap-2">
          {KIND_OPTIONS.map((k) => (
            <button
              key={k.value}
              type="button"
              onClick={() => {
                setKind(k.value as ItemKind);
                setPickingCard(k.value === "loose");
              }}
              className={`rounded-lg border px-2 py-2 text-xs font-semibold ${
                kind === k.value
                  ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                  : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {kind === "loose" && pickingCard && (
        <div>
          <label className="label">Search Magic card</label>
          <CardSearchInput onSelect={applyCard} />
          <button
            type="button"
            className="mt-1 text-xs text-slate-500 underline"
            onClick={() => setPickingCard(false)}
          >
            Enter name manually instead
          </button>
        </div>
      )}

      {kind === "sealed" && (
        <div>
          <label className="label">UPC / barcode</label>
          <div className="flex items-center gap-2">
            <input
              className="input"
              inputMode="numeric"
              value={upc}
              onChange={(e) => setUpc(e.target.value)}
              placeholder="e.g. 630509283408"
            />
            <button
              type="button"
              className="btn btn-secondary whitespace-nowrap"
              onClick={fetchInfoAndPrice}
              disabled={busy}
            >
              {busy ? "Looking up…" : "Info & price"}
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Optional — a product name alone is enough: use the Info &amp; price
            button and it fetches name, image, and an eBay-based value estimate (sold
            average when Marketplace Insights is approved, otherwise active-listing prices).
          </p>
        </div>
      )}

      <div>
        <label className="label">Name</label>
        <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Set code</label>
          <input
            className="input uppercase"
            placeholder="e.g. BLB"
            value={setCode}
            onChange={(e) => setSetCode(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Category</label>
          <input
            className="input"
            placeholder={kind === "sealed" ? "MTG Sealed" : "Other"}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Quantity</label>
          <input
            className="input"
            type="number"
            min={0}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(0, Number(e.target.value)))}
          />
        </div>
        <div>
          <label className="label">Cost / unit</label>
          <NumberDollars valueCents={unitCost} onChange={setUnitCost} className="h-full" />
        </div>
        <div>
          <label className="label">Value / unit</label>
          <NumberDollars valueCents={value} onChange={setValue} className="h-full" />
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Value is what the item is worth (market resale) — used for{" "}
        {kind === "sealed" ? "eBay autofill and " : ""}bundle building. Cost is what you paid.
      </p>

      <div>
        <label className="label">Storage</label>
        <select
          className="input"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">Unassigned</option>
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {loc.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400">
          Pick the box/shelf where this is stored. Manage these under Inventory.
        </p>
      </div>

      {kind === "loose" && (
        <button
          type="button"
          className="btn btn-secondary w-full"
          onClick={fetchInfoAndPrice}
          disabled={busy}
        >
          {busy ? "Looking up…" : `Fetch ${kindLabel(kind)} price`}
        </button>
      )}
      {priceInfo && <p className="text-sm text-emerald-700">{priceInfo}</p>}

      <div>
        <label className="label">Image URL (optional)</label>
        <input className="input" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea
          className="input min-h-16 resize-y"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {isEdit ? "Save changes" : `Add ${kindLabel(kind).toLowerCase()}`}
        </button>
      </div>
    </form>
  );
}