import { fetchWikipediaPages, localStorageSafe, normalizeForMatch, type WikiPage } from '../lib/wiki.ts';
export interface ArtistFact {
  title: string;
  description: string | null;
  summary: string;
  url: string;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  originalImageUrl: string | null;
}

const ARTIST_FACT_CACHE_PREFIX = 'newamp:artist-facts:v3:';
const ARTIST_FACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ARTIST_FACT_SEARCH_LIMIT = '6';

const MUSIC_DISAMBIGUATORS = [
  'musician',
  'band',
  'singer',
  'singer-songwriter',
  'rapper',
  'composer',
  'record producer',
  'musical group',
  'musical project',
  'music producer',
  'producer',
  'DJ',
  'artist',
];


const MUSIC_TITLE_PATTERN = /\((?:musician|band|singer|singer-songwriter|rapper|composer|record producer|musical group|group|dj)\)/i;
const NON_MUSIC_TITLE_PATTERN = /\((?:album|song|single|film|novel|book|software|video game|television series|tv series|episode|company|species|animal|character|place)\)/i;
const MUSIC_ENTITY_PATTERN = /\b(?:musician|singer-songwriter|singer|songwriter|rapper|composer|record producer|music producer|recording artist|musical artist|disc jockey|dj|vocalist|guitarist|bassist|drummer|keyboardist|pianist|multi-instrumentalist|instrumentalist|rock band|pop band|jazz band|punk band|metal band|hip hop group|rap group|electronic music(?:ian| artist)?|musical group|music group|artist collective|band|duo|trio|choir|orchestra|ensemble|discography|albums?)\b/i;
const NON_MUSIC_ENTITY_PATTERN = /\b(?:species|subspecies|genus|family of|mammal|reptile|bird|fish|plant|insect|bear species|carnivoran|ursidae|ailuropoda|city|town|village|municipality|settlement|census-designated place|software|company|corporation|brand|video game|web browser|programming language|film|television series|tv series|episode|novel|book|fictional character|comic|manga|anime|sports team|football club|basketball team|baseball team)\b/i;
const CREATIVE_WORK_DESCRIPTION_PATTERN = /\b(?:studio album|live album|compilation album|soundtrack album|album by|song by|single by|extended play|ep by|film directed|novel by|book by)\b/i;

interface CachedArtistFact {
  fetchedAt: number;
  fact: ArtistFact;
}

export async function fetchArtistFacts(
  artist: string,
  signal?: AbortSignal,
): Promise<ArtistFact | null> {
  const cleanArtist = artist.trim();
  if (isSkippableArtistLookup(cleanArtist)) return null;
  const cached = readCachedArtistFact(cleanArtist);
  if (cached) return cached;

  for (const title of directTitleCandidates(cleanArtist)) {
    const direct = await fetchWikiCandidates({
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
    const directFact = bestMusicArtistFact(cleanArtist, direct);
    if (!directFact) continue;
    writeCachedArtistFact(cleanArtist, directFact);
    return directFact;
  }

  for (const lookupName of lookupArtistNames(cleanArtist)) {
    const q = `"${lookupName}" musician OR band OR singer OR rapper OR composer OR "record producer" OR "musical artist" -species -animal -film -novel -software`;
    const fallback = await fetchWikiCandidates({
      origin: '*',
      action: 'query',
      generator: 'search',
      gsrsearch: q,
      gsrlimit: ARTIST_FACT_SEARCH_LIMIT,
      prop: 'extracts|pageimages|info|description',
      exintro: '1',
      explaintext: '1',
      inprop: 'url',
      piprop: 'thumbnail|original',
      pithumbsize: '900',
      format: 'json',
    }, signal);
    const direct = bestMusicArtistFact(cleanArtist, fallback);
    if (!direct) continue;
    writeCachedArtistFact(cleanArtist, direct);
    return direct;
  }
  return null;
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
    if (!isArtistFact(cached.fact) || !isLikelyMusicArtistFact(artist, cached.fact)) {
      storage.removeItem(key);
      return null;
    }
    return cached.fact;
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

function isLikelyMusicArtistFact(artist: string, fact: ArtistFact): boolean {
  return scoreMusicArtistFact(artist, fact) >= 70;
}

function scoreMusicArtistFact(artist: string, fact: ArtistFact): number {
  const haystack = normalizeForMatch(`${fact.title} ${fact.description ?? ''} ${fact.summary}`);
  const requested = normalizeForMatch(artist);
  if (!requested) return 0;
  const title = normalizeForMatch(fact.title);
  const titleWithoutParenthetical = normalizeForMatch(fact.title.replace(/\s+\([^)]*\)\s*$/, ''));
  const words = requested.split(/\s+/).filter((word) => word.length > 1);
  const titleNameSignal = title.includes(requested) || titleWithoutParenthetical === requested;
  const knownAsSignal = new RegExp(`\\b(?:known as|stage name|performs? as|professionally as)\\s+${escapeRegExp(requested)}\\b`, 'i').test(haystack);
  const allWordsSignal = words.length > 0 && words.every((word) => haystack.includes(word));
  if (!titleNameSignal && !knownAsSignal && !allWordsSignal) return 0;

  const description = fact.description ?? '';
  const titleMusic = MUSIC_TITLE_PATTERN.test(fact.title);
  const titleNonMusic = NON_MUSIC_TITLE_PATTERN.test(fact.title);
  const descriptionMusic = MUSIC_ENTITY_PATTERN.test(description);
  const summaryMusic = MUSIC_ENTITY_PATTERN.test(fact.summary);
  const descriptionNonMusic = NON_MUSIC_ENTITY_PATTERN.test(description);
  const titleNonMusicByDescription = NON_MUSIC_ENTITY_PATTERN.test(fact.title);
  const creativeWorkDescription = CREATIVE_WORK_DESCRIPTION_PATTERN.test(description);

  if ((titleNonMusic || creativeWorkDescription) && !titleMusic && !descriptionMusic) return 0;
  if ((descriptionNonMusic || titleNonMusicByDescription) && !titleMusic && !descriptionMusic) return 0;

  let score = 0;
  if (titleWithoutParenthetical === requested || title === requested) score += 25;
  else if (titleNameSignal) score += 15;
  else if (knownAsSignal) score += 12;
  else if (allWordsSignal) score += 8;

  if (titleMusic) score += 70;
  if (descriptionMusic) score += 55;
  else if (summaryMusic) score += 50;

  if (titleNonMusic) score -= 90;
  if (descriptionNonMusic || titleNonMusicByDescription) score -= 85;
  if (creativeWorkDescription) score -= 70;

  return score;
}

function bestMusicArtistFact(artist: string, facts: ArtistFact[]): ArtistFact | null {
  let best: { fact: ArtistFact; score: number } | null = null;
  for (const fact of facts) {
    const score = scoreMusicArtistFact(artist, fact);
    if (score < 70) continue;
    if (!best || score > best.score) best = { fact, score };
  }
  return best?.fact ?? null;
}

function isSkippableArtistLookup(artist: string): boolean {
  return /^(unknown artist|unknown|various artists?|va|n\/a|soundtrack|original soundtrack)$/i.test(artist.trim());
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
      if (!key || seen.has(key) || isSkippableArtistLookup(name)) return false;
      seen.add(key);
      return true;
    });
}

function directTitleCandidates(artist: string): string[] {
  const titles: string[] = [];
  for (const lookupName of lookupArtistNames(artist)) {
    titles.push(...MUSIC_DISAMBIGUATORS.map((kind) => `${lookupName} (${kind})`), lookupName);
  }
  return [...new Set(titles)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchWikiCandidates(
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<ArtistFact[]> {
  return fetchWikipediaPages(query, pageToArtistFact, signal, 'wiki artist');
}

function pageToArtistFact(page: WikiPage): ArtistFact | null {
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
