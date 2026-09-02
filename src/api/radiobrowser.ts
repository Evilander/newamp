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

export async function searchStations(opts: {
  name?: string;
  tag?: string;
  country?: string;
  limit?: number;
  order?: 'votes' | 'clickcount' | 'name';
  signal?: AbortSignal;
}): Promise<RadioStation[]> {
  const params = new URLSearchParams();
  if (opts.name) params.set('name', opts.name);
  if (opts.tag) params.set('tag', opts.tag);
  if (opts.country) params.set('country', opts.country);
  params.set('limit', String(opts.limit ?? 80));
  params.set('order', opts.order ?? 'votes');
  params.set('reverse', 'true');
  params.set('hidebroken', 'true');

  const res = await fetchWithFailover(`/json/stations/search?${params.toString()}`, opts.signal);
  const arr = (await res.json()) as Array<{
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
  }>;
  return arr.map((r) => ({
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
  }));
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
