"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { ItemForm } from "@/components/ItemForm";
import { centsToUsd, downloadTextFile, kindLabel, pluralize, truncated, toCsv } from "@/lib/utils";
import type { Item, ItemKind, Location } from "@/lib/types";

const KINDS: Array<ItemKind | "all"> = ["all", "sealed", "bulk_cards", "other"];

type LocFilter = "all" | "unassigned" | string;

export function InventoryClient({ initial }: { initial: Item[] }) {
  const [items, setItems] = useState<Item[]>(initial);
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

  function flash(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 2500);
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
    if (!window.confirm(`Delete "${item.name}"? Only items with zero stock can be deleted.`)) return;
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
      const data = await res.json();
      if (!res.ok) {
        flash(data?.error ?? "Refresh failed");
      } else {
        flash(`Value updated: ${centsToUsd(data.value_cents)}`);
      }
      load();
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
      {/* Header actions */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs flex-1"
          placeholder="Search name / barcode / set…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-0.5">
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
          Show inactive
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
              "goodwhill-inventory.csv",
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

      <p className="mb-3 text-xs text-slate-500">
        {filtered.length} item{filtered.length === 1 ? "" : "s"} · {summary.units} units ·
        inventory value {centsToUsd(summary.value)} (filtered by current view)
      </p>

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
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <ul className="divide-y divide-slate-100">
            {filtered.map((item) => (
              <li key={item.id}>
                <ItemRow
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
                />
              </li>
            ))}
          </ul>
        </div>
      )}

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
            onSaved={() => {
              setEditing(null);
              load();
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </Modal>

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

function ItemRow({
  item,
  locations,
  onAssignLocation,
  onEdit,
  onAdjust,
  onToggleActive,
  onDelete,
  onRefreshPrice,
}: {
  item: Item;
  locations: Location[];
  onAssignLocation: (locationId: string) => void;
  onEdit: () => void;
  onAdjust: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onRefreshPrice: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 transition hover:bg-slate-50 sm:items-center">
      <div className="h-14 w-11 shrink-0 overflow-hidden rounded-md border border-slate-150 bg-slate-100">
        {item.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.image_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs font-bold text-slate-300">
            {item.kind === "sealed" ? "SE" : item.kind === "bulk_cards" ? "TCG" : "OT"}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`truncate text-sm font-semibold ${item.active ? "" : "text-slate-400 line-through"}`}>
            {truncated(item.name, 60)}
          </span>
          <span className="badge badge-slate">{kindLabel(item.kind)}</span>
          {item.upc && <span className="badge badge-indigo">{item.upc}</span>}
          {item.set_code && <span className="badge badge-amber">{item.set_code}</span>}
          {item.price_source && <span className="badge badge-green">{item.price_source.replace("_", " ")}</span>}
          {item.location_id && (
            <span className="badge badge-purple">
              {locations.find((l) => l.id === item.location_id)?.name ?? "?"}
            </span>
          )}
        </div>
        {item.notes && <p className="mt-0.5 truncate text-xs text-slate-400">{item.notes}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className={item.quantity === 0 ? "font-bold text-red-600" : "font-bold"}>
            {pluralize(item.quantity, "unit")}
          </span>
          <span>
            value {centsToUsd(item.value_cents)}
            <button
              className="ml-1 text-indigo-600 underline-offset-2 hover:underline"
              onClick={async () => {
                setBusy(true);
                try {
                  await onRefreshPrice();
                } finally {
                  setBusy(false);
                }
              }}
              title="Refresh price"
            >
              {busy ? "pricing…" : "refresh"}
            </button>
          </span>
          {item.unit_cost_cents != null && <span>cost {centsToUsd(item.unit_cost_cents)}</span>}
          {item.price_checked_at && (
            <span className="hidden lg:inline">checked {item.price_checked_at.slice(0, 10)}</span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
        <select
          className="input max-w-36 px-2 py-1 text-xs"
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
        <div className="flex items-center gap-1">
          <IconBtn title="Add stock" onClick={onAdjust} label="+" />
          <IconBtn title="Remove stock" onClick={onAdjust} label="−" />
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={onEdit}>
            Edit
          </button>
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={onToggleActive}>
            {item.active ? "Pause" : "Resume"}
          </button>
          <button
            className="btn btn-ghost px-2 py-1 text-xs text-red-600"
            onClick={onDelete}
            disabled={item.quantity > 0}
            title={item.quantity > 0 ? "Remove stock first to delete" : "Delete"}
          >
            Del
          </button>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-500 transition hover:bg-slate-100"
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}