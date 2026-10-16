// The album grid's page appending (src/lib/album-pages.ts) with the offset
// AlbumsView keeps: rows read, not albums kept. A scan that adds albums
// mid-scroll (downloads landing under "Recently added") shifts every later
// page; the grid must not repeat an album, skip one, or stop loading.
// Run: node scripts/album-pages-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const outfile = resolve('tmp/album-pages-test-bundle.mjs');
await build({
  entryPoints: [resolve('src/lib/album-pages.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile,
  logLevel: 'silent',
});
const { appendAlbumPage } = await import(pathToFileURL(outfile).href);

const album = (n, artist = `Artist ${n}`) => ({
  albumKey: `album ${n}|${artist.toLowerCase()}`,
  album: `Album ${n}`,
  albumArtist: artist,
  year: null,
  trackCount: 1,
  duration: 1,
});
const key = (a) => `${a.albumArtist}|${a.album}`;

// Plain append, and repeats within the new page or against the list dropped.
{
  const list = appendAlbumPage([album(1), album(2)], [album(3), album(2), album(3), album(4)]);
  assert.deepEqual(list.map(key), ['Artist 1|Album 1', 'Artist 2|Album 2', 'Artist 3|Album 3', 'Artist 4|Album 4']);
  // Same title, another album artist: a different album.
  const split = appendAlbumPage([album(5, 'Pixies')], [album(5, 'Melt-Banana'), album(5, 'Pixies')]);
  assert.equal(split.length, 2);
}

// Albums that share a title and album artist but not a key (the pieces of a split folder, folders under a generic
// title) are separate albums: none is dropped, within a page or against the list.
{
  const piece = (suffix) => ({ ...album(7, 'Lil Yachty'), album: 'Unreleased', albumKey: 'unreleased|lil yachty|@' + suffix });
  const list = appendAlbumPage([piece('a')], [piece('b'), piece('c'), piece('b'), piece('a')]);
  assert.deepEqual(list.map((a) => a.albumKey), ['unreleased|lil yachty|@a', 'unreleased|lil yachty|@b', 'unreleased|lil yachty|@c']);
  // Paging through twenty-four of them keeps all twenty-four.
  let shown = [];
  for (let i = 0; i < 24; i += 6) shown = appendAlbumPage(shown, Array.from({ length: 6 }, (_, j) => piece('k' + (i + j))));
  assert.equal(shown.length, 24);
}

/** Scrolls a newest-first grid to the end; `arrivals(page)` is how many albums land on top before that page. */
function scroll(arrivals) {
  const PAGE = 24;
  const original = Array.from({ length: 300 }, (_, i) => album(1000 - i));
  let library = [...original];
  let next = 5000;
  let fetched = 0;
  let shown = [];
  let more = true;
  for (let page = 0; more && page < 500; page++) {
    const landing = page === 0 ? 0 : arrivals(page);
    for (let i = 0; i < landing; i++) library = [album(next++), ...library];
    const rows = library.slice(fetched, fetched + PAGE + 1);
    const kept = rows.slice(0, PAGE);
    fetched += kept.length;
    shown = appendAlbumPage(shown, kept);
    more = rows.length > PAGE;
  }
  const keys = shown.map(key);
  assert.equal(new Set(keys).size, keys.length, 'no album is shown twice');
  for (const a of original) assert.ok(keys.includes(key(a)), `${key(a)} was skipped`);
  assert.equal(more, false, 'paging reached the end');
  return shown.length;
}

// A few albums before each page, more in all than a page holds.
scroll((page) => (page <= 12 ? 3 : 0));
// One burst bigger than a whole page between two reads.
scroll((page) => (page === 4 ? 60 : 0));
// Nothing arriving: every album exactly once.
assert.equal(scroll(() => 0), 300);

console.log('[album-pages] PASS');
