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
assert.match(artistFactsSource, /newamp:artist-facts:v3/, 'artist facts should use a stable local cache namespace');
assert.match(artistFactsSource, /isLikelyMusicArtistFact/, 'artist facts should reject animal/species false positives');
assert.match(artistFactsSource, /scoreMusicArtistFact/, 'artist facts should rank musician pages above same-name non-music pages');
assert.match(artistFactsSource, /bestMusicArtistFact/, 'artist facts should choose the best musician candidate from multiple results');
assert.match(artistFactsSource, /ARTIST_FACT_CACHE_TTL_MS/, 'artist facts cache should have an explicit freshness window');
assert.match(artistFactsSource, /readCachedArtistFact/, 'artist facts should read cached Wikipedia data before fetching');
assert.match(artistFactsSource, /writeCachedArtistFact/, 'artist facts should persist successful Wikipedia data');
assert.match(artistsViewSource, /ArtistSpotlight/, 'Artists view should show an artist image/facts spotlight');
assert.match(nowPlayingSource, /ArtistImageStage/, 'Now Playing should render an image-first artist facts stage');
assert.match(nowPlayingSource, /AlbumContextPanel/, 'Now Playing should replace Studio with album context');
assert.match(nowPlayingSource, /fetchAlbumFacts/, 'Album context should look up album stories when available');
assert.match(nowPlayingSource, /api\.getAlbums\(\{\s*year: albumYear,[\s\S]*yearWindow: 1,[\s\S]*limit: 5/, 'Album context should query only nearby release years');
assert.doesNotMatch(nowPlayingSource, /api\.getAlbums\(\)\.catch/, 'Album context should not pull the full album catalog');

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
  assert.ok(
    ['Radiohead', 'Radiohead (musician)', 'Radiohead (band)'].includes(String(directUrl.searchParams.get('titles'))),
    'artist facts should begin with a direct title or music disambiguation title',
  );
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
  assert.ok(
    requestedUrls.some((url) => url.includes('The+National+%28musician%29') || url.includes('The+National+%28band%29')),
    'artist facts should try direct musician/band disambiguation titles',
  );

  storage.clear();
  requestedUrls.length = 0;
  storage.set(
    'newamp:artist-facts:v3:panda%20bear',
    JSON.stringify({
      fetchedAt: Date.now(),
      fact: {
        title: 'Giant panda',
        description: 'species of bear',
        summary: 'The giant panda is a bear species endemic to China.',
        url: 'https://en.wikipedia.org/wiki/Giant_panda',
        imageUrl: null,
        thumbnailUrl: null,
        originalImageUrl: null,
      },
    }),
  );
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    const parsed = new URL(String(url));
    const title = String(parsed.searchParams.get('titles') ?? '');
    if (!title.includes('Panda Bear (musician)')) {
      return jsonResponse({
        query: {
          pages: {
            3: {
              title: 'Giant panda',
              description: 'species of bear',
              extract: 'The giant panda is a bear species endemic to China.',
              fullurl: 'https://en.wikipedia.org/wiki/Giant_panda',
            },
          },
        },
      });
    }
    return jsonResponse({
      query: {
        pages: {
          4: {
            title: 'Panda Bear (musician)',
            description: 'American musician',
            extract: 'Noah Lennox, known as Panda Bear, is an American musician and member of Animal Collective.',
            fullurl: 'https://en.wikipedia.org/wiki/Panda_Bear_(musician)',
            thumbnail: { source: 'https://images.example/panda-bear-900.jpg' },
          },
        },
      },
    });
  };

  const panda = await fetchArtistFacts('Panda Bear');
  assert.ok(panda, 'Panda Bear should resolve to the musician, not the cached animal');
  assert.equal(panda.title, 'Panda Bear (musician)');
  assert.ok(
    requestedUrls.some((url) => url.includes('Panda+Bear+%28musician%29')),
    'artist facts should proactively try musician disambiguation before trusting ambiguous direct pages',
  );

  storage.clear();
  requestedUrls.length = 0;
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    const parsed = new URL(String(url));
    if (!parsed.searchParams.has('generator')) {
      return jsonResponse({ query: { pages: { '-1': { title: 'Missing' } } } });
    }
    return jsonResponse({
      query: {
        pages: {
          5: {
            title: 'Phoenix',
            description: 'capital city of Arizona',
            extract: 'Phoenix is a city with museums, sports, and a large live music scene.',
            fullurl: 'https://en.wikipedia.org/wiki/Phoenix,_Arizona',
          },
          6: {
            title: 'Phoenix (band)',
            description: 'French indie pop band',
            extract: 'Phoenix are a French indie pop band from Versailles.',
            fullurl: 'https://en.wikipedia.org/wiki/Phoenix_(band)',
            thumbnail: { source: 'https://images.example/phoenix-900.jpg' },
          },
          7: {
            title: 'Phoenix (album)',
            description: 'album by a rock band',
            extract: 'Phoenix is an album by a rock band.',
            fullurl: 'https://en.wikipedia.org/wiki/Phoenix_(album)',
          },
        },
      },
    });
  };

  const phoenix = await fetchArtistFacts('Phoenix');
  assert.ok(phoenix, 'ambiguous artist names should resolve to musician pages from multi-result search');
  assert.equal(phoenix.title, 'Phoenix (band)');
  assert.ok(
    requestedUrls.some((url) => new URL(url).searchParams.get('gsrlimit') === '6'),
    'artist facts should inspect multiple fallback candidates, not just the first search hit',
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        directTitle: fact.title,
        fallbackTitle: fallback.title,
        pandaTitle: panda.title,
        phoenixTitle: phoenix.title,
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
