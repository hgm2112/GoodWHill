"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { centsToUsd, formatDateTime, truncated } from "@/lib/utils";
import type { Item, PriceHistoryPoint } from "@/lib/types";

const SOURCE_LABEL: Record<string, string> = {
  insights: "eBay sold",
  browse_active: "eBay active",
  scryfall: "Scryfall",
  manual: "Manual",
};

/** Tiny value-over-time line for inventory cards (needs ≥2 snapshots). */
export function Sparkline({ points }: { points: PriceHistoryPoint[] }) {
  if (points.length < 2) return null;

  const w = 96;
  const h = 22;
  const pad = 2;
  const t0 = Date.parse(points[0].created_at);
  const t1 = Date.parse(points[points.length - 1].created_at);
  const span = Math.max(t1 - t0, 1);
  const values = points.map((p) => p.value_cents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  const coords = points
    .map((p) => {
      const x = pad + ((Date.parse(p.created_at) - t0) / span) * (w - pad * 2);
      const y = range === 0 ? h / 2 : pad + (1 - (p.value_cents - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const up = values[values.length - 1] >= values[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 h-5 w-full" aria-hidden="true">
      <polyline
        points={coords}
        fill="none"
        stroke={up ? "#10b981" : "#ef4444"}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Full-size price-over-time line chart (SVG, no deps). */
function HistoryChart({ points }: { points: PriceHistoryPoint[] }) {
  const w = 320;
  const h = 130;
  const padX = 6;
  const padY = 10;
  const t0 = Date.parse(points[0].created_at);
  const t1 = Date.parse(points[points.length - 1].created_at);
  const span = Math.max(t1 - t0, 1);
  const values = points.map((p) => p.value_cents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  const coords = points.map((p) => {
    const x = padX + ((Date.parse(p.created_at) - t0) / span) * (w - padX * 2);
    const y = range === 0 ? h / 2 : padY + (1 - (p.value_cents - min) / range) * (h - padY * 2);
    return { x, y };
  });
  const path = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  const stroke = up ? "#10b981" : "#ef4444";

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Price over time">
        <polyline
          points={path}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {coords.length <= 40 &&
          coords.map((c, i) => <circle key={i} cx={c.x} cy={c.y} r={2.5} fill={stroke} />)}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{points[0].created_at.slice(0, 10)}</span>
        <span>{points[points.length - 1].created_at.slice(0, 10)}</span>
      </div>
    </div>
  );
}

/** Per-item price history: stats, chart, and the last 10 snapshots. */
export function PriceHistoryModal({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const [points, setPoints] = useState<PriceHistoryPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const itemId = item?.id ?? null;

  useEffect(() => {
    if (!itemId) {
      setPoints(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setPoints(null);
    setFailed(false);
    fetch(`/api/inventory/${itemId}/price-history`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
      .then((d: { points?: PriceHistoryPoint[] }) => {
        if (!cancelled) setPoints(Array.isArray(d?.points) ? d.points : []);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setPoints([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const list = points ?? [];
  const values = list.map((p) => p.value_cents);
  const has = list.length > 0;
  const first = has ? values[0] : 0;
  const last = has ? values[values.length - 1] : 0;
  const min = has ? Math.min(...values) : 0;
  const max = has ? Math.max(...values) : 0;
  const change = has ? last - first : 0;
  const current = item?.value_cents ?? last;

  const rows = list
    .map((point, i) => ({ point, delta: i === 0 ? null : values[i] - values[i - 1] }))
    .slice(-10)
    .reverse();

  return (
    <Modal
      open={item !== null}
      onClose={onClose}
      title={item ? `Price history · ${truncated(item.name, 32)}` : "Price history"}
    >
      {points === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : failed ? (
        <p className="text-sm text-slate-500">Couldn&apos;t load price history.</p>
      ) : !has ? (
        <p className="text-sm text-slate-500">
          No history yet — refresh the price or set a value to start tracking.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2 text-center">
            <HistStat label="Current" value={centsToUsd(current)} />
            <HistStat label="Min" value={centsToUsd(min)} />
            <HistStat label="Max" value={centsToUsd(max)} />
            <HistStat
              label="Change"
              value={`${change > 0 ? "+" : ""}${centsToUsd(change)}`}
              tone={change > 0 ? "up" : change < 0 ? "down" : undefined}
            />
          </div>

          <HistoryChart points={list} />

          <div className="overflow-hidden rounded-lg border border-slate-100">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Date</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">Price</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">Δ</th>
                  <th className="px-2.5 py-1.5 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(({ point, delta }) => (
                  <tr key={point.id}>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-slate-500">
                      {formatDateTime(point.created_at)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right font-semibold">
                      {centsToUsd(point.value_cents)}
                    </td>
                    <td
                      className={`px-2.5 py-1.5 text-right ${
                        delta == null
                          ? "text-slate-300"
                          : delta > 0
                            ? "text-emerald-600"
                            : delta < 0
                              ? "text-red-600"
                              : "text-slate-400"
                      }`}
                    >
                      {delta == null ? "—" : `${delta > 0 ? "+" : ""}${centsToUsd(delta)}`}
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-500">
                      {SOURCE_LABEL[point.price_source] ?? point.price_source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.length > rows.length && (
            <p className="text-right text-[10px] text-slate-400">
              showing last {rows.length} of {list.length} snapshots
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function HistStat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-lg bg-slate-50 px-1.5 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p
        className={`truncate text-sm font-bold ${
          tone === "up" ? "text-emerald-600" : tone === "down" ? "text-red-600" : "text-slate-800"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
