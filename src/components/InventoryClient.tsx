"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { ArtworkThumb } from "@/components/ArtworkThumb";
import { ItemForm } from "@/components/ItemForm";
import { PriceHistoryModal, Sparkline } from "@/components/PriceHistoryModal";
import {
  centsToUsd,
  downloadTextFile,
  ITEM_KINDS,
  kindLabel,
  pluralize,
  truncated,
  toCsv,
} from "@/lib/utils";
import type { Item, ItemKind, Location, PriceHistoryPoint } from "@/lib/types";

const KINDS: Array<ItemKind | "all"> = ["all", ...ITEM_KINDS];

type LocFilter = "all" | "unassigned" | string;

const KEY_DOTS: Array<{ color: string; label: string; title: string }> = [
  { color: "bg-emerald-500", label: "Browse active", title: "Green = currently active (shown in store/browse)" },
  { color: "bg-blue-500", label: "Has UPC", title: "Blue = has a barcode; hover the dot to see the code" },
  { color: "bg-purple-500", label: "Sealed", title: "Purple = sealed product" },
  { color: "bg-orange-500", label: "Loose", title: "Orange = loose cards/singles" },
  { color: "bg-amber-400", label: "Open", title: "Amber = opened product" },
  { color: "bg-slate-400", label: "Used", title: "Gray = used product" },
  { color: "bg-slate-700", label: "Other", title: "Dark = other stock" },
];

const KIND_DOT: Record<ItemKind, string> = {
  sealed: "bg-purple-500",
  loose: "bg-orange-500",
  open: "bg-amber-400",
  used: "bg-slate-400",
  other: "bg-slate-700",
};

const KIND_PLACEHOLDER: Record<ItemKind, string> = {
  sealed: "bg-indigo-100 text-indigo-600",
  loose: "bg-amber-100 text-amber-700",
  open: "bg-emerald-100 text-emerald-700",
  used: "bg-slate-200 text-slate-500",
  other: "bg-slate-100 text-slate-500",
};

export function InventoryClient({
  initial,
  initialHistory,
}: {
  initial: Item[];
  initialHistory: Record<string, PriceHistoryPoint[]>;
}) {
  const [items, setItems] = useState<Item[]>(initial);
  const [history, setHistory] = useState<Record<string, PriceHistoryPoint[]>>(initialHistory);
  const [historyItem, setHistoryItem] = useState<Item | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<ItemKind | "all">("all");
  const [locFilter, setLocFilter] = useState<LocFilter>("all");
  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [manageLocations, setManageLocations] = useState(false);

  const [editing, setEditing] = useState<Item | null | "new">(null);
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const [adjustDelta, setAdjustDelta] = useState(1);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/locations")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setLocations(data.locations ?? []);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    const params = new URLSearchParams();
    if (kind !== "all") params.set("kind", kind);
    if (showInactive) params.set("includeInactive", "true");
    if (locFilter === "unassigned") {
      params.set("unassigned", "true");
    } else if (locFilter !== "all") {
      params.set("location_id", locFilter);
    }
    if (q.trim()) params.set("q", q.trim());
    try {
      const res = await fetch(`/api/inventory?${params.toString()}`);
      if (res.ok) setItems(await res.json());
    } finally {
      setBusy(false);
    }
  }, [kind, q, locFilter, showInactive]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return items.filter(
      (i) =>
        !query ||
        i.name.toLowerCase().includes(query) ||
        (i.upc ?? "").includes(query) ||
        (i.set_code ?? "").toLowerCase().includes(query),
    );
  }, [items, q]);

  const summary = useMemo(() => {
    let value = 0;
    let units = 0;
    for (const it of filtered) {
      value += (it.value_cents ?? 0) * it.quantity;
      units += it.quantity;
    }
    return { value, units };
  }, [filtered]);

  const unpricedCount = useMemo(
    () =>
      items.filter(
        (i) =>
          (i.value_cents == null || !i.image_url) &&
          (i.kind === "sealed" || i.kind === "open" || i.kind === "loose"),
      ).length,
    [items],
  );

  function flash(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 2500);
  }

  /** Re-fetch one item's price snapshots (after a save/refresh that may add one). */
  async function fetchHistory(itemId: string) {
    try {
      const res = await fetch(`/api/inventory/${itemId}/price-history`);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (Array.isArray(data?.points)) {
        setHistory((prev) => ({ ...prev, [itemId]: data.points }));
      }
    } catch {
      /* sparkline just stays as-is */
    }
  }

  async function confirmAdjust(e: React.FormEvent) {
    e.preventDefault();
    if (!adjusting) return;
    const res = await fetch("/api/inventory/adjust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itemId: adjusting.id,
        delta: adjustDelta,
        reason: adjustDelta > 0 ? "add" : "remove",
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      flash(data?.error ?? "Adjustment failed");
      return;
    }
    setAdjusting(null);
    setAdjustDelta(1);
    load();
  }

  async function toggleActive(item: Item) {
    await fetch(`/api/inventory/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !item.active }),
    });
    load();
  }

  async function remove(item: Item) {
    if (item.quantity > 0) {
      const ok = window.confirm(
        `Delete "${item.name}"? Its ${pluralize(item.quantity, "unit")} of stock will be removed too.`,
      );
      if (!ok) return;
      const adj = await fetch("/api/inventory/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          delta: -item.quantity,
          reason: "remove",
          note: "Removed with item",
        }),
      });
      const adjData = await adj.json();
      if (!adj.ok) {
        flash(adjData?.error ?? "Could not remove stock");
        return;
      }
      const res = await fetch(`/api/inventory/${item.id}`, { method: "DELETE" });
      const data = await res.json();
      flash(data?.error ?? "Deleted");
      load();
      return;
    }
    if (!window.confirm(`Delete "${item.name}"?`)) return;
    const res = await fetch(`/api/inventory/${item.id}`, { method: "DELETE" });
    const data = await res.json();
    flash(data?.error ?? "Deleted");
    load();
  }

  async function refreshPrice(item: Item) {
    setBusy(true);
    try {
      const res = await fetch("/api/inventory/refresh-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        flash(data?.error ?? "Refresh failed");
      } else {
        flash(`Value updated: ${centsToUsd(data?.value_cents ?? null)}`);
        void fetchHistory(item.id);
      }
      load();
    } catch {
      flash("Refresh failed — check your connection");
    } finally {
      setBusy(false);
    }
  }

  async function refreshUnpriced() {
    setBusy(true);
    try {
      const res = await fetch("/api/inventory/refresh-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "unpriced" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        flash(data?.error ?? "Refresh failed");
      } else if (data?.refreshed == null) {
        flash("Refresh failed — unexpected response");
      } else if (data.failed > 0) {
        flash(`Priced ${data.refreshed} new item${data.refreshed === 1 ? "" : "s"} · ${data.failed} failed`);
      } else {
        flash(data.refreshed > 0 ? `Priced ${data.refreshed} new item${data.refreshed === 1 ? "" : "s"}` : "Nothing to price yet");
      }
      if (Array.isArray(data?.historyPoints) && data.historyPoints.length > 0) {
        setHistory((prev) => {
          const next = { ...prev };
          for (const p of data.historyPoints as PriceHistoryPoint[]) {
            next[p.item_id] = [...(next[p.item_id] ?? []), p];
          }
          return next;
        });
      }
      load();
    } catch {
      flash("Refresh failed — check your connection");
    } finally {
      setBusy(false);
    }
  }

  async function onImport(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const text = await file.text();
    const res = await fetch("/api/inventory/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: text }),
    });
    if (!res.ok) {
      flash("Import failed");
      return;
    }
    const json = await res.json();
    flash(`Imported: ${json.created} created, ${json.updated} updated, ${json.skipped} skipped`);
    load();
  }

  async function assignLocation(item: Item, locationId: string) {
    const res = await fetch(`/api/inventory/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location_id: locationId || null }),
    });
    if (res.ok) {
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, location_id: locationId || null } : it)),
      );
    } else {
      flash("Could not update location");
    }
  }

  async function addLocation() {
    const name = window.prompt("New storage location name", "");
    if (name == null) return;
    const res = await fetch("/api/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      flash(data?.error ?? "Could not add location");
      return;
    }
    setLocations((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    setLocFilter(data.id);
    flash(`Added "${data.name}"`);
  }

  async function renameLocation(loc: Location) {
    const name = window.prompt("Rename storage location", loc.name);
    if (name == null) return;
    const res = await fetch(`/api/locations/${loc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      flash(data?.error ?? "Could not rename location");
      return;
    }
    setLocations((prev) =>
      prev.map((l) => (l.id === loc.id ? { ...l, name: data.name } : l)),
    );
    flash(`Renamed to "${data.name}"`);
  }

  async function deleteLocation(loc: Location) {
    if (!window.confirm(`Delete "${loc.name}"? Items there become Unassigned.`)) return;
    const res = await fetch(`/api/locations/${loc.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      flash(data?.error ?? "Could not delete location");
      return;
    }
    setLocations((prev) => prev.filter((l) => l.id !== loc.id));
    if (locFilter === loc.id) setLocFilter("all");
    load();
    flash(`Deleted "${loc.name}"`);
  }

  const locName = (id: string | null) => locations.find((l) => l.id === id)?.name;

  return (
    <div>
      {/* Page header */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Inventory</h1>
        <button
          className="btn btn-secondary whitespace-nowrap"
          onClick={refreshUnpriced}
          disabled={busy || unpricedCount === 0}
          title="Fetch eBay prices/pictures for items without a value or image yet"
        >
          Browse active{unpricedCount > 0 ? ` (${unpricedCount})` : ""}
        </button>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs flex-1"
          placeholder="Search name / barcode / set…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-0.5">
          {KINDS.map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${
                kind === k ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {k === "all" ? "All" : kindLabel(k)}
            </button>
          ))}
        </div>
        <select
          className="input max-w-48"
          value={locFilter}
          onChange={(e) => setLocFilter(e.target.value as LocFilter)}
        >
          <option value="all">All locations</option>
          <option value="unassigned">Unassigned</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost" onClick={() => setManageLocations((v) => !v)}>
          Locations
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show paused
        </label>
        <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
          Import CSV
        </button>
        <button className="btn btn-primary" onClick={() => setEditing("new")}>
          + Add item
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          multiple={false}
          onChange={(e) => onImport(e.target.files)}
        />
        <button
          className="btn btn-ghost"
          onClick={() =>
            downloadTextFile(
              "goodwhilly-inventory.csv",
              toCsv([
                ["name", "kind", "upc", "set_code", "category", "location", "quantity", "unit_cost", "value"],
                ...filtered.map((i) => [
                  i.name,
                  i.kind,
                  i.upc ?? "",
                  i.set_code ?? "",
                  i.category ?? "",
                  locName(i.location_id) ?? "",
                  String(i.quantity),
                  i.unit_cost_cents ? (i.unit_cost_cents / 100).toFixed(2) : "",
                  i.value_cents ? (i.value_cents / 100).toFixed(2) : "",
                ]),
              ]),
              "text/csv",
            )
          }
        >
          Export
        </button>
      </div>

      {/* Color key + summary */}
      <div className="card mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600">
          {KEY_DOTS.map((d) => (
            <span key={d.label} className="flex items-center gap-1.5" title={d.title}>
              <span className={`h-2.5 w-2.5 rounded-full ${d.color}`} />
              {d.label}
            </span>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          {filtered.length} item{filtered.length === 1 ? "" : "s"} · {summary.units} units ·
          inventory value {centsToUsd(summary.value)} (filtered by current view)
        </p>
      </div>

      {manageLocations && (
        <div className="card mb-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
              Storage locations
            </h2>
            <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => setManageLocations(false)}>
              Close
            </button>
          </div>
          <ul className="divide-y divide-slate-100">
            {locations.length === 0 && (
              <li className="py-2 text-sm text-slate-500">No locations yet — add your first box.</li>
            )}
            {locations.map((loc) => (
              <li key={loc.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="text-sm font-medium">{loc.name}</span>
                <span className="flex gap-1">
                  <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => renameLocation(loc)}>
                    Rename
                  </button>
                  <button
                    className="btn btn-ghost px-2 py-1 text-xs text-red-600"
                    onClick={() => deleteLocation(loc)}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <button className="btn btn-secondary mt-2 w-full" onClick={addLocation}>
            + Add location
          </button>
        </div>
      )}

      {busy && !editing && !adjusting && (
        <p className="mb-2 text-xs text-slate-400">Refreshing…</p>
      )}

      {filtered.length === 0 ? (
        <div className="card text-center">
          <p className="text-sm text-slate-500">
            No {kind === "all" ? "" : kindLabel(kind)} items found.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {filtered.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              locations={locations}
              onAssignLocation={(id) => assignLocation(item, id)}
              onEdit={() => setEditing(item)}
              onAdjust={() => {
                setAdjusting(item);
                setAdjustDelta(1);
              }}
              onToggleActive={() => toggleActive(item)}
              onDelete={() => remove(item)}
              onRefreshPrice={() => refreshPrice(item)}
              history={history[item.id] ?? []}
              onShowHistory={() => setHistoryItem(item)}
            />
          ))}
        </div>
      )}

      <p className="mt-4 text-center text-xs text-slate-400">
        Hover the blue dots to see UPC codes · Green = currently active · Colored dots = product type
      </p>

      {toast && (
        <div className="fixed inset-x-4 bottom-16 z-50 rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white shadow-xl sm:bottom-6">
          {toast}
        </div>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Add item" : "Edit item"}>
        {editing !== null && (
          <ItemForm
            initial={editing === "new" ? null : editing}
            locations={locations}
            onSaved={(saved) => {
              setEditing(null);
              load();
              void fetchHistory(saved.id);
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </Modal>

      <PriceHistoryModal
        item={historyItem ? (items.find((i) => i.id === historyItem.id) ?? historyItem) : null}
        onClose={() => setHistoryItem(null)}
      />

      <Modal open={adjusting !== null} onClose={() => setAdjusting(null)} title="Adjust stock">
        {adjusting && (
          <form onSubmit={confirmAdjust} className="space-y-4">
            <p className="text-sm text-slate-600">
              <span className="font-semibold">{adjusting.name}</span> — currently {pluralize(adjusting.quantity, "unit")}.
            </p>
            <div>
              <label className="label">Change (positive = add stock, negative = remove)</label>
              <input
                className="input"
                type="number"
                step={1}
                value={adjustDelta}
                onChange={(e) => setAdjustDelta(Number(e.target.value) || 0)}
              />
            </div>
            <small className="text-xs text-slate-400">
              Fully removing stock tips the item into &quot;deletable&quot; territory so you can clean it up.
            </small>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setAdjusting(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Apply
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

function ItemCard({
  item,
  locations,
  history,
  onAssignLocation,
  onEdit,
  onAdjust,
  onToggleActive,
  onDelete,
  onRefreshPrice,
  onShowHistory,
}: {
  item: Item;
  locations: Location[];
  history: PriceHistoryPoint[];
  onAssignLocation: (locationId: string) => void;
  onEdit: () => void;
  onAdjust: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onRefreshPrice: () => void;
  onShowHistory: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { main, sub } = useMemo(() => {
    const idx = item.name.lastIndexOf(":");
    if (idx > 0) {
      const m = item.name.slice(0, idx).trim();
      const s = item.name.slice(idx + 1).trim();
      if (s) return { main: m, sub: s };
    }
    return { main: item.name, sub: item.notes ?? "" };
  }, [item.name, item.notes]);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Artwork */}
      <div className="relative aspect-square w-full bg-slate-100">
        {item.image_url ? (
          <ArtworkThumb src={item.image_url} alt={item.name} className="h-full w-full" />
        ) : (
          <div
            className={`flex h-full w-full items-center justify-center px-2 text-center text-sm font-semibold ${KIND_PLACEHOLDER[item.kind]}`}
          >
            {truncated(item.name, 34)}
          </div>
        )}

        <span
          className={`absolute right-1.5 top-1.5 z-10 rounded-full px-2 py-0.5 text-xs font-bold ${
            item.quantity === 0 ? "bg-red-600 text-white" : "bg-slate-900/80 text-white"
          }`}
          title={`${item.quantity} in stock`}
        >
          ×{item.quantity}
        </span>

        {!item.active && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-slate-900/70">
            <span className="text-lg font-black uppercase tracking-widest text-red-400">Paused</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-center gap-0.5 border-b border-slate-100">
        <IconBtn title="Edit" onClick={onEdit}>
          <IconPath d="M12 20h9" />
          <IconPath d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </IconBtn>
        <IconBtn title="Adjust stock" onClick={onAdjust}>
          <IconPath d="M12 5v14" />
          <IconPath d="M5 12h14" />
        </IconBtn>
        <IconBtn title={item.active ? "Pause" : "Resume"} onClick={onToggleActive}>
          {item.active ? (
            <>
              <IconPath d="M9 6v12" />
              <IconPath d="M15 6v12" />
            </>
          ) : (
            <IconPath d="M6 5l12 7-12 7Z" />
          )}
        </IconBtn>
        <IconBtn title="Refresh price" spin={busy} onClick={async () => {
          setBusy(true);
          try {
            await onRefreshPrice();
          } finally {
            setBusy(false);
          }
        }}>
          <IconPath d="M23 4v6h-6" />
          <IconPath d="M1 20v-6h6" />
          <IconPath d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
          <IconPath d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </IconBtn>
        <IconBtn title="Price history" onClick={onShowHistory}>
          <IconPath d="M3 3v18h18" />
          <IconPath d="m19 9-5 5-4-4-3 3" />
        </IconBtn>
        <IconBtn title="Delete" onClick={onDelete}>
          <IconPath d="M3 6h18" />
          <IconPath d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <IconPath d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </IconBtn>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col px-3 pb-3 pt-1.5">
        <div className={`truncate text-sm font-semibold ${item.active ? "" : "text-slate-400"}`} title={item.name}>
          {truncated(main, 44)}
        </div>
        {sub && (
          <div className="truncate text-xs text-slate-400" title={sub}>
            {sub}
          </div>
        )}

        <div className="mt-auto pt-1">
          <div className="text-lg font-bold text-emerald-600">{centsToUsd(item.value_cents)}</div>
          <Sparkline points={history} />
          {item.unit_cost_cents != null && (
            <div className="text-xs text-slate-400">cost {centsToUsd(item.unit_cost_cents)}</div>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-1">
          <select
            className="max-w-28 truncate rounded border-none bg-transparent p-0 text-xs font-medium text-slate-500 focus:outline-none focus:text-slate-900"
            value={item.location_id ?? ""}
            onChange={(e) => onAssignLocation(e.target.value)}
            title="Storage location"
          >
            <option value="">Unassigned</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <span className="flex items-center gap-1.5">
            {item.active && (
              <span className="h-2 w-2 rounded-full bg-emerald-500" title="Browse active" />
            )}
            {item.upc && (
              <span className="h-2 w-2 rounded-full bg-blue-500" title={`UPC: ${item.upc}`} />
            )}
            <span className={`h-2 w-2 rounded-full ${KIND_DOT[item.kind]}`} title={kindLabel(item.kind)} />
          </span>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ title, spin = false, onClick, children }: { title: string; spin?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={spin ? "animate-spin" : undefined}
      >
        {children}
      </svg>
    </button>
  );
}

function IconPath({ d }: { d: string }) {
  return <path d={d} />;
}