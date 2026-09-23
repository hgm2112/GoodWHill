"use client";

import { useEffect, useState } from "react";

interface EbayStatus {
  configured: boolean;
  connected: boolean;
  env: "prod" | "sandbox";
  connectedAt: string | null;
  lastUpdated: string | null;
}

export function SettingsClient({ email }: { email: string }) {
  const [status, setStatus] = useState<EbayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/ebay/status");
      if (res.ok) setStatus(await res.json());
    } catch {
      setError("Couldn't read eBay status");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function connect() {
    setError(null);
    const res = await fetch("/api/ebay/connect", { redirect: "manual" });
    if (res.type === "opaqueredirect") {
      window.location.href = res.headers.get("location") ?? "";
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error ?? "Couldn't start the eBay login");
      return;
    }
    window.location.href = data.url;
  }

  async function disconnect() {
    if (!window.confirm("Unlink your eBay account? Listings stay saved; new syncs will stop.")) return;
    await fetch("/api/ebay/disconnect", { method: "POST" });
    load();
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* eBay */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">eBay connection</h2>
          <span
            className={`h-2.5 w-2.5 rounded-full ${status?.connected ? "bg-emerald-500" : status?.configured ? "bg-amber-400" : "bg-slate-300"}`}
            title={status?.connected ? "Connected" : status?.configured ? "Configured, not connected" : "Not configured"}
          />
        </div>

        {!status ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              {status.connected
                ? `Connected ${new Date(status.connectedAt!).toLocaleDateString()}.`
                : status.configured
                  ? "Server keys are set but no account is linked yet."
                  : "eBay isn't configured on the server (no EBAY_CLIENT_ID/SECRET/RUNAME). Price autofill and listing sync are disabled."}
            </p>
            {status.lastUpdated && (
              <p className="text-xs text-slate-400">Token last refreshed {status.lastUpdated.slice(0, 16).replace("T", " ")} UTC</p>
            )}
            <p className="text-xs text-slate-400">
              Environment: <span className="font-semibold">{status.env}</span>. Uses your own eBay
              account (OAuth + user token). Your access keys are encrypted on the server.
            </p>

            {status.connected ? (
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-ghost text-red-600" onClick={disconnect}>
                  Disconnect
                </button>
              </div>
            ) : (
              <button className="btn btn-primary" onClick={connect}>
                Connect eBay account
              </button>
            )}
          </>
        )}

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>

      {/* Pricing notes */}
      <div className="card space-y-2">
        <h2 className="text-sm font-bold">How prices are found</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>
            <span className="font-semibold">Sealed product:</span> eBay sold-data average when the
            Marketplace Insights API access is approved, otherwise an estimate from active-listing
            prices for the exact UPC. Results are cached with a sample count.
          </li>
          <li>
            <span className="font-semibold">Bulk loose cards:</span> Scryfall market price for the
            exact card.
          </li>
          <li>
            <span className="font-semibold">Everything else:</span> your own value, typed in. Values
            drive bundle generation.
          </li>
        </ul>
      </div>

      {/* Account */}
      <div className="card space-y-2 md:col-span-2">
        <h2 className="text-sm font-bold">Account</h2>
        <p className="text-sm text-slate-600">
          Signed in as <span className="font-medium text-slate-800">{email}</span>. Inventory, sales,
          listings, and bundles are scoped to your account only.
        </p>
        <p className="text-xs text-slate-400">
          For a password reset or to change the email use the &quot;Reset password&quot; link on the
          login screen.
        </p>
      </div>
    </div>
  );
}