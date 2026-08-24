import { NEWAMP_REPO_USER_AGENT } from '../../shared/app-version.ts';

export function wikipediaSearchUrl(query: string): string {
  const clean = query.replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({ search: clean || 'music' });
  return `https://en.wikipedia.org/w/index.php?${params.toString()}`;
}

export function musicEntitySearchText(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

/**
 * Wikipedia MediaWiki API endpoint. Singular module-level constant so album +
 * artist fact lookups share the same URL and any future change (mirror, locale
 * switch, version bump) lands in one place.
 */
const WIKI_API_URL = 'https://en.wikipedia.org/w/api.php';

/** Wikipedia page object as returned by the prop=extracts+pageimages query. */
export interface WikiPage {
  title?: string;
  description?: string;
  extract?: string;
  fullurl?: string;
  thumbnail?: { source?: string };
  original?: { source?: string };
}

export interface WikiResponse {
  query?: {
    pages?: Record<string, WikiPage>;
  };
}

/**
 * Fetch Wikipedia pages, parse the response, and map each page to the caller's
 * domain shape. Errors are swallowed and surfaced via console.warn so the
 * caller's fallback chain (multiple disambiguators) stays alive on one bad
 * lookup, but real degradation is still visible in DevTools.
 *
 * AbortError is re-thrown so React effects' AbortController cleanup works.
 */
export async function fetchWikipediaPages<T>(
  query: Record<string, string>,
  mapPage: (page: WikiPage) => T | null,
  signal?: AbortSignal,
  context = 'wiki',
): Promise<T[]> {
  const params = new URLSearchParams(query);
  try {
    const res = await fetch(`${WIKI_API_URL}?${params}`, {
      signal,
      headers: { 'Api-User-Agent': NEWAMP_REPO_USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`[newamp] ${context} lookup non-ok status`, res.status, params.toString().slice(0, 200));
      return [];
    }
    const data = (await res.json()) as WikiResponse;
    return Object.values(data.query?.pages ?? {})
      .map(mapPage)
      .filter((value): value is T => value != null);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    console.warn(`[newamp] ${context} lookup failed`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Browser/Electron-safe `localStorage` accessor. Returns null when access is
 * blocked (private browsing modes, quota exceeded, sandboxed iframes).
 */
export function localStorageSafe(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Best-effort localStorage write with quota-exceeded recovery, shared by the
 * lyrics/album-fact/artist-fact caches. Each of those caches wrapped
 * setItem in a try/catch with an empty catch body — once localStorage fills
 * up (no size accounting, LRU, or periodic prune anywhere), every future
 * write across all three silently failed forever with zero diagnostics.
 * This prunes the oldest entries under `prefix` (read via `parseTimestamp`,
 * which decodes each cache's own JSON envelope) and retries once before
 * giving up — bounding growth instead of just going permanently dark.
 */
export function setItemWithPrune(
  storage: Storage,
  key: string,
  value: string,
  prefix: string,
  parseTimestamp: (raw: string) => number | null,
  pruneCount = 20,
): void {
  try {
    storage.setItem(key, value);
    return;
  } catch {
    /* fall through to prune + retry */
  }
  try {
    const entries: { key: string; ts: number }[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const raw = storage.getItem(k);
      if (!raw) continue;
      const ts = parseTimestamp(raw);
      if (ts != null) entries.push({ key: k, ts });
    }
    entries.sort((a, b) => a.ts - b.ts);
    for (const entry of entries.slice(0, pruneCount)) storage.removeItem(entry.key);
    storage.setItem(key, value);
  } catch {
    /* still failing after pruning — give up silently, matching the existing best-effort contract */
  }
}

/**
 * Normalize a metadata string for fuzzy match comparison.
 *   - Strip diacritics
 *   - Lowercase
 *   - "&" → " and "
 *   - Drop apostrophes
 *   - Collapse non-alphanumeric to single spaces
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['`‘’ʼ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
