/**
 * Upcoming product releases for the dashboard: MTG (incl. Secret Lair drops)
 * and Pokémon, merged into one chronological list.
 *
 * Sources (no API keys, no new deps):
 *   - MTG: mtg.wiki `Category:Upcoming releases` via the MediaWiki API —
 *     the category tracks announced sets/Secret Lair drops before Scryfall
 *     indexes them. Keeps `Infobox set` pages (drops books/films/comics and
 *     `/Commander` subpages); pages without an infobox release date are shown
 *     as TBA (most Secret Lair drops announce late).
 *   - Pokémon: the official press site's product schedule table
 *     (press.pokemon.com), parsed with a regex over the static HTML.
 *
 * Results are cached in-memory for 6h (module-level, like the eBay app
 * token). Each source is fetched independently in try/catch so one failure
 * still returns the other's rows; failures are reported as `errors[]`.
 */

export interface UpcomingRelease {
  name: string;
  /** "MTG" | "Secret Lair" | "Pokémon" — display badge. */
  label: string;
  game: "mtg" | "pokemon";
  /** `YYYY-MM-DD`, or null when the release date is still TBA. */
  date: string | null;
  url: string | null;
}

export interface ReleasesResult {
  releases: UpcomingRelease[];
  /** One message per source that failed; empty when everything loaded. */
  errors: string[];
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_RETRY_MS = 5 * 60 * 1000;
let cached: { at: number; ttl: number; result: ReleasesResult } | null = null;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Decode the few HTML entities that show up in titles (&#233;, &amp;, …). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

async function fetchText(url: string, userAgent: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "*/*" },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** MTG upcoming releases (incl. Secret Lair) from mtg.wiki's Upcoming category. */
async function fetchMtgReleases(today: string): Promise<UpcomingRelease[]> {
  const url =
    "https://mtg.wiki/api.php?action=query" +
    "&generator=categorymembers&gcmtitle=Category:Upcoming_releases&gcmtype=page&gcmlimit=50" +
    "&prop=revisions|info&inprop=url&rvprop=content&rvslots=main&format=json";
  const body = await fetchText(url, "goodwhilly/1.0 (inventory app release calendar)");
  const json = JSON.parse(body) as {
    query?: { pages?: Record<string, Record<string, unknown>> };
  };
  const pages = Object.values(json.query?.pages ?? {});

  const out: UpcomingRelease[] = [];
  for (const page of pages) {
    const title = String(page.title ?? "").trim();
    if (!title || title.includes("/")) continue; // skip /Commander etc. subpages
    const revisions = page.revisions as Array<{ slots?: { main?: { "*": string } } }> | undefined;
    const wikitext = revisions?.[0]?.slots?.main?.["*"] ?? "";
    if (!/\{\{\s*Infobox set\b/i.test(wikitext)) continue; // books/films/etc.

    // |release = {{start date and age|2026|10|2}} — the standard infobox date.
    let date: string | null = null;
    const iso = /\|\s*release\s*=\s*\{\{\s*start date and age\|(\d{4})\|(\d{1,2})\|(\d{1,2})/i.exec(
      wikitext,
    );
    if (iso) {
      date = `${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`;
    } else {
      // Fallback: a plain-text release value ("October 2, 2026").
      const plain = /\|\s*release\s*=\s*([^\n|}]+)/i.exec(wikitext);
      if (plain) {
        const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(plain[1].trim());
        if (m) {
          const month = MONTHS.findIndex((name) => name.toLowerCase() === m[1].toLowerCase());
          if (month >= 0) date = `${m[3]}-${pad(month + 1)}-${pad(Number(m[2]))}`;
        }
      }
    }

    if (date && date < today) continue; // already released
    const fullurl = typeof page.fullurl === "string" ? page.fullurl : null;
    out.push({
      name: title,
      label: /^Secret Lair/i.test(title) ? "Secret Lair" : "MTG",
      game: "mtg",
      date,
      url: fullurl ?? `https://mtg.wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    });
  }
  return out;
}

/** Future Pokémon TCG products from the official press-site schedule table. */
async function fetchPokemonReleases(today: string): Promise<UpcomingRelease[]> {
  const html = await fetchText(
    "https://press.pokemon.com/en/Items/Schedule?period=All&types=3",
    "Mozilla/5.0 (goodwhilly release calendar)",
  );

  const rowRe =
    /<a class="prod-name" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<td class="td-date">\s*([\s\S]*?)\s*<\/td>/g;
  const out: UpcomingRelease[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const name = decodeEntities(m[2].replace(/<[^>]+>/g, "").trim());
    const rawDate = decodeEntities(m[3].replace(/<[^>]+>/g, "").trim());
    if (!name) continue;
    const dm = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(rawDate);
    let date: string | null = null;
    if (dm) {
      const month = MONTHS.findIndex((name2) => name2.toLowerCase() === dm[1].toLowerCase());
      if (month >= 0) date = `${dm[3]}-${pad(month + 1)}-${pad(Number(dm[2]))}`;
    }
    if (date && date < today) continue; // already released
    const href = m[1];
    out.push({
      name,
      label: "Pokémon",
      game: "pokemon",
      date,
      url: href.startsWith("http") ? href : `https://press.pokemon.com${href}`,
    });
  }
  return out;
}

/** Dated releases ascending first, TBA last (stable by name within a bucket). */
function byDate(a: UpcomingRelease, b: UpcomingRelease): number {
  if (a.date && b.date) return a.date.localeCompare(b.date) || a.name.localeCompare(b.name);
  if (a.date) return -1;
  if (b.date) return 1;
  return a.name.localeCompare(b.name);
}

/** Merged MTG + Pokémon future releases, cached for 6h. Never throws. */
export async function fetchUpcomingReleases(): Promise<ReleasesResult> {
  if (cached && Date.now() - cached.at < cached.ttl) return cached.result;

  const today = todayDateOnly();
  const [mtg, pokemon] = await Promise.all([
    fetchMtgReleases(today).then(
      (releases) => ({ releases, error: null as string | null }),
      (err: unknown) => ({
        releases: [] as UpcomingRelease[],
        error: `MTG releases failed: ${err instanceof Error ? err.message : "unknown error"}`,
      }),
    ),
    fetchPokemonReleases(today).then(
      (releases) => ({ releases, error: null as string | null }),
      (err: unknown) => ({
        releases: [] as UpcomingRelease[],
        error: `Pokémon releases failed: ${err instanceof Error ? err.message : "unknown error"}`,
      }),
    ),
  ]);

  const errors = [mtg.error, pokemon.error].filter((e): e is string => Boolean(e));
  const result: ReleasesResult = {
    releases: [...mtg.releases, ...pokemon.releases].sort(byDate),
    errors,
  };
  // A hit caches for 6h; an empty result (outage/blip) retries in 5 min.
  cached = {
    at: Date.now(),
    ttl: result.releases.length > 0 ? CACHE_TTL_MS : EMPTY_RETRY_MS,
    result,
  };
  return result;
}
