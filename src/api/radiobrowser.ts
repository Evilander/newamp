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

function pickHost(): string {
  return HOSTS[Math.floor(Math.random() * HOSTS.length)]!;
}

const COMMON: RequestInit = {
  headers: { 'User-Agent': NEWAMP_USER_AGENT },
};

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

  const host = pickHost();
  const url = `${host}/json/stations/search?${params.toString()}`;
  const res = await fetch(url, { ...COMMON, signal: opts.signal });
  if (!res.ok) throw new Error(`Radio Browser ${res.status}`);
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
  const host = pickHost();
  const res = await fetch(`${host}/json/tags?order=stationcount&reverse=true&limit=${limit}`, {
    ...COMMON,
    signal,
  });
  if (!res.ok) return [];
  return (await res.json()) as Array<{ name: string; stationcount: number }>;
}

export async function clickStation(uuid: string): Promise<void> {
  // optional ping to inform popularity stats; ignore failures
  try {
    await fetch(`${pickHost()}/json/url/${uuid}`, COMMON);
  } catch {
    /* ignore */
  }
}
