// LRCLIB.net — free, no-auth lyrics API with synced LRC support.
// Docs: https://lrclib.net/docs

import { NEWAMP_REPO_USER_AGENT } from '@shared/app-version';
import { localStorageSafe, setItemWithPrune } from '../lib/wiki.ts';

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
      headers: { 'User-Agent': NEWAMP_REPO_USER_AGENT },
    });
    if (res.ok) {
      const json = (await res.json()) as LrclibResult;
      writeCachedLyrics(cacheKey, json);
      return json;
    }
  } catch {
    /* fall through to search */
  }

  // fallback: search and return the most credible result
  try {
    const res = await fetch(
      `${BASE}/search?artist_name=${encodeURIComponent(opts.artist)}&track_name=${encodeURIComponent(opts.title)}`,
      { signal: opts.signal },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as LrclibResult[];
    const result = pickBestSearchResult(arr, opts);
    if (result) writeCachedLyrics(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

// The search endpoint has no exact-match guarantee (unlike /get), so arr[0]
// can be a same-titled but different song. Prefer a result that actually
// matches the track's duration or album — those two are the identity
// signals the caller already has — before falling back to the first hit.
// A wrong pick here used to get cached for CACHE_TTL_MS (30 days).
const DURATION_TOLERANCE_S = 3;
function pickBestSearchResult(
  arr: LrclibResult[],
  opts: { album?: string; duration?: number },
): LrclibResult | null {
  if (!arr.length) return null;
  if (opts.duration != null) {
    const durationMatch = arr.find(
      (r) => typeof r.duration === 'number' && Math.abs(r.duration - opts.duration!) <= DURATION_TOLERANCE_S,
    );
    if (durationMatch) return durationMatch;
  }
  if (opts.album) {
    const wantAlbum = normalizeCachePart(opts.album);
    const albumMatch = arr.find((r) => r.albumName && normalizeCachePart(r.albumName) === wantAlbum);
    if (albumMatch) return albumMatch;
  }
  return arr[0] ?? null;
}

export function lyricsCacheKey(opts: { artist: string; title: string; album?: string }): string {
  const identity = [opts.artist, opts.title, opts.album ?? ''].map(normalizeCachePart).join('|');
  return `${CACHE_PREFIX}${encodeURIComponent(identity)}`;
}

function normalizeCachePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function readCachedLyrics(key: string): LrclibResult | null {
  const storage = localStorageSafe();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cachedAt?: number; result?: LrclibResult };
    if (!parsed.cachedAt || Date.now() - parsed.cachedAt > CACHE_TTL_MS) {
      storage.removeItem(key);
      return null;
    }
    return parsed.result ?? null;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function writeCachedLyrics(key: string, result: LrclibResult): void {
  if (!hasLyricPayload(result)) return;
  const storage = localStorageSafe();
  if (!storage) return;
  setItemWithPrune(storage, key, JSON.stringify({ cachedAt: Date.now(), result }), CACHE_PREFIX, parseCachedAt);
}

function parseCachedAt(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { cachedAt?: number };
    return typeof parsed.cachedAt === 'number' ? parsed.cachedAt : null;
  } catch {
    return null;
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
