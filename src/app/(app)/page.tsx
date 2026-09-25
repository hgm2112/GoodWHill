import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { centsToUsd, formatDateTime, truncated } from "@/lib/utils";
import { fetchUpcomingReleases, type UpcomingRelease } from "@/lib/releases";

async function loadDashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [items, bundles, listings, sales] = await Promise.all([
    supabase.from("items").select("*").eq("owner_id", user.id).order("created_at", { ascending: false }).limit(500),
    supabase.from("bundles").select("*").eq("owner_id", user.id).order("created_at", { ascending: false }).limit(50),
    supabase.from("listings").select("*").eq("owner_id", user.id).order("last_synced_at", { ascending: false }).limit(20),
    supabase
      .from("sales")
      .select("*, item:items!sales_item_id_fkey(name), bundle:bundles!sales_bundle_id_fkey(name)")
      .eq("owner_id", user.id)
      .order("sold_at", { ascending: false })
      .limit(8),
  ]);

  return {
    user,
    items: items.data ?? [],
    itemsError: items.error?.message ?? null,
    bundles: bundles.data ?? [],
    listings: listings.data ?? [],
    sales: sales.data ?? [],
  };
}

export default async function DashboardPage() {
  const [d, releases] = await Promise.all([loadDashboard(), fetchUpcomingReleases()]);

  let value = 0;
  let units = 0;
  for (const i of d.items) {
    const v = (i.value_cents ?? 0) * i.quantity;
    value += v;
    units += i.quantity;
  }

  const net = d.sales.reduce((a, s) => a + (s.net_cents ?? 0), 0);
  const activeListings = d.listings.filter((l) => l.status === "ACTIVE").length;
  const needsAction = d.bundles.filter((b) => b.status === "allocated").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Inventory value" value={centsToUsd(value)} sub={`${units} units across ${d.items.length} items`} />
        <Stat label="eBay listings" value={String(activeListings)} sub="active right now" link="/listings" />
        <Stat label="Bundles to finish" value={String(needsAction)} sub="stock reserved" link="/bundles" />
        <Stat label="Net from sales" value={centsToUsd(net)} sub={`${d.sales.length} recent sales`} link="/sales" />
      </div>
      <p className="text-xs text-slate-400">
        {d.itemsError ? `Inventory read error: ${d.itemsError}` : "Values are resale estimates, summed from every item row (active + paused)."}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-0">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <h2 className="text-sm font-bold">Recent sales</h2>
            <Link href="/sales" className="text-xs text-indigo-600 hover:underline">
              All →
            </Link>
          </div>
          {d.sales.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">No sales yet — record one when you ship.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.sales.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-4 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {s.item?.name ?? s.bundle?.name ?? "Sale"}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {s.sold_at.slice(0, 10)} · {s.buyer ?? "—"} · qty {s.quantity}
                    </span>
                  </span>
                  <span className="text-sm font-semibold text-emerald-700">{centsToUsd(s.net_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-0">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <h2 className="text-sm font-bold">Upcoming releases</h2>
          </div>
          {releases.releases.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">
              {releases.errors.length
                ? "Couldn't load the release calendars right now."
                : "No upcoming releases listed yet."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {releases.releases.slice(0, 8).map((r) => (
                <li key={`${r.game}-${r.name}`} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="w-14 shrink-0 text-xs font-semibold text-slate-500">
                    {r.date ? shortReleaseDate(r.date) : "TBA"}
                  </span>
                  <a
                    href={r.url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 flex-1 truncate text-sm font-medium text-indigo-600 hover:underline"
                  >
                    {truncated(r.name, 52)}
                  </a>
                  <span className={releaseBadge(r)}>{r.label}</span>
                </li>
              ))}
            </ul>
          )}
          {releases.errors.length > 0 && releases.releases.length > 0 && (
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
              One of the release calendars didn&apos;t load — showing partial results.
            </p>
          )}

          <div className="border-t border-slate-100 px-4 py-2.5">
            <h2 className="mb-1 text-sm font-bold">Reserved in bundles</h2>
            {d.bundles.filter((b) => b.status === "allocated").length === 0 ? (
              <p className="text-sm text-slate-500">Nothing reserved. Generate a bundle to set stock aside.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {d.bundles
                  .filter((b) => b.status === "allocated")
                  .slice(0, 4)
                  .map((b) => (
                    <li key={b.id} className="flex items-center justify-between py-1.5">
                      <Link href={`/bundles/${b.id}`} className="truncate text-sm text-indigo-600 hover:underline">
                        {truncated(b.name, 40)}
                      </Link>
                      <span className="text-xs text-slate-400">created {formatDateTime(b.created_at).split(" ")[0]}</span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, link }: { label: string; value: string; sub?: string; link?: string }) {
  const body = (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 truncate text-xl font-bold text-slate-800">{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-slate-400">{sub}</p>}
    </div>
  );
  return link ? <Link href={link}>{body}</Link> : body;
}

const RELEASE_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "Oct 2" from a YYYY-MM-DD string. Parses the parts directly — `new Date(iso)`
 * would read UTC midnight and show the previous day in US timezones.
 * Shows the year when it isn't the current one.
 */
function shortReleaseDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const label = `${RELEASE_MONTHS[m - 1]} ${d}`;
  return y === new Date().getFullYear() ? label : `${label} ${y}`;
}

function releaseBadge(r: UpcomingRelease): string {
  if (r.label === "Secret Lair") return "badge badge-purple";
  if (r.game === "pokemon") return "badge badge-amber";
  return "badge badge-indigo";
}