import {
  fetchWikipediaPages,
  localStorageSafe,
  normalizeForMatch,
  setItemWithPrune,
  type WikiPage,
  type WikiReachability,
} from '../lib/wiki.ts';

export interface AlbumFact {
  title: string;
  description: string | null;
  summary: string;
  url: string;
  imageUrl: string | null;
}

const ALBUM_FACT_CACHE_PREFIX = 'newamp:album-facts:v1:';
const ALBUM_FACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Shorter than the positive TTL — see the identical note in artistFacts.ts.
// A confirmed miss still avoids re-running the up-to-16-request serial
// lookup chain (plus its artist-fact fallback chain) on every replay.
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ALBUM_FACT_SEARCH_LIMIT = '6';

const ALBUM_TITLE_PATTERN = /\((?:album|ep|extended play|mixtape|soundtrack)\)/i;
const NON_ALBUM_TITLE_PATTERN = /\((?:song|single|film|novel|book|software|video game|television series|tv series|episode|company|species|animal|character|place|city|band|musician)\)/i;
const ALBUM_ENTITY_PATTERN = /\b(?:studio album|live album|compilation album|soundtrack album|debut album|album by|album from|extended play|ep|mixtape|record released|released on|released in|recorded at|recorded in|record label|label)\b/i;
const NON_ALBUM_ENTITY_PATTERN = /\b(?:film|novel|book|software|video game|television series|tv series|episode|species|animal|city|town|municipality|settlement|company|corporation|brand|sports team|football club|basketball team|baseball team)\b/i;
const NON_ALBUM_CREATIVE_WORK_PATTERN = /\b(?:song by|single by|film directed|novel by|book by|television episode)\b/i;

interface CachedAlbumFact {
  fetchedAt: number;
  /** null = confirmed "not found" (negative cache). */
  fact: AlbumFact | null;
}

export async function fetchAlbumFacts(
  album: string,
  artist: string,
  signal?: AbortSignal,
): Promise<AlbumFact | null> {
  const cleanAlbum = album.trim();
  const cleanArtist = artist.trim();
  if (isSkippableAlbumLookup(cleanAlbum)) return null;

  const cached = readCachedAlbumFact(cleanAlbum, cleanArtist);
  if (cached !== undefined) return cached;
  const reachability: WikiReachability = { reachedServer: false };

  for (const title of directTitleCandidates(cleanAlbum, cleanArtist)) {
    const candidates = await fetchWikiCandidates(reachability, {
      origin: '*',
      action: 'query',
      redirects: '1',
      titles: title,
      prop: 'extracts|pageimages|info|description',
      exintro: '1',
      explaintext: '1',
      inprop: 'url',
      piprop: 'thumbnail|original',
      pithumbsize: '900',
      format: 'json',
    }, signal);
    const fact = bestAlbumFact(cleanAlbum, cleanArtist, candidates);
    if (!fact) continue;
    writeCachedAlbumFact(cleanAlbum, cleanArtist, fact);
    return fact;
  }

  for (const lookupAlbum of lookupAlbumNames(cleanAlbum)) {
    const query = cleanArtist
      ? `"${lookupAlbum}" "${cleanArtist}" album OR "studio album" OR EP -film -song -single -novel -software`
      : `"${lookupAlbum}" album OR "studio album" OR EP -film -song -single -novel -software`;
    const candidates = await fetchWikiCandidates(reachability, {
      origin: '*',
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrlimit: ALBUM_FACT_SEARCH_LIMIT,
      prop: 'extracts|pageimages|info|description',
      exintro: '1',
      explaintext: '1',
      inprop: 'url',
      piprop: 'thumbnail|original',
      pithumbsize: '900',
      format: 'json',
    }, signal);
    const fact = bestAlbumFact(cleanAlbum, cleanArtist, candidates);
    if (!fact) continue;
    writeCachedAlbumFact(cleanAlbum, cleanArtist, fact);
    return fact;
  }

  // Every candidate exhausted — negative-cache the miss so the next lookup
  // for this album doesn't re-run the full serial chain (or the artist-fact
  // fallback chain NowPlayingView triggers on a null result) for nothing.
  // Only record a confirmed miss if Wikipedia actually answered. An outage,
  // a 5xx, or rate-limiting makes every candidate come back empty too, and
  // caching that as "no such album" would hide real data until the entry expires.
  if (reachability.reachedServer) writeCachedAlbumFact(cleanAlbum, cleanArtist, null);
  return null;
}

// undefined = no cache entry (caller should look up); null = a confirmed
// negative-cache hit; AlbumFact = a confirmed positive hit.
function readCachedAlbumFact(album: string, artist: string): AlbumFact | null | undefined {
  const storage = localStorageSafe();
  if (!storage) return undefined;
  const key = albumFactCacheKey(album, artist);
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as Partial<CachedAlbumFact>;
    if (!cached.fetchedAt) {
      storage.removeItem(key);
      return undefined;
    }
    const ttl = cached.fact ? ALBUM_FACT_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (Date.now() - cached.fetchedAt > ttl) {
      storage.removeItem(key);
      return undefined;
    }
    if (cached.fact == null) return null;
    if (!isAlbumFact(cached.fact) || !isLikelyAlbumFact(album, artist, cached.fact)) {
      storage.removeItem(key);
      return undefined;
    }
    return cached.fact;
  } catch {
    storage.removeItem(key);
    return undefined;
  }
}

function writeCachedAlbumFact(album: string, artist: string, fact: AlbumFact | null): void {
  const storage = localStorageSafe();
  if (!storage) return;
  setItemWithPrune(
    storage,
    albumFactCacheKey(album, artist),
    JSON.stringify({ fetchedAt: Date.now(), fact }),
    ALBUM_FACT_CACHE_PREFIX,
    parseFetchedAt,
  );
}

function parseFetchedAt(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: number };
    return typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : null;
  } catch {
    return null;
  }
}

function albumFactCacheKey(album: string, artist: string): string {
  return `${ALBUM_FACT_CACHE_PREFIX}${encodeURIComponent(album.trim().toLowerCase())}::${encodeURIComponent(artist.trim().toLowerCase())}`;
}


function isAlbumFact(value: unknown): value is AlbumFact {
  if (!value || typeof value !== 'object') return false;
  const fact = value as AlbumFact;
  return (
    typeof fact.title === 'string' &&
    typeof fact.summary === 'string' &&
    typeof fact.url === 'string' &&
    (typeof fact.description === 'string' || fact.description === null) &&
    (typeof fact.imageUrl === 'string' || fact.imageUrl === null)
  );
}

function isLikelyAlbumFact(album: string, artist: string, fact: AlbumFact): boolean {
  return scoreAlbumFact(album, artist, fact) >= 70;
}

function scoreAlbumFact(album: string, artist: string, fact: AlbumFact): number {
  const requestedAlbum = normalizeForMatch(album);
  if (!requestedAlbum) return 0;

  const title = normalizeForMatch(fact.title);
  const titleWithoutParenthetical = normalizeForMatch(fact.title.replace(/\s+\([^)]*\)\s*$/, ''));
  const haystack = normalizeForMatch(`${fact.title} ${fact.description ?? ''} ${fact.summary}`);
  const albumWords = requestedAlbum.split(/\s+/).filter((word) => word.length > 1);
  const albumWordSignal = albumWords.length > 0 && albumWords.every((word) => haystack.includes(word));
  const titleAlbumSignal = title === requestedAlbum ||
    titleWithoutParenthetical === requestedAlbum ||
    title.includes(requestedAlbum) ||
    albumWordSignal;
  if (!titleAlbumSignal) return 0;

  const artistSignals = lookupArtistNames(artist).map(normalizeForMatch).filter(Boolean);
  const artistMatch = artistSignals.length === 0 || artistSignals.some((name) => {
    if (haystack.includes(name)) return true;
    const significantWords = name.split(/\s+/).filter((word) => word.length > 2);
    return significantWords.length > 0 && significantWords.some((word) => haystack.includes(word));
  });

  const description = fact.description ?? '';
  const titleAlbum = ALBUM_TITLE_PATTERN.test(fact.title);
  const titleNonAlbum = NON_ALBUM_TITLE_PATTERN.test(fact.title);
  const descriptionAlbum = ALBUM_ENTITY_PATTERN.test(description);
  const summaryAlbum = ALBUM_ENTITY_PATTERN.test(fact.summary);
  const nonAlbumEntity = NON_ALBUM_ENTITY_PATTERN.test(description) || NON_ALBUM_ENTITY_PATTERN.test(fact.title);
  const nonAlbumCreative = NON_ALBUM_CREATIVE_WORK_PATTERN.test(description) || NON_ALBUM_CREATIVE_WORK_PATTERN.test(fact.summary);
  if ((titleNonAlbum || nonAlbumEntity || nonAlbumCreative) && !titleAlbum && !descriptionAlbum && !summaryAlbum) return 0;
  if (!titleAlbum && !descriptionAlbum && !summaryAlbum) return 0;
  if (artistSignals.length > 0 && !artistMatch) return 0;

  let score = 0;
  if (titleWithoutParenthetical === requestedAlbum || title === requestedAlbum) score += 25;
  else if (title.includes(requestedAlbum)) score += 15;
  else score += 8;

  if (titleAlbum) score += 70;
  if (descriptionAlbum) score += 55;
  else if (summaryAlbum) score += 50;
  if (artistMatch) score += artistSignals.length > 0 ? 35 : 10;

  if (titleNonAlbum) score -= 90;
  if (nonAlbumEntity) score -= 75;
  if (nonAlbumCreative) score -= 80;

  return score;
}

function bestAlbumFact(album: string, artist: string, facts: AlbumFact[]): AlbumFact | null {
  let best: { fact: AlbumFact; score: number } | null = null;
  for (const fact of facts) {
    const score = scoreAlbumFact(album, artist, fact);
    if (score < 70) continue;
    if (!best || score > best.score) best = { fact, score };
  }
  return best?.fact ?? null;
}

function isSkippableAlbumLookup(album: string): boolean {
  return !album || /^(unknown album|unknown|\[unknown\]|n\/a|none)$/i.test(album.trim());
}

function lookupAlbumNames(album: string): string[] {
  const names = [
    album,
    album.replace(/\s+\([^)]*\)\s*$/, ''),
  ];
  const seen = new Set<string>();
  return names
    .map((name) => name.replace(/\s+/g, ' ').trim())
    .filter((name) => {
      const key = normalizeForMatch(name);
      if (!key || seen.has(key) || isSkippableAlbumLookup(name)) return false;
      seen.add(key);
      return true;
    });
}

function lookupArtistNames(artist: string): string[] {
  const names = [
    artist,
    artist.replace(/\s+\([^)]*\)\s*$/, ''),
    artist.split(/\s+(?:feat\.?|featuring|ft\.?|with)\s+/i)[0] ?? artist,
    artist.split(/\s*[;|]\s*/)[0] ?? artist,
  ];
  const seen = new Set<string>();
  return names
    .map((name) => name.replace(/\s+/g, ' ').trim())
    .filter((name) => {
      const key = normalizeForMatch(name);
      if (!key || seen.has(key) || /^(unknown artist|unknown|various artists?|va|n\/a)$/i.test(name)) return false;
      seen.add(key);
      return true;
    });
}

function directTitleCandidates(album: string, artist: string): string[] {
  const titles: string[] = [];
  for (const albumName of lookupAlbumNames(album)) {
    for (const artistName of lookupArtistNames(artist)) {
      titles.push(`${albumName} (${artistName} album)`);
    }
    titles.push(`${albumName} (album)`, `${albumName} (EP)`, albumName);
  }
  return [...new Set(titles)];
}

async function fetchWikiCandidates(
  reachability: WikiReachability,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<AlbumFact[]> {
  return fetchWikipediaPages(query, pageToAlbumFact, signal, 'wiki album', reachability);
}

function pageToAlbumFact(page: WikiPage): AlbumFact | null {
  if (!page?.extract || !page.title || !page.fullurl) return null;
  return {
    title: page.title,
    description: page.description?.replace(/\s+/g, ' ').trim() ?? null,
    summary: page.extract.replace(/\s+/g, ' ').trim().slice(0, 900),
    url: page.fullurl,
    imageUrl: page.thumbnail?.source ?? page.original?.source ?? null,
  };
}
