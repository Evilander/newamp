export interface ArtistFact {
  title: string;
  description: string | null;
  summary: string;
  url: string;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  originalImageUrl: string | null;
}

const ARTIST_FACT_CACHE_PREFIX = 'newamp:artist-facts:v1:';
const ARTIST_FACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedArtistFact {
  fetchedAt: number;
  fact: ArtistFact;
}

interface WikiPage {
  title?: string;
  description?: string;
  extract?: string;
  fullurl?: string;
  thumbnail?: { source?: string };
  original?: { source?: string };
}

interface WikiResponse {
  query?: {
    pages?: Record<string, WikiPage>;
  };
}

export async function fetchArtistFacts(
  artist: string,
  signal?: AbortSignal,
): Promise<ArtistFact | null> {
  const cached = readCachedArtistFact(artist);
  if (cached) return cached;

  const direct = await fetchWiki({
    origin: '*',
    action: 'query',
    redirects: '1',
    titles: artist,
    prop: 'extracts|pageimages|info|description',
    exintro: '1',
    explaintext: '1',
    inprop: 'url',
    piprop: 'thumbnail|original',
    pithumbsize: '900',
    format: 'json',
  }, signal);
  if (direct) {
    writeCachedArtistFact(artist, direct);
    return direct;
  }

  const q = `${artist} band OR singer OR musician`;
  const fallback = await fetchWiki({
    origin: '*',
    action: 'query',
    generator: 'search',
    gsrsearch: q,
    gsrlimit: '1',
    prop: 'extracts|pageimages|info|description',
    exintro: '1',
    explaintext: '1',
    inprop: 'url',
    piprop: 'thumbnail|original',
    pithumbsize: '900',
    format: 'json',
  }, signal);
  if (fallback) writeCachedArtistFact(artist, fallback);
  return fallback;
}

function readCachedArtistFact(artist: string): ArtistFact | null {
  const storage = localStorageSafe();
  if (!storage) return null;
  const key = artistFactCacheKey(artist);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as Partial<CachedArtistFact>;
    if (!cached.fetchedAt || !cached.fact || Date.now() - cached.fetchedAt > ARTIST_FACT_CACHE_TTL_MS) {
      storage.removeItem(key);
      return null;
    }
    return isArtistFact(cached.fact) ? cached.fact : null;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function writeCachedArtistFact(artist: string, fact: ArtistFact): void {
  const storage = localStorageSafe();
  if (!storage) return;
  try {
    storage.setItem(artistFactCacheKey(artist), JSON.stringify({ fetchedAt: Date.now(), fact }));
  } catch {
    /* ignore quota or privacy-mode failures */
  }
}

function artistFactCacheKey(artist: string): string {
  return `${ARTIST_FACT_CACHE_PREFIX}${encodeURIComponent(artist.trim().toLowerCase())}`;
}

function localStorageSafe(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isArtistFact(value: unknown): value is ArtistFact {
  if (!value || typeof value !== 'object') return false;
  const fact = value as ArtistFact;
  return (
    typeof fact.title === 'string' &&
    typeof fact.summary === 'string' &&
    typeof fact.url === 'string' &&
    (typeof fact.description === 'string' || fact.description === null) &&
    (typeof fact.imageUrl === 'string' || fact.imageUrl === null) &&
    (typeof fact.thumbnailUrl === 'string' || fact.thumbnailUrl === null) &&
    (typeof fact.originalImageUrl === 'string' || fact.originalImageUrl === null)
  );
}

async function fetchWiki(
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<ArtistFact | null> {
  const params = new URLSearchParams({
    ...query,
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { signal });
  if (!res.ok) return null;
  const data = (await res.json()) as WikiResponse;
  const page = Object.values(data.query?.pages ?? {})[0];
  if (!page?.extract || !page.title || !page.fullurl) return null;
  return {
    title: page.title,
    description: page.description?.replace(/\s+/g, ' ').trim() ?? null,
    summary: page.extract.replace(/\s+/g, ' ').trim().slice(0, 560),
    url: page.fullurl,
    imageUrl: page.thumbnail?.source ?? page.original?.source ?? null,
    thumbnailUrl: page.thumbnail?.source ?? null,
    originalImageUrl: page.original?.source ?? null,
  };
}
