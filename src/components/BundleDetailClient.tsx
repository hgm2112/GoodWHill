"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NumberDollars } from "@/components/ui/Modal";
import { bundlePriceCents, bundleToCsv, generateListingText } from "@/lib/bundle";
import { centsToUsd, downloadTextFile, formatDateTime, kindLabel, pluralize, truncated } from "@/lib/utils";
import type { BundleStatus, BundleWithItems, Location } from "@/lib/types";

const STATUS_STYLES: Record<BundleStatus, string> = {
  draft: "rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600",
  allocated: "rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700",
  listed: "rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700",
  sold: "rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700",
  cancelled: "rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-600",
};

interface EbayListingLite {
  ebay_listing_id: string;
  title: string;
  price_cents: number | null;
  shipping_cents?: number | null;
  status: string;
  item_uri?: string | null;
  last_synced_at?: string | null;
}

// Generic listing words that don't distinguish one lot from another.
const SUGGEST_STOP = new Set([
  "the", "and", "a", "an", "of", "for", "with", "or", "to", "in", "on", "at", "by", "from",
  "lot", "sealed", "magic", "gathering", "misc", "mtg", "x", "4x", "new", "official",
]);

function titleTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2 && !SUGGEST_STOP.has(t));
}

/** Best ACTIVE listing for a draft title: ≥2 shared meaningful words and
 * ≥30% of the draft's words present. Returns null when nothing fits. */
function suggestListing(draftTitle: string, listings: EbayListingLite[]): string | null {
  const draftTokens = titleTokens(draftTitle);
  if (draftTokens.length < 2) return null;
  let best: { id: string; score: number } | null = null;
  for (const l of listings) {
    const listingTokens = new Set(titleTokens(l.title));
    const shared = draftTokens.filter((t) => listingTokens.has(t)).length;
    const score = shared / draftTokens.length;
    if (shared >= 2 && score >= 0.3 && (!best || score > best.score)) {
      best = { id: l.ebay_listing_id, score };
    }
  }
  return best?.id ?? null;
}

export function BundleDetailClient({ initial }: { initial: BundleWithItems }) {
  const router = useRouter();
  const [bundle, setBundle] = useState(initial);
  const [draft, setDraft] = useState<{ title: string; description: string } | null>(null);
  const [editingDraft, setEditingDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [listingPanel, setListingPanel] = useState<null | "list" | "edit">(null);
  const [listingPrice, setListingPrice] = useState<number | null>(null);
  const [listingShipping, setListingShipping] = useState<number | null>(null);
  const [ebayListings, setEbayListings] = useState<EbayListingLite[]>([]);
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [pickId, setPickId] = useState("");

  useEffect(() => {
    fetch("/api/locations")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data?.locations)) setLocations(data.locations);
      })
      .catch(() => {});
    fetch("/api/listings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data)) {
          setEbayListings(data.filter((l: EbayListingLite) => l.status === "ACTIVE"));
        }
      })
      .catch(() => {});
    fetch("/api/drafts")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data)) {
          const mine = data.find(
            (d: { bundle_id?: string | null; title?: string; description?: string | null }) =>
              d.bundle_id === initial.id && d.title,
          );
          if (mine) {
            // Load the saved draft (collapsed) so the button reads
            // "Edit listing draft" from the start — never regenerate here.
            setDraftTitle(mine.title);
            setDraft({ title: mine.title, description: mine.description ?? "" });
          }
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function boxName(locationId: string | null): string {
    if (!locationId) return "Unassigned";
    return locations.find((l) => l.id === locationId)?.name ?? "Unassigned";
  }

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  }

  async function api(path: string, init?: RequestInit) {
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? "Request failed");
    return data;
  }

  async function setStatus(status: BundleStatus) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api(`/api/bundles/${bundle.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setBundle(updated);
      if (status === "cancelled") {
        const released = updated?._released ?? 0;
        flash(
          released > 0
            ? `Cancelled — released ${pluralize(released, "reserved line")}; stock restored`
            : "Cancelled — reserved stock was restored to inventory",
        );
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  function openListingPanel(mode: "list" | "edit") {
    setListingPanel(mode);
    setListingPrice(bundle.listing_price_cents ?? bundlePriceCents(bundle.total_value_cents));
    setListingShipping(bundle.shipping_cents ?? null);
    setError(null);
  }

  async function saveListing(markListed: boolean) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api(`/api/bundles/${bundle.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: markListed ? "listed" : bundle.status,
          listingPriceCents: listingPrice ?? null,
          shippingCents: listingShipping ?? null,
        }),
      });
      setBundle(updated);
      setListingPanel(null);
      flash(markListed ? "Marked listed — Actual Listing Price saved" : "Listing price updated");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function fillFromEbay(ebayListingId?: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api(`/api/bundles/${bundle.id}/ebay-fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ebayListingId ? { ebayListingId } : {}),
      });
      setBundle(updated);
      setListingPanel(null);
      flash(
        updated?._synced
          ? "Filled Actual Listing Price & Shipping Fee from eBay"
          : "Filled from last sync — eBay was unreachable",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't fill from eBay");
    } finally {
      setBusy(false);
    }
  }

  async function unlinkListing() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api(`/api/bundles/${bundle.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: bundle.status, ebayListingId: null }),
      });
      setBundle(updated);
      setPickId("");
      flash("Unlinked — saved prices kept");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't unlink");
    } finally {
      setBusy(false);
    }
  }

  async function loadDraft() {
    setBusy(true);
    setError(null);
    try {
      const existing = await api(`/api/bundles/${bundle.id}/draft`);
      if (existing && existing.title) {
        setDraft({ title: existing.title, description: existing.description });
        setEditingDraft(true);
      } else {
        const created = await api(`/api/bundles/${bundle.id}/draft`, { method: "POST" });
        setDraft({ title: created.title, description: created.description });
        setEditingDraft(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate the draft");
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bundles/${bundle.id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title, description: draft.description }),
      });
      flash("Draft saved to the Drafts tab");
      setEditingDraft(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the draft");
    } finally {
      setBusy(false);
    }
  }

  function regenerateDraft() {
    if (!draft) return;
    if (
      !window.confirm(
        "Regenerate the draft text? This replaces the title and description above (nothing is saved until you click Save draft).",
      )
    )
      return;
    const fresh = generateListingText({
      name: bundle.name,
      lines: (bundle.items ?? []).map((bi) => ({
        item: bi.item,
        quantity: bi.quantity,
        valueCents: bi.value_cents,
      })),
    });
    setDraft(fresh);
    flash("Regenerated — review it, then Save draft");
  }

  async function remove() {
    if (!window.confirm("Delete this bundle and release its reserved stock?")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bundles/${bundle.id}`, { method: "DELETE" });
      router.replace("/bundles");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete");
      setBusy(false);
    }
  }

  const lines = bundle.items ?? [];
  const count = lines.reduce((n, bi) => n + bi.quantity, 0);
  const hasDraft = draft !== null;
  const suggestedId = draftTitle ? suggestListing(draftTitle, ebayListings) : null;
  const selectedId = pickId || bundle.ebay_listing_id || suggestedId || "";
  const isLinked = Boolean(bundle.ebay_listing_id);
  const linkedRow = isLinked
    ? ebayListings.find((l) => l.ebay_listing_id === bundle.ebay_listing_id) ?? null
    : null;
  const showPriceLine =
    bundle.listing_price_cents != null ||
    bundle.shipping_cents != null ||
    bundle.status === "listed" ||
    bundle.status === "sold";

  return (
    <div className="space-y-4">
      {/* Header actions */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={STATUS_STYLES[bundle.status]}>{bundle.status}</span>
        <span className="text-xs text-slate-400">
          created {formatDateTime(bundle.created_at)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {bundle.status !== "sold" && bundle.status !== "cancelled" && (
            <>
              <button className="btn btn-primary" onClick={loadDraft} disabled={busy}>
                {hasDraft ? "Edit listing draft" : "Generate listing draft"}
              </button>
              {bundle.status === "allocated" && (
                <button className="btn btn-secondary" onClick={() => openListingPanel("list")} disabled={busy}>
                  Mark listed
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => setStatus("sold")} disabled={busy}>
                Mark sold
              </button>
              <button className="btn btn-ghost text-red-600" onClick={() => setStatus("cancelled")} disabled={busy}>
                Cancel & release
              </button>
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() =>
                  downloadTextFile(
                    "bundle.csv",
                    bundleToCsv(
                      lines.map((bi) => ({
                        item: bi.item,
                        quantity: bi.quantity,
                        valueCents: bi.value_cents,
                      })),
                      bundle.total_value_cents,
                    ),
                    "text/csv",
                  )
                }
              >
                CSV
              </button>
            </>
          )}
          {bundle.status !== "sold" && (
            <button className="btn btn-ghost text-slate-400" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
        </span>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* Actual Listing Price / Shipping Fee */}
      {listingPanel && (
        <div className="card space-y-3">
          <p className="text-sm font-bold">
            {listingPanel === "list" ? "Mark listed" : "Edit listing price"}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Actual Listing Price</label>
              <NumberDollars valueCents={listingPrice} onChange={setListingPrice} />
            </div>
            <div>
              <label className="label">Shipping Fee</label>
              <NumberDollars valueCents={listingShipping} onChange={setListingShipping} />
            </div>
          </div>
          <p className="text-xs text-slate-400">
            {listingPanel === "list"
              ? "The price you actually listed it for on eBay (prefilled with the suggested bundle price) and what you charge for shipping."
              : "Saved values are used to prefill Gross / Shipping when you record this bundle as sold."}
          </p>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button className="btn btn-ghost" onClick={() => setListingPanel(null)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => saveListing(listingPanel === "list")} disabled={busy}>
              {busy ? "Saving…" : listingPanel === "list" ? "Mark listed" : "Save"}
            </button>
          </div>
        </div>
      )}
      {showPriceLine && !listingPanel && (
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <span className="font-semibold text-indigo-700">
            Actual Listing Price{" "}
            {bundle.listing_price_cents != null ? centsToUsd(bundle.listing_price_cents) : "—"}
          </span>
          <span className="text-slate-400">
            · Shipping Fee {bundle.shipping_cents != null ? centsToUsd(bundle.shipping_cents) : "—"}
          </span>
          <button
            className="text-xs font-medium text-indigo-600 hover:underline"
            onClick={() => openListingPanel("edit")}
            disabled={busy}
          >
            Edit
          </button>
        </p>
      )}

      {/* eBay listing link + auto-fill from synced listings */}
      <div className="card space-y-2">
        <p className="text-sm font-bold">eBay listing</p>
        {ebayListings.length === 0 ? (
          <p className="text-xs text-slate-400">
            No active eBay listings synced yet — run “Sync now from eBay” on the Listings tab, then
            reload.
          </p>
        ) : (
          <>
            <select
              className="input"
              value={selectedId}
              onChange={(e) => setPickId(e.target.value)}
              disabled={busy}
            >
              <option value="">— no listing linked —</option>
              {ebayListings.map((l) => (
                <option key={l.ebay_listing_id} value={l.ebay_listing_id}>
                  {truncated(l.title, 60)} ·{" "}
                  {l.price_cents != null ? centsToUsd(l.price_cents) : "?"}
                  {!isLinked && l.ebay_listing_id === suggestedId ? " (suggested)" : ""}
                </option>
              ))}
            </select>
            {!isLinked && suggestedId && selectedId === suggestedId && (
              <p className="text-xs text-indigo-600">
                Preselected from this bundle&apos;s listing draft title — confirm to link it.
              </p>
            )}
            {linkedRow && (
              <p className="text-xs text-slate-400">
                Linked {linkedRow.price_cents != null ? centsToUsd(linkedRow.price_cents) : "—"}
                {linkedRow.shipping_cents != null
                  ? ` + ${centsToUsd(linkedRow.shipping_cents)} shipping`
                  : ""}
                {" · synced "}
                {linkedRow.last_synced_at ? formatDateTime(linkedRow.last_synced_at) : "—"}
                {linkedRow.item_uri && (
                  <>
                    {" · "}
                    <a
                      href={linkedRow.item_uri}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-600 hover:underline"
                    >
                      open on eBay
                    </a>
                  </>
                )}
              </p>
            )}
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-2">
              <button
                className="btn btn-primary"
                disabled={busy || !selectedId}
                onClick={() => fillFromEbay(selectedId)}
              >
                {isLinked && selectedId === bundle.ebay_listing_id
                  ? "Refresh from eBay"
                  : "Link & fill price & shipping"}
              </button>
              {isLinked && (
                <button className="btn btn-ghost text-slate-500" onClick={unlinkListing} disabled={busy}>
                  Unlink
                </button>
              )}
            </div>
            <p className="text-xs text-slate-400">
              Fills Actual Listing Price + Shipping Fee from that listing — it syncs eBay first so the
              numbers are current. Manual edits afterwards still win until the next refresh.
            </p>
          </>
        )}
      </div>

      {/* Draft editor */}
      {draft && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold">eBay listing draft</p>
            <button className="btn btn-ghost text-xs" onClick={() => setEditingDraft(!editingDraft)}>
              {editingDraft ? "Collapse" : "Expand"}
            </button>
          </div>
          {editingDraft && (
            <>
              <div>
                <label className="label">Title</label>
                <input
                  className="input"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  maxLength={80}
                />
              </div>
              <div>
                <label className="label">Description</label>
                <textarea
                  className="input min-h-48 resize-y"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button className="btn btn-ghost mr-auto" onClick={regenerateDraft} disabled={busy}>
                  Regenerate
                </button>
                <button className="btn btn-ghost" onClick={() => setEditingDraft(false)}>
                  Close
                </button>
                <button className="btn btn-primary" onClick={saveDraft} disabled={busy}>
                  Save draft
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Items */}
      <div className="card p-0">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <p className="text-sm font-bold">Contents ({count} items)</p>
          <p className="text-sm">
            <span className="font-bold text-emerald-700">{centsToUsd(bundlePriceCents(bundle.total_value_cents))}</span>{" "}
            <span className="text-xs text-slate-400">
              price · {centsToUsd(bundle.total_value_cents)} value · fill {centsToUsd(bundle.target_value_cents)}
            </span>
          </p>
        </div>
        <ul className="divide-y divide-slate-100">
          {lines.map((bi) => (
            <li key={bi.id} className="flex items-center gap-3 px-4 py-2.5">
              {bi.item.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={bi.item.image_url} alt="" className="h-12 w-9 shrink-0 rounded-sm border border-slate-200 object-cover" />
              ) : (
                <span className="flex h-12 w-9 shrink-0 items-center justify-center rounded-sm border border-slate-200 bg-slate-100 text-xs text-slate-400">
                  ?
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{truncated(bi.item.name, 55)}</span>
                <span className="block text-xs text-slate-400">
                  {kindLabel(bi.item.kind)}
                  {` · ${boxName(bi.item.location_id)}`}
                  {bi.item.set_code ? ` · ${bi.item.set_code}` : ""}
                  {bi.quantity > 1 ? ` · ×${bi.quantity}` : ""}
                </span>
              </span>
              <span className="text-sm">
                <span className="font-semibold text-emerald-700">
                  {centsToUsd(bi.value_cents * bi.quantity)}
                </span>
                {bi.unit_cost_cents != null && (
                  <span className="ml-2 hidden text-xs text-slate-400 sm:inline">
                    cost {centsToUsd(bi.unit_cost_cents * bi.quantity)} · margin{" "}
                    {centsToUsd((bi.value_cents - bi.unit_cost_cents) * bi.quantity)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {toast && (
        <div className="fixed inset-x-4 bottom-16 z-50 rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white shadow-xl sm:bottom-6">
          {toast}
        </div>
      )}
    </div>
  );
}