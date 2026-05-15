// LRCLIB.net — free, no-auth lyrics API with synced LRC support.
// Docs: https://lrclib.net/docs

const BASE = 'https://lrclib.net/api';
const CACHE_PREFIX = 'newamp:lyrics:v1:';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export interface LrclibResult {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export async function fetchLyrics(opts: {
  artist: string;
  title: string;
  album?: string;
  duration?: number;
  signal?: AbortSignal;
}): Promise<LrclibResult | null> {
  const cacheKey = lyricsCacheKey(opts);
  const cached = readCachedLyrics(cacheKey);
  if (cached) return cached;

  const q = new URLSearchParams();
  q.set('artist_name', opts.artist);
  q.set('track_name', opts.title);
  if (opts.album) q.set('album_name', opts.album);
  if (opts.duration) q.set('duration', String(Math.round(opts.duration)));

  // try the exact-match endpoint first
  try {
    const res = await fetch(`${BASE}/get?${q.toString()}`, {
      signal: opts.signal,
      headers: { 'User-Agent': 'Newamp/1.0.0 (https://github.com/evilander)' },
    });
    if (res.ok) {
      const json = (await res.json()) as LrclibResult;
      writeCachedLyrics(cacheKey, json);
      return json;
    }
  } catch {
    /* fall through to search */
  }

  // fallback: search and return the first credible result
  try {
    const res = await fetch(
      `${BASE}/search?artist_name=${encodeURIComponent(opts.artist)}&track_name=${encodeURIComponent(opts.title)}`,
      { signal: opts.signal },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as LrclibResult[];
    const result = arr[0] ?? null;
    if (result) writeCachedLyrics(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

export function lyricsCacheKey(opts: { artist: string; title: string; album?: string }): string {
  const identity = [opts.artist, opts.title, opts.album ?? ''].map(normalizeCachePart).join('|');
  return `${CACHE_PREFIX}${encodeURIComponent(identity)}`;
}

function normalizeCachePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function readCachedLyrics(key: string): LrclibResult | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cachedAt?: number; result?: LrclibResult };
    if (!parsed.cachedAt || Date.now() - parsed.cachedAt > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.result ?? null;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function writeCachedLyrics(key: string, result: LrclibResult): void {
  if (typeof localStorage === 'undefined' || !hasLyricPayload(result)) return;
  try {
    localStorage.setItem(key, JSON.stringify({ cachedAt: Date.now(), result }));
  } catch {
    /* storage can be full or blocked; lyrics still render from the network response */
  }
}

function hasLyricPayload(result: LrclibResult): boolean {
  return !!(result.syncedLyrics || result.plainLyrics || result.instrumental);
}

export interface LrcLine {
  time: number;
  text: string;
}

export function parseLrc(synced: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const line of synced.split(/\r?\n/)) {
    const m = line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g);
    const stamps: number[] = [];
    for (const match of m) {
      const min = parseInt(match[1] ?? '0', 10);
      const sec = parseInt(match[2] ?? '0', 10);
      const frac = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) / 1000 : 0;
      stamps.push(min * 60 + sec + frac);
    }
    if (!stamps.length) continue;
    const text = line.replace(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g, '').trim();
    for (const t of stamps) out.push({ time: t, text });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
