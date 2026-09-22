"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, NumberDollars } from "@/components/ui/Modal";
import { centsToUsd, downloadTextFile, truncated } from "@/lib/utils";
import type { Bundle, Item, Sale } from "@/lib/types";

export interface SaleRow extends Sale {
  item?: { name: string; kind: Item["kind"] } | null;
  bundle?: { name: string } | null;
}

export function SalesClient({
  initial,
  items,
  bundles,
}: {
  initial: SaleRow[];
  items: Item[];
  bundles: Bundle[];
}) {
  const router = useRouter();
  const sales = initial;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [itemId, setItemId] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [gross, setGross] = useState<number | null>(null);
  const [fee, setFee] = useState<number | null>(null);
  const [shipping, setShipping] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [buyer, setBuyer] = useState("");
  const [ebayOrderId, setEbayOrderId] = useState("");
  const [soldAt, setSoldAt] = useState("");
  const [note, setNote] = useState("");

  const totals = useMemo(
    () =>
      sales.reduce(
        (a, s) => ({
          gross: a.gross + (s.gross_cents ?? 0),
          fees: a.fees + (s.fee_cents ?? 0),
          shipping: a.shipping + (s.shipping_cents ?? 0),
          net: a.net + (s.net_cents ?? 0),
        }),
        { gross: 0, fees: 0, shipping: 0, net: 0 },
      ),
    [sales],
  );

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  }

  function reset() {
    setItemId("");
    setBundleId("");
    setGross(null);
    setFee(null);
    setShipping(null);
    setQuantity(1);
    setBuyer("");
    setEbayOrderId("");
    setSoldAt("");
    setNote("");
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId && !bundleId) {
      setError("Select an item or a bundle");
      return;
    }
    if (!gross || gross <= 0) {
      setError("Gross must be > 0");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: itemId || null,
          bundleId: bundleId || null,
          grossCents: gross,
          feeCents: fee ?? 0,
          shippingCents: shipping ?? 0,
          quantity,
          buyer: buyer.trim() || null,
          ebayOrderId: ebayOrderId.trim() || null,
          soldAt: soldAt ? new Date(soldAt).toISOString() : undefined,
          note: note.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? (data?.available != null ? `Only ${data.available} available` : "Couldn't record sale"));
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
      flash("Sale recorded — stock deducted");
    } finally {
      setBusy(false);
    }
  }

  async function remove(sale: SaleRow) {
    if (!window.confirm(`Delete this sale? Stock will be restored to inventory.`)) return;
    const res = await fetch(`/api/sales/${sale.id}`, { method: "DELETE" });
    flash(res.ok ? "Sale deleted, stock restored" : "Delete failed");
    router.refresh();
  }

  async function exportCsv() {
    try {
      const res = await fetch("/api/sales?export=csv");
      const text = await res.text();
      downloadTextFile("goodwhill-sales.csv", text, "text/csv");
    } catch {
      flash("Export failed");
    }
  }

  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Gross" value={centsToUsd(totals.gross)} />
        <Stat label="Fees" value={centsToUsd(totals.fees)} />
        <Stat label="Shipping" value={centsToUsd(totals.shipping)} />
        <Stat label="Net" value={centsToUsd(totals.net)} emerald />
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <button className="btn btn-secondary" onClick={exportCsv}>
          Export CSV
        </button>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          + Record sale
        </button>
      </div>

      {sales.length === 0 ? (
        <div className="card text-center text-sm text-slate-500">
          No sales recorded yet. When you sell on eBay (or in person), log it here so stock stays accurate.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="table-head">Sold</th>
                <th className="table-head">Item / Bundle</th>
                <th className="table-head text-right">Qty</th>
                <th className="table-head text-right">Gross</th>
                <th className="table-head text-right">Net</th>
                <th className="table-head">Buyer</th>
                <th className="table-head">eBay</th>
                <th className="table-head"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sales.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="table-cell whitespace-nowrap text-slate-500">
                    {s.sold_at.slice(0, 10)}
                  </td>
                  <td className="table-cell font-medium">
                    {s.item
                      ? `${truncated(s.item.name, 28)} (${s.item.kind.replace("_", " ")})`
                      : s.bundle
                        ? `${truncated(s.bundle.name, 28)} (bundle)`
                        : "—"}
                    {s.ebay_item_id && (
                      <span className="block text-xs text-slate-400">{s.ebay_item_id}</span>
                    )}
                  </td>
                  <td className="table-cell text-right">{s.quantity}</td>
                  <td className="table-cell text-right">{centsToUsd(s.gross_cents)}</td>
                  <td className={`table-cell text-right font-semibold ${s.net_cents >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {centsToUsd(s.net_cents)}
                  </td>
                  <td className="table-cell whitespace-nowrap text-slate-500">{s.buyer ?? "—"}</td>
                  <td className="table-cell whitespace-nowrap text-xs text-slate-400">
                    {s.ebay_order_id ? (
                      <button
                        className="text-indigo-600 hover:underline"
                        title={`Overseas order ${s.ebay_order_id}`}
                      >
                        {s.ebay_order_id.slice(0, 12)}…
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="table-cell text-right">
                    <button className="btn btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => remove(s)}>
                      Del
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Record a sale">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">Sold item <span className="font-normal text-slate-400">or bundle</span></label>
              <select className="input" value={itemId} onChange={(e) => { setItemId(e.target.value); setBundleId(""); }}>
                <option value="">— Item —</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {truncated(i.name, 40)} ({i.quantity} in stock)
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <select className="input" value={bundleId} onChange={(e) => { setBundleId(e.target.value); setItemId(""); }}>
                <option value="">— Bundle —</option>
                {bundles
                  .filter((b) => b.status !== "sold" && b.status !== "cancelled")
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {truncated(b.name, 40)} ({b.status})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label">Gross (charged)</label>
              <NumberDollars valueCents={gross} onChange={setGross} />
            </div>
            <div>
              <label className="label">eBay fee</label>
              <NumberDollars valueCents={fee} onChange={setFee} />
            </div>
            <div>
              <label className="label">Shipping charged</label>
              <NumberDollars valueCents={shipping} onChange={setShipping} />
            </div>
            <div>
              <label className="label">Quantity {itemId ? "sold" : ""}</label>
              <input className="input" type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
            </div>
            <div>
              <label className="label">Buyer</label>
              <input className="input" value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="username or blank" />
            </div>
            <div>
              <label className="label">eBay order ID</label>
              <input className="input" value={ebayOrderId} onChange={(e) => setEbayOrderId(e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="label">Sale date</label>
              <input className="input" type="datetime-local" value={soldAt} onChange={(e) => setSoldAt(e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="label">Note</label>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional context" />
            </div>
            <p className="col-span-2 text-xs text-slate-400">
              Net = gross − fee (freight absorbed unless priced in). Recording a sale deducts that
              much stock; a bundle sale also marks the bundle sold and its allocations.
            </p>
          </div>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Recording…" : "Record sale"}
            </button>
          </div>
        </form>
      </Modal>

      {toast && (
        <div className="fixed inset-x-4 bottom-16 z-50 rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white shadow-xl sm:bottom-6">
          {toast}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, emerald }: { label: string; value: string; emerald?: boolean }) {
  return (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-0.5 text-lg font-bold ${emerald ? "text-emerald-700" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}