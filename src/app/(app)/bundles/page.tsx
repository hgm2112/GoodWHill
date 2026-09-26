import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BundleBuilder } from "@/components/BundleBuilder";
import { bundlePriceCents, ebayTitlesForBundles } from "@/lib/bundle";
import { centsToUsd, truncated } from "@/lib/utils";

export const metadata = { title: "Bundles · goodwhilly" };

export default async function BundlesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: bundles } = await supabase
    .from("bundles")
    .select("*, bundle_items(quantity)")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });

  const titles = await ebayTitlesForBundles(
    supabase,
    user.id,
    (bundles ?? []).map((b: { ebay_listing_id: string | null }) => b.ebay_listing_id),
  );

  const wrapped = (bundles ?? []).map(
    (b: {
      id: string;
      name: string;
      ebay_listing_id: string | null;
      target_value_cents: number;
      total_value_cents: number;
      status: string;
      listing_price_cents: number | null;
      shipping_cents: number | null;
      created_at: string;
      bundle_items?: Array<{ quantity: number }>;
    }) => ({
      id: b.id,
      name: titles.get(b.ebay_listing_id ?? "") ?? b.name,
      target_value_cents: b.target_value_cents,
      total_value_cents: b.total_value_cents,
      status: b.status,
      listing_price_cents: b.listing_price_cents,
      shipping_cents: b.shipping_cents,
      listingLabel: [
        ...(b.shipping_cents != null ? [`ship ${centsToUsd(b.shipping_cents)}`] : []),
      ].join(" · "),
      created_at: b.created_at,
      item_count: (b.bundle_items ?? []).reduce(
        (n: number, x: { quantity: number }) => n + x.quantity,
        0,
      ),
    }),
  );

  return (
    <div className="grid items-start gap-4 lg:grid-cols-5">
      <div className="space-y-3 lg:col-span-3">
        <h1 className="text-sm font-bold uppercase tracking-wide text-slate-500">Generated bundles</h1>
        {wrapped.length === 0 ? (
          <div className="card text-sm text-slate-500">
            No bundles yet. Use the builder to create a mystery bundle from your current stock — stock
            is reserved the moment you create it.
          </div>
        ) : (
          <ul className="space-y-2">
            {wrapped.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/bundles/${b.id}`}
                  className="card flex items-center justify-between gap-3 transition hover:border-indigo-300"
                >
                  <span className="flex items-center gap-2.5">
                    <span>
                      <span className="block truncate text-sm font-semibold">{truncated(b.name, 60)}</span>
                      <span className="block text-xs text-slate-400">
                        {b.item_count} items · created {b.created_at.slice(0, 10)} ·{" "}
                        <span className="font-medium text-slate-500">{b.status}</span>
                      </span>
                    </span>
                  </span>
                  <span className="text-sm">
                    <span className="font-bold text-emerald-700">
                      {centsToUsd(
                        b.listing_price_cents ?? bundlePriceCents(b.total_value_cents),
                      )}
                    </span>
                    <span className="ml-1 text-xs text-slate-400">
                      {b.listingLabel ? `${b.listingLabel} · ` : ""}
                      {centsToUsd(b.total_value_cents)} value
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="lg:col-span-2">
        <h1 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Bundle builder</h1>
        <BundleBuilder />
      </div>
    </div>
  );
}