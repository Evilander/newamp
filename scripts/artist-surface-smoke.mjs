import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

const params = new URLSearchParams({
  origin: '*',
  action: 'query',
  redirects: '1',
  titles: 'Radiohead',
  prop: 'extracts|pageimages|info|description',
  exintro: '1',
  explaintext: '1',
  inprop: 'url',
  piprop: 'thumbnail|original',
  pithumbsize: '900',
  format: 'json',
});

const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
assert.equal(res.ok, true, `Wikipedia artist image probe failed: ${res.status}`);
const data = await res.json();
const page = Object.values(data.query?.pages ?? {})[0];
assert.ok(page?.thumbnail?.source || page?.original?.source, 'Radiohead artist image probe returned no image');
assert.ok(page?.extract, 'Radiohead artist image probe returned no extract');

console.log(
  JSON.stringify(
    {
      ok: true,
      title: page.title,
      hasThumbnail: !!page.thumbnail?.source,
      hasOriginal: !!page.original?.source,
      extractChars: page.extract.length,
    },
    null,
    2,
  ),
);
