// radio-browser.info — community-maintained directory of free internet radio
// stations. Round-robin DNS gives multiple mirrors; we pick one at runtime.

import type { RadioStation } from '@shared/types';
import { NEWAMP_USER_AGENT } from '@shared/app-version';

const HOSTS = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://fr1.api.radio-browser.info',
];

// Fisher-Yates so every host still gets an even share of traffic across
// calls (preserving the original single-pickHost() load-balancing intent),
// but a request tries ALL of them before giving up instead of just one.
function shuffledHosts(): string[] {
  const hosts = [...HOSTS];
  for (let i = hosts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [hosts[i], hosts[j]] = [hosts[j]!, hosts[i]!];
  }
  return hosts;
}

const COMMON: RequestInit = {
  headers: { 'User-Agent': NEWAMP_USER_AGENT },
};

const REQUEST_TIMEOUT_MS = 8000;

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  // Fallback for a runtime without AbortSignal.any.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  a.addEventListener('abort', onAbort);
  b.addEventListener('abort', onAbort);
  return controller.signal;
}

/**
 * Fetches `path` against each mirror in a random order, with a per-attempt
 * timeout, until one succeeds. A random single mirror with no retry/fallback
 * and no timeout meant a down or hung mirror made radio search die silently
 * (the caller's own `!res.ok` check or catch never even got a chance to run
 * against a healthy host). Throws the last error once every mirror has
 * failed; re-throws immediately if the caller's own signal was the cause
 * (no point retrying a cancelled request against more hosts).
 */
async function fetchWithFailover(path: string, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown = null;
  for (const host of shuffledHosts()) {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${host}${path}`, { ...COMMON, signal: combineSignals(signal, timeoutSignal) });
      if (res.ok) return res;
      lastError = new Error(`Radio Browser ${res.status}`);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error('Radio Browser: all mirrors failed');
}

// The directory's own tag list is global and mostly not genres: Spanish-language
// tags, call signs, a station's own name ("moi merino"). The chips are this
// fixed set of common English genres instead; any other tag is still reachable
// by typing it into the search box (searchStationsByText).
export const CURATED_RADIO_TAGS = [
  'pop',
  'rock',
  'classic rock',
  'oldies',
  'jazz',
  'blues',
  'classical',
  'folk',
  'country',
  'hip-hop',
  'dance',
  'electronic',
  'ambient',
  'chillout',
  'lofi',
  'metal',
  'reggae',
  'news',
] as const;

type DirectoryStation = {
  stationuuid: string;
  name: string;
  url_resolved: string;
  homepage: string;
  favicon: string;
  country: string;
  language: string;
  tags: string;
  bitrate: number;
  codec: string;
};

function toStation(r: DirectoryStation): RadioStation {
  return {
    id: r.stationuuid,
    name: r.name,
    url: r.url_resolved,
    homepage: r.homepage,
    favicon: r.favicon,
    country: r.country,
    language: r.language,
    tags: r.tags,
    bitrate: r.bitrate,
    codec: r.codec,
  };
}

export async function searchStations(opts: {
  name?: string;
  tag?: string;
  /** Match the tag exactly instead of as a substring ("pop" would also catch "kpop"). */
  tagExact?: boolean;
  country?: string;
  limit?: number;
  order?: 'votes' | 'clickcount' | 'name';
  signal?: AbortSignal;
}): Promise<RadioStation[]> {
  const params = new URLSearchParams();
  if (opts.name) params.set('name', opts.name);
  if (opts.tag) params.set('tag', opts.tag);
  if (opts.tag && opts.tagExact) params.set('tagExact', 'true');
  if (opts.country) params.set('country', opts.country);
  params.set('limit', String(opts.limit ?? 80));
  params.set('order', opts.order ?? 'votes');
  params.set('reverse', 'true');
  params.set('hidebroken', 'true');

  const res = await fetchWithFailover(`/json/stations/search?${params.toString()}`, opts.signal);
  const arr = (await res.json()) as DirectoryStation[];
  return arr.map(toStation);
}

/**
 * Free-text search: stations whose name matches, interleaved with stations
 * carrying a matching tag, so "jazz" or "música regional" finds both. Fails
 * only when both lookups fail.
 */
export async function searchStationsByText(
  text: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<RadioStation[]> {
  const limit = opts.limit ?? 80;
  const [byName, byTag] = await Promise.allSettled([
    searchStations({ name: text, limit, signal: opts.signal }),
    searchStations({ tag: text, limit, signal: opts.signal }),
  ]);
  if (byName.status === 'rejected' && byTag.status === 'rejected') throw byName.reason;
  return interleaveStations(
    byName.status === 'fulfilled' ? byName.value : [],
    byTag.status === 'fulfilled' ? byTag.value : [],
    limit,
  );
}

export function interleaveStations(a: RadioStation[], b: RadioStation[], limit: number): RadioStation[] {
  const seen = new Set<string>();
  const out: RadioStation[] = [];
  for (let i = 0; out.length < limit && (i < a.length || i < b.length); i++) {
    for (const station of [a[i], b[i]]) {
      if (station && !seen.has(station.id) && out.length < limit) {
        seen.add(station.id);
        out.push(station);
      }
    }
  }
  return out;
}

export type TuneResult = { ok: true } | { ok: false; detail: string | null };

/**
 * Points `audio` at the station and resolves once playback has actually begun.
 * A failure carries a reason to show the user; `detail` is null when the
 * attempt was only cut short by another station or Stop.
 */
export async function tuneStation(
  audio: Pick<HTMLAudioElement, 'src' | 'play' | 'error'>,
  station: Pick<RadioStation, 'name' | 'url'>,
): Promise<TuneResult> {
  audio.src = station.url;
  try {
    await audio.play();
    return { ok: true };
  } catch (err) {
    const detail = playFailureDetail(station, err, audio.error?.code ?? null);
    if (detail) console.error('radio play failed', err);
    return { ok: false, detail };
  }
}

export function playFailureDetail(
  station: Pick<RadioStation, 'name' | 'url'>,
  err: unknown,
  mediaErrorCode: number | null,
): string | null {
  const reason = err instanceof Error ? err.name : '';
  if (reason === 'AbortError') return null;
  if (reason === 'NotAllowedError') return `${station.name}: playback was blocked, press play again.`;
  if (/\.m3u8(?:[?#]|$)/i.test(station.url)) return `${station.name} streams over HLS, which NewAmp can't play.`;
  // MediaError.MEDIA_ERR_NETWORK
  if (mediaErrorCode === 2) return `${station.name}: couldn't reach the stream.`;
  return `${station.name}: the stream is offline or in a format NewAmp can't play.`;
}

export async function topTags(limit = 30, signal?: AbortSignal): Promise<Array<{ name: string; stationcount: number }>> {
  try {
    const res = await fetchWithFailover(`/json/tags?order=stationcount&reverse=true&limit=${limit}`, signal);
    return (await res.json()) as Array<{ name: string; stationcount: number }>;
  } catch {
    return [];
  }
}

export async function clickStation(uuid: string): Promise<void> {
  // optional ping to inform popularity stats; ignore failures
  try {
    await fetchWithFailover(`/json/url/${uuid}`);
  } catch {
    /* ignore */
  }
}
