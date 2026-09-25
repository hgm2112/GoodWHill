"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NumberDollars } from "@/components/ui/Modal";
import { ArtworkThumb } from "@/components/ArtworkThumb";
import { centsToUsd, ITEM_KINDS, kindLabel, truncated } from "@/lib/utils";
import { BUNDLE_DISCOUNT_PCT, BUNDLE_TOLERANCE_CENTS, gameOf } from "@/lib/bundle";
import type { Item, ItemKind, Location } from "@/lib/types";

interface PreviewLine {
  item: Item;
  quantity: number;
  valueCents: number;
  lineTotalCents: number;
}

interface Preview {
  targetCents: number;
  priceCents: number;
  totalCents: number;
  lines: PreviewLine[];
  suggestedName: string;
  game: string;
}

const PRESETS = [5000, 10000, 15000, 20000];

export function BundleBuilder() {
  const router = useRouter();
  const [targetCents, setTargetCents] = useState(10000);
  const [kinds, setKinds] = useState<ItemKind[]>(["sealed", "loose"]);
  const [games, setGames] = useState<string[]>([]);
  const [game, setGame] = useState("__any");
  const [dominant, setDominant] = useState(true);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [createdRecently, setCreatedRecently] = useState<number>(0);

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  }

  function toggleKind(k: ItemKind) {
    setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  }

  function boxName(locationId: string | null): string {
    if (!locationId) return "Unassigned";
    return locations.find((l) => l.id === locationId)?.name ?? "Unassigned";
  }

  useEffect(() => {
    fetch("/api/locations")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data?.locations)) setLocations(data.locations);
      })
      .catch(() => {});
    fetch("/api/inventory")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!Array.isArray(data)) return;
        const seen = new Map<string, string>();
        for (const item of data as Item[]) {
          const label = gameOf(item.category);
          if (!label) continue;
          const key = label.toLowerCase();
          if (!seen.has(key)) seen.set(key, label);
        }
        setGames([...seen.values()]);
      })
      .catch(() => {});
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    if (!kinds.length) {
      setError("Pick at least one item type.");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/bundles/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetCents,
          kinds,
          dominant,
          ...(game !== "__any" ? { game } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Generation failed (${res.status})`);
        setPreview(null);
        return;
      }
      if (!data || !Array.isArray(data.lines)) {
        setError("Generation failed — the server returned an unexpected response.");
        setPreview(null);
        return;
      }
      setPreview(data);
      if (!nameEdited || !name.trim()) {
        setName(data.suggestedName);
        setNameEdited(false);
      }
    } catch {
      setError("Generation failed — check your connection and try again.");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!preview) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || preview.suggestedName,
          targetCents,
          kinds,
          dominant,
          game: preview.game,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Create failed (${res.status})`);
        return;
      }
      flash(`Bundle created — stock reserved`);
      setCreatedRecently((n) => n + 1);
      setPreview(null);
      setName("");
      setNameEdited(false);
      router.refresh();
    } catch {
      setError("Create failed — check your connection and try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <label className="label">Bundle price</label>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${
                targetCents === p
                  ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
              onClick={() => setTargetCents(p)}
            >
              ${p / 100}
            </button>
          ))}
          <div className="ml-auto w-28">
            <NumberDollars valueCents={targetCents} onChange={(v) => setTargetCents(v ?? 0)} />
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          What the bundle sells for. Contents are filled to ~{BUNDLE_DISCOUNT_PCT}% above this
          price — that discount stays between you and the app.
        </p>

        <label className="label mt-4">Bundle from</label>
        <select className="input" value={game} onChange={(e) => setGame(e.target.value)}>
          <option value="__any">Any — one game per bundle</option>
          {games.map((g) => (
            <option key={g} value={g}>
              {g} only
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400">
          Bundles never mix games — MTG stays with MTG, Pokemon with Pokemon. Choices come from
          your items&apos; categories.
        </p>

        <label className="label mt-4">Include</label>
        <div className="flex flex-wrap gap-2">
          {([...ITEM_KINDS] as ItemKind[]).map((k) => (
            <label key={k} className="flex items-center gap-1.5 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={kinds.includes(k)}
                onChange={() => toggleKind(k)}
              />
              {kindLabel(k)}
            </label>
          ))}
        </div>

        <label className="mt-4 flex items-start gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={dominant}
            onChange={(e) => setDominant(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            One dominant item
            <span className="block text-xs text-slate-400">
              Starts with your priciest eligible item and fills with smaller stuff.
              Uncheck for a random mix.
            </span>
          </span>
        </label>

        <div className="mt-4 flex gap-2">
          <button className="btn btn-primary flex-1" onClick={generate} disabled={busy || creating}>
            {preview && !busy ? "Regenerate" : "Generate bundle"}
          </button>
        </div>
        {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {createdRecently > 0 && (
          <p className="mt-2 text-xs text-slate-400">View it on the Bundles tab after creation.</p>
        )}
      </div>

      {preview && (
        <div className="card space-y-3">
          <div>
            <p className="text-sm font-semibold">
              Preview{preview.game ? ` · ${preview.game}` : ""}
            </p>
            <p className="mt-1 flex flex-wrap items-baseline gap-2">
              <span className="text-lg font-bold text-emerald-700">
                Bundle price {centsToUsd(preview.priceCents)}
              </span>
              <span className="text-xs text-slate-400">
                {BUNDLE_DISCOUNT_PCT}% off {centsToUsd(preview.totalCents)} value
              </span>
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <span className={badgeColor(preview.totalCents, preview.targetCents)}>
                Contents {centsToUsd(preview.totalCents)} / fill target {centsToUsd(preview.targetCents)}
              </span>
              <span className="text-xs text-slate-400">
                {preview.totalCents === preview.targetCents
                  ? "right on target"
                  : preview.totalCents > preview.targetCents
                    ? `${centsToUsd(preview.totalCents - preview.targetCents)} over target`
                    : `${centsToUsd(preview.targetCents - preview.totalCents)} under target`}{" "}
                — regenerating picks a fresh random selection
              </span>
            </p>
          </div>

          <ul className="divide-y divide-slate-100">
            {preview.lines.map((l, i) => (
              <li key={`${l.item.id}-${i}`} className="flex items-center gap-3 py-2">
                <span className="w-5 shrink-0 text-center text-xs font-bold text-slate-300">{i + 1}</span>
                {l.item.image_url ? (
                  <ArtworkThumb
                    src={l.item.image_url}
                    alt={l.item.name}
                    className="h-12 w-9 shrink-0 rounded-sm border border-slate-200"
                  />
                ) : (
                  <span className="flex h-12 w-9 shrink-0 items-center justify-center rounded-sm border border-slate-200 bg-slate-100 text-xs text-slate-400">
                    ?
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{truncated(l.item.name, 55)}</span>
                  <span className="block text-xs text-slate-400">
                    {kindLabel(l.item.kind)}
                    {` · ${boxName(l.item.location_id)}`}
                    {l.item.set_code ? ` · ${l.item.set_code}` : ""}
                    {l.quantity > 1 ? ` · ×${l.quantity}` : ""}
                  </span>
                </span>
                <span className="text-sm font-semibold text-emerald-700">
                  {centsToUsd(l.lineTotalCents)}
                </span>
              </li>
            ))}
          </ul>

          <div className="space-y-2 border-t border-slate-100 pt-3">
            <label className="label">Bundle name (for the eBay listing)</label>
            <input
              className="input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              placeholder={preview.suggestedName}
            />
            <button className="btn btn-primary w-full" onClick={create} disabled={creating}>
              {creating ? "Reserving stock…" : "Create bundle & reserve stock"}
            </button>
            <p className="text-xs text-slate-400">
              Stock for these items is immediately reserved and item quantity drops. You can cancel
              to release it, or generate the eBay listing draft next.
            </p>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed inset-x-4 bottom-16 z-50 rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white shadow-xl sm:bottom-6">
          {toast}
        </div>
      )}
    </div>
  );
}

function badgeColor(total: number, target: number) {
  const within = Math.abs(total - target) <= BUNDLE_TOLERANCE_CENTS;
  return within
    ? "rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700"
    : "rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700";
}