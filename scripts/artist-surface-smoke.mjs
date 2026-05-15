import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchArtistFacts } from '../src/api/artistFacts.ts';

const [artistFactsSource, artistsViewSource, nowPlayingSource] = await Promise.all([
  readFile(new URL('../src/api/artistFacts.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/ArtistsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
]);

assert.match(artistFactsSource, /piprop/, 'artist facts should request PageImages original/thumbnail data');
assert.match(artistFactsSource, /pithumbsize:\s*'900'/, 'artist images should request large thumbnails');
assert.match(artistFactsSource, /originalImageUrl/, 'artist facts should expose an original artist image URL');
assert.match(artistFactsSource, /description/, 'artist facts should expose a short artist description');
assert.match(artistFactsSource, /newamp:artist-facts:v1/, 'artist facts should use a stable local cache namespace');
assert.match(artistFactsSource, /ARTIST_FACT_CACHE_TTL_MS/, 'artist facts cache should have an explicit freshness window');
assert.match(artistFactsSource, /readCachedArtistFact/, 'artist facts should read cached Wikipedia data before fetching');
assert.match(artistFactsSource, /writeCachedArtistFact/, 'artist facts should persist successful Wikipedia data');
assert.match(artistsViewSource, /ArtistSpotlight/, 'Artists view should show an artist image/facts spotlight');
assert.match(nowPlayingSource, /ArtistImageStage/, 'Now Playing should render an image-first artist facts stage');

const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map();
const requestedUrls = [];

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
});

try {
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return jsonResponse({
      query: {
        pages: {
          1: {
            title: 'Radiohead',
            description: 'English rock band',
            extract: 'Radiohead are an English rock band formed in Abingdon, Oxfordshire.',
            fullurl: 'https://en.wikipedia.org/wiki/Radiohead',
            thumbnail: { source: 'https://images.example/radiohead-900.jpg' },
            original: { source: 'https://images.example/radiohead-original.jpg' },
          },
        },
      },
    });
  };

  const fact = await fetchArtistFacts('Radiohead');
  assert.ok(fact, 'artist facts should be produced from a valid wiki page');
  assert.equal(fact.title, 'Radiohead');
  assert.equal(fact.description, 'English rock band');
  assert.equal(fact.thumbnailUrl, 'https://images.example/radiohead-900.jpg');
  assert.equal(fact.originalImageUrl, 'https://images.example/radiohead-original.jpg');
  assert.match(fact.summary, /English rock band/);

  const directUrl = new URL(requestedUrls[0]);
  assert.equal(directUrl.searchParams.get('titles'), 'Radiohead');
  assert.equal(directUrl.searchParams.get('piprop'), 'thumbnail|original');
  assert.equal(directUrl.searchParams.get('pithumbsize'), '900');
  assert.equal(storage.size, 1, 'successful artist facts should be cached locally');

  globalThis.fetch = async () => {
    throw new Error('cache should avoid a second network fetch');
  };
  assert.deepEqual(await fetchArtistFacts('Radiohead'), fact, 'second lookup should read cached artist facts');

  storage.clear();
  requestedUrls.length = 0;
  let fallbackCall = 0;
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    fallbackCall += 1;
    if (fallbackCall === 1) {
      return jsonResponse({ query: { pages: { '-1': { title: 'Missing' } } } });
    }
    return jsonResponse({
      query: {
        pages: {
          2: {
            title: 'The National',
            description: 'American rock band',
            extract: 'The National are an American rock band formed in Cincinnati, Ohio.',
            fullurl: 'https://en.wikipedia.org/wiki/The_National_(band)',
            thumbnail: { source: 'https://images.example/national-900.jpg' },
          },
        },
      },
    });
  };

  const fallback = await fetchArtistFacts('The National');
  assert.ok(fallback, 'artist facts should fall back to a musician-oriented search');
  assert.equal(fallback.title, 'The National');
  const fallbackUrl = new URL(requestedUrls[1]);
  assert.equal(fallbackUrl.searchParams.get('generator'), 'search');
  assert.match(fallbackUrl.searchParams.get('gsrsearch') ?? '', /band OR singer OR musician/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        directTitle: fact.title,
        fallbackTitle: fallback.title,
        cachedEntries: storage.size,
        requests: requestedUrls.length,
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    delete globalThis.localStorage;
  }
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
