export interface AlbumFact {
  title: string;
  description: string | null;
  summary: string;
  url: string;
  imageUrl: string | null;
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

export async function fetchAlbumFacts(
  album: string,
  artist: string,
  signal?: AbortSignal,
): Promise<AlbumFact | null> {
  const cleanAlbum = album.trim();
  const cleanArtist = artist.trim();
  if (!cleanAlbum || cleanAlbum === 'Unknown Album') return null;

  const directTitles = [
    cleanArtist ? `${cleanAlbum} (${cleanArtist} album)` : '',
    `${cleanAlbum} (album)`,
    cleanAlbum,
  ].filter(Boolean);

  for (const title of directTitles) {
    const fact = await fetchWiki({
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
    if (fact && isLikelyAlbumFact(cleanAlbum, cleanArtist, fact)) return fact;
  }

  const query = cleanArtist
    ? `"${cleanAlbum}" "${cleanArtist}" album`
    : `"${cleanAlbum}" album`;
  const fallback = await fetchWiki({
    origin: '*',
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '1',
    prop: 'extracts|pageimages|info|description',
    exintro: '1',
    explaintext: '1',
    inprop: 'url',
    piprop: 'thumbnail|original',
    pithumbsize: '900',
    format: 'json',
  }, signal);

  return fallback && isLikelyAlbumFact(cleanAlbum, cleanArtist, fallback) ? fallback : null;
}

function isLikelyAlbumFact(album: string, artist: string, fact: AlbumFact): boolean {
  const haystack = `${fact.title} ${fact.description ?? ''} ${fact.summary}`.toLowerCase();
  const albumWords = album.toLowerCase().split(/\s+/).filter(Boolean);
  const artistWords = artist.toLowerCase().split(/\s+/).filter(Boolean);
  const significantArtistWords = artistWords.filter((word) => word.length > 2);
  const hasAlbum = albumWords.length > 0 && albumWords.every((word) => haystack.includes(word));
  const hasArtist = significantArtistWords.length === 0 || significantArtistWords.some((word) => haystack.includes(word));
  return hasAlbum && hasArtist && /\b(album|studio album|ep|record|released|recorded|label)\b/.test(haystack);
}

async function fetchWiki(
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<AlbumFact | null> {
  const params = new URLSearchParams(query);
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { signal });
  if (!res.ok) return null;
  const data = (await res.json()) as WikiResponse;
  const page = Object.values(data.query?.pages ?? {})[0];
  if (!page?.extract || !page.title || !page.fullurl) return null;
  return {
    title: page.title,
    description: page.description?.replace(/\s+/g, ' ').trim() ?? null,
    summary: page.extract.replace(/\s+/g, ' ').trim().slice(0, 900),
    url: page.fullurl,
    imageUrl: page.thumbnail?.source ?? page.original?.source ?? null,
  };
}
