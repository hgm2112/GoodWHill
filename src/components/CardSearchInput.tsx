"use client";

import { useEffect, useRef, useState } from "react";

export interface CardResult {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  value_cents: number | null;
  image_url: string | null;
}

/** Debounced MTG card search with a result dropdown. */
export function CardSearchInput({
  onSelect,
  initialQuery,
}: {
  onSelect: (card: CardResult) => void;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [results, setResults] = useState<CardResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/scryfall/search?q=${encodeURIComponent(q)}`);
        const data: CardResult[] = await res.json();
        setResults(Array.isArray(data) ? data : []);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  function pick(card: CardResult) {
    setQuery(card.name);
    setOpen(false);
    onSelect(card);
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        className="input"
        placeholder="Type a Magic card name (e.g. Sol Ring)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
      />
      {loading && <p className="mt-1 text-xs text-slate-400">Searching Scryfall…</p>}
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-indigo-50"
                onClick={() => pick(c)}
              >
                {c.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.image_url} alt="" className="h-10 w-7 rounded-sm object-cover" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900">{c.name}</span>
                  <span className="block text-xs text-slate-500">
                    {c.set_name} · # {c.collector_number} · {c.rarity}
                  </span>
                </span>
                <span className="text-xs font-semibold text-emerald-700">
                  {c.value_cents ? `$${(c.value_cents / 100).toFixed(2)}` : "—"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}