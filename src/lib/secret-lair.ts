/**
 * Release-date lookup for Secret Lair drops via mtg.wiki.
 *
 * Scryfall has no per-drop sets (all drops share `sld`, dated 2019), and
 * eBay listings carry no release-date aspect — mtg.wiki documents each
 * superdrop with an infobox date instead. A drop is only trusted when its
 * name appears VERBATIM on a drop-listing page (title gated to
 * "Superdrop|Drop Series|Commander Deck" — feature pages like "Secret
 * Lair/Chaos Vault" are rejected), so a fuzzy title match can never stamp a
 * wrong date on an item. Returns null (→ stays blank) rather than guessing.
 * Never throws.
 */

const WIKI = "https://mtg.wiki/api.php";
const UA = "goodwhilly/1.0 (inventory app release date lookup)";
const TTL_MS = 6 * 60 * 60 * 1000;
const SLEEP_MS = 50;

export interface SecretLairDate {
  date: string | null;
  pageTitle: string;
  viaPhrase: string;
}

const pageCache = new Map<string, { text: string | null; fetchedAt: number }>();
const phraseCache = new Map<string, { result: SecretLairDate | null; fetchedAt: number }>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TITLE_GATE = /superdrop|drop series|commander deck/i;
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

async function wikiJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function searchTitles(phrase: string): Promise<string[]> {
  const q = `"${phrase}" intitle:"Secret Lair"`;
  const json = await wikiJson(
    `${WIKI}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=8&srprop=score&format=json`,
  );
  await sleep(SLEEP_MS);
  const query = json?.query as { search?: { title?: unknown }[] } | undefined;
  return (query?.search ?? [])
    .map((s) => String(s.title ?? ""))
    .filter(
      (t) =>
        t &&
        /secret lair/i.test(t) &&
        TITLE_GATE.test(t) &&
        // "Secret Lair/Drop Series" (index hub) and "…/Chaos Vault" style
        // subpages list every drop with their own unrelated date — never
        // drop-listing pages. Real superdrop subpages keep the full
        // "Secret Lair Drop Series: …/…" title and still pass.
        !/^secret lair\//i.test(t),
    );
}

async function getWikitext(title: string): Promise<string | null> {
  const hit = pageCache.get(title);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.text;
  const json = await wikiJson(
    `${WIKI}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`,
  );
  await sleep(SLEEP_MS);
  const parse = json?.parse as { wikitext?: { "*"?: unknown } } | undefined;
  const text = typeof parse?.wikitext?.["*"] === "string" ? (parse.wikitext["*"] as string) : null;
  pageCache.set(title, { text, fetchedAt: Date.now() });
  return text;
}

/** |release = {{start date and age|Y|M|D}} / |release = Month D, YYYY / ISO. */
function extractDate(wikitext: string): string | null {
  let m = /\|\s*(release|released|release_date|date)\s*=\s*\{\{\s*start date(?: and age)?\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i.exec(
    wikitext,
  );
  if (m) {
    return `${m[2]}-${String(m[3]).padStart(2, "0")}-${String(m[4]).padStart(2, "0")}`;
  }
  m = /\|\s*(release|released|release_date|date)\s*=\s*([^\n|}]+)/i.exec(wikitext);
  if (m) {
    const value = m[2].trim();
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (iso) return iso[1];
    const plain = /^([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})$/.exec(value);
    if (plain) {
      const month = MONTHS.indexOf(plain[1].toLowerCase());
      if (month >= 0) {
        return `${plain[3]}-${String(month + 1).padStart(2, "0")}-${String(plain[2]).padStart(2, "0")}`;
      }
    }
  }
  return null;
}

function subtitleOf(itemName: string): string | null {
  const colon = itemName.indexOf(":");
  const sub = colon >= 0 ? itemName.slice(colon + 1).trim() : itemName.replace(/^secret lair x?\s*/i, "").trim();
  return sub || null;
}

/** Full subtitle first, then suffixes (drops are often listed by partial name). */
function phrasesOf(subtitle: string): string[] {
  const out = [subtitle];
  const toks = subtitle.split(/\s+/).filter(Boolean);
  for (const n of [3, 2]) {
    if (toks.length > n) {
      const suffix = toks.slice(-n).join(" ");
      if (!out.includes(suffix)) out.push(suffix);
    }
  }
  return out;
}

/**
 * A drop can legitimately appear on several pages (its superdrop, a
 * commander-deck subpage…). Accept only when every owning page agrees on
 * ONE date; competing dates (e.g. "Command Tower" is reprinted across many
 * superdrops) → blank rather than guess.
 */
async function resolvePhrase(phrase: string): Promise<SecretLairDate | null> {
  const titles = await searchTitles(phrase);
  if (!titles.length) return null;
  const re = new RegExp(escapeRe(phrase), "i");
  const byDate = new Map<string, string>(); // date → first owning page
  for (const title of titles) {
    const text = await getWikitext(title);
    if (!text || !re.test(text)) continue;
    const date = extractDate(text);
    if (date && !byDate.has(date)) byDate.set(date, title);
  }
  if (byDate.size !== 1) return null; // 0 dates, or competing dates
  const [date, pageTitle] = [...byDate.entries()][0];
  return { date, pageTitle, viaPhrase: phrase };
}

/**
 * Best-effort release date for ONE Secret Lair product. `itemName` is the
 * full inventory name ("Secret Lair x The Office: Dwight's Destiny").
 * 6h caches: page wikitext by title, phrase results by phrase (including
 * negative hits) — a bulk fill reuses each superdrop page for every drop in
 * it.
 */
export async function lookupSecretLairDate(itemName: string): Promise<SecretLairDate | null> {
  try {
    const subtitle = subtitleOf(itemName.trim());
    if (!subtitle) return null;
    for (const phrase of phrasesOf(subtitle)) {
      const cached = phraseCache.get(phrase);
      if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
        if (cached.result) return cached.result;
        continue;
      }
      const result = await resolvePhrase(phrase);
      phraseCache.set(phrase, { result, fetchedAt: Date.now() });
      if (result) return result;
    }
    return null;
  } catch {
    return null;
  }
}
