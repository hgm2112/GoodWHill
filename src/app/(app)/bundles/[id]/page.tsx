import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BundleDetailClient } from "@/components/BundleDetailClient";
import { centsToUsd, truncated } from "@/lib/utils";

export const metadata = { title: "Bundle · goodwhilly" };

export default async function BundleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase
    .from("bundles")
    .select("*, bundle_items(*, item:items(*))")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  // PGRST116 = no rows matched; anything else is a real failure, not a 404.
  if (error && error.code !== "PGRST116") throw error;
  if (!data) notFound();

  const normalized = {
    ...data,
    items: data.bundle_items ?? [],
  };

  const count = (data.bundle_items ?? []).reduce(
    (n: number, bi: { quantity: number }) => n + bi.quantity,
    0,
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{truncated(data.name, 60)}</h1>
        <span className="text-sm text-slate-400">
          {centsToUsd(data.total_value_cents)} value · {count} items
        </span>
      </div>
      <p className="text-xs text-slate-400">
        <Link href="/bundles" className="text-indigo-600 hover:underline">
          ← Back to bundles
        </Link>{" "}
        · stock for these items is currently reserved
      </p>
      <BundleDetailClient initial={normalized} />
    </div>
  );
}