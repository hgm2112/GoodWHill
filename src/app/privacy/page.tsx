import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy · goodwhilly",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="card space-y-8">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Privacy Policy</h1>
          <p className="mt-1 text-sm text-slate-500">
            Effective: {new Date().getFullYear()} · goodwhilly (a personal inventory tool)
          </p>
        </div>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">What this app collects</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
            <li>Your login email address, used only for authentication (via Supabase).</li>
            <li>Inventory, sales, bundle, and listing data you enter or generate in the app.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">How your data is used</h2>
          <p className="text-sm text-slate-600">
            Data is used only to run this app for you. It is never sold or shared with third parties.
            Hosting is provided by Supabase. Price and listing lookups happen on demand and only send
            the specific values required for that request.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">Retention &amp; deletion</h2>
          <p className="text-sm text-slate-600">
            Your data is scoped to your account. To delete your account and all associated data,
            contact the app owner at the email you signed up with; we will remove your inventory,
            sales, bundles, and profile promptly.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">Contact</h2>
          <p className="text-sm text-slate-600">
            Questions about this policy? Reach out using the email address associated with your account.
          </p>
        </section>
      </div>
    </main>
  );
}