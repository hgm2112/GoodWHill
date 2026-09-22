import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GoodWHill — eBay inventory & bundles",
  description:
    "Track MTG sealed product and bulk inventory, scan barcodes, view your eBay listings, and generate random value bundles.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}