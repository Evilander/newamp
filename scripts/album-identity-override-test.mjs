// "Show as separate albums" and "Group again": the choice is stored by folder
// and title (not by track), so it survives a rescan, a retag of the files, new
// track ids and a restart; undoing it brings the grouped album back; and the
// albums it does not touch are left alone.
// Run: npm run build:electron && node scripts/album-identity-override-test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';

const root = resolve('tmp/album-identity-override-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const dbPath = join(root, 'library.db');

const reading = (folder, n, artist, album, extra = {}) => ({
  path: `K:/music/${folder}/${String(n).padStart(2, '0')}.mp3`,
  title: `Song ${n}`,
  artist,
  album,
  albumArtist: artist,
  trackNo: n,
  discNo: null,
  year: 2004,
  genre: null,
  duration: 120,
  bitrate: null,
  sampleRate: null,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 100 + n,
  mtime: 1,
  art: null,
  ...extra,
});
const compilation = () => Array.from({ length: 6 }, (_, i) => reading('Mix CD', i + 1, `Artist ${i}`, 'Mix CD'));
const record = () => Array.from({ length: 4 }, (_, i) => reading('Band/Record', i + 1, 'Band', 'Record'));

let library = await LibraryStore.open(dbPath);
library.upsertTracks([...compilation(), ...record()]);
await library.regroupAlbums();
const albums = () => library.getAlbums({ limit: 100, sort: 'album' });
const mix = () => albums().filter((a) => a.album === 'Mix CD');

assert.equal(albums().length, 2);
assert.equal(mix().length, 1);
assert.equal(mix()[0].albumKind, 'compilation');
const grouped = mix()[0];
library.setAlbumRatingScore('Various Artists', 'Mix CD', 80, grouped.albumKey);

// Split it.
assert.equal(await library.setAlbumSplit(grouped.albumKey, true), 1, 'one folder was split');
assert.equal(mix().length, 6, 'one album per track artist, as before');
assert.ok(mix().every((a) => a.albumKind === 'split' && a.trackCount === 1));
assert.match(mix()[0].albumReason, /Shown as separate albums at your request/);
assert.equal(albums().filter((a) => a.album === 'Record').length, 1, 'the other album is untouched');
assert.equal(library.listAlbumOverrides().length, 1);
assert.equal(library.listAlbumOverrides()[0].action, 'split');
assert.equal(library.getAlbumTracks('Artist 3', 'Mix CD').length, 1, 'the old call shape finds the piece');
// The rating followed one piece instead of vanishing.
assert.equal(mix().filter((a) => a.ratingScore === 80).length, 1);

// A rescan of the same files, with a retag that does not change the folder or title.
library.upsertTracks(compilation().map((t) => ({ ...t, size: t.size + 1, year: 2005 })));
await library.regroupAlbums();
assert.equal(mix().length, 6, 'a rescan does not undo the choice');

// New track ids: the files are removed and read in again.
const ids = library.getTracksByPaths(compilation().map((t) => t.path)).map((t) => t.id);
library.removeTracksById(ids);
library.upsertTracks(compilation());
await library.regroupAlbums({ force: true });
assert.equal(mix().length, 6, 'the choice belongs to the folder, not to the track ids');

// Restart.
library.close();
library = await LibraryStore.open(dbPath);
await library.albumsReady();
assert.equal(mix().length, 6, 'and survives a restart');

// Group again, from any piece.
const piece = mix().find((a) => a.albumArtist === 'Artist 2');
assert.equal(await library.setAlbumSplit(piece.albumKey, false), 1);
assert.equal(mix().length, 1);
assert.equal(mix()[0].albumKind, 'compilation');
assert.equal(mix()[0].trackCount, 6);
assert.equal(library.listAlbumOverrides().length, 0);
assert.equal(mix()[0].ratingScore, 80, 'the rating came back with the album');

// A folder that was never split, asked to split and then grouped again, leaves nothing behind.
const band = albums().find((a) => a.album === 'Record');
await library.setAlbumSplit(band.albumKey, true);
assert.equal(albums().filter((a) => a.album === 'Record').length, 1, 'tracks of one artist are still one album');
await library.setAlbumSplit(albums().find((a) => a.album === 'Record').albumKey, false);
assert.equal(library.listAlbumOverrides().length, 0);

// A title of nothing but spaces is no album.
library.upsertTracks([reading('Blank', 1, 'Nobody', '   ')]);
await library.regroupAlbums();
assert.ok(!albums().some((a) => a.album.trim() === ''), 'a blank album title is not listed');
assert.equal(library.getTracksByPaths([reading('Blank', 1, 'Nobody', '   ').path])[0].albumKey, null);

// An unknown key does nothing.
assert.equal(await library.setAlbumSplit('no such album|key', true), 0);
assert.equal(await library.setAlbumSplit('', true), 0);
library.close();
// The pieces are wired from the library to the page.
{
  const { readFile } = await import('node:fs/promises');
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [main, preload, api, types, albumsView, artistsView, nowPlaying, quickPlay] = await Promise.all([
    read('electron/main.ts'),
    read('electron/preload.ts'),
    read('src/lib/api.ts'),
    read('shared/types.ts'),
    read('src/components/views/AlbumsView.tsx'),
    read('src/components/views/ArtistsView.tsx'),
    read('src/components/views/NowPlayingView.tsx'),
    read('src/components/QuickPlayPalette.tsx'),
  ]);
  for (const channel of ['library:get-album-tracks-by-key', 'library:get-album-summary', 'library:set-album-split']) {
    assert.ok(main.includes(`'${channel}'`), `${channel} handled in main`);
    assert.ok(preload.includes(`'${channel}'`), `${channel} exposed by preload`);
  }
  assert.match(main, /await library\.albumsReady\(\);\s+return library\.getAlbums/, 'the album list waits for a grouping pass that is running');
  // Every handler that reaches a query needing album keys waits for a pass that is running or due.
  // Without that wait the query runs the whole grouping pass on the main thread (about a second on a
  // 58,000-track library), which is what the first launch after an upgrade used to do on getStats.
  const handlerBody = (channel) => {
    const at = main.indexOf(`'${channel}'`);
    assert.ok(at >= 0, `${channel} is handled in main`);
    const next = main.indexOf('ipcMain.handle(', at + 1);
    return main.slice(at, next < 0 ? undefined : next);
  };
  for (const [channel, call] of [
    ['library:get-albums', 'library.getAlbums('],
    ['library:get-artists', 'library.getArtists('],
    ['library:get-album-tracks', 'library.getAlbumTracks('],
    ['library:get-album-tracks-by-key', 'library.getAlbumTracksByKey('],
    ['library:get-album-summary', 'library.getAlbumSummary('],
    ['library:get-artist-tracks', 'library.getArtistTracks('],
    ['library:get-stats', 'library.getStats('],
    ['library:get-health', 'library.getLibraryHealthAsync('],
    ['library:set-album-rating-score', 'library.setAlbumRatingScore('],
    ['library:get-album-rating', 'library.getAlbumRating('],
    ['album-art:apply', 'library.applyAlbumArtToAlbum('],
  ]) {
    const body = handlerBody(channel);
    assert.ok(body.includes(call), `${channel} calls ${call}`);
    assert.ok(
      body.indexOf('await library.albumsReady()') >= 0 && body.indexOf('await library.albumsReady()') < body.indexOf(call),
      `${channel} waits for the grouping pass before it calls ${call}`,
    );
  }
  for (const name of ['getAlbumTracksByKey', 'getAlbumSummary', 'setAlbumSplit']) {
    assert.ok(types.includes(`${name}:`) && api.includes(`${name}:`), `${name} typed and stubbed`);
  }
  assert.match(albumsView, /api\s*\.getAlbumTracksByKey\(album\.albumKey\)/, 'the album page opens an album by key');
  assert.match(albumsView, /data-newamp-album-reason/, 'the album page says why it was grouped');
  assert.match(albumsView, /Show as separate albums/);
  assert.match(albumsView, /api\.setAlbumSplit/);
  assert.match(albumsView, /data-newamp-album-disc-heading/, 'a multi-disc album has disc headings');
  assert.match(artistsView, /key=\{a\.artistKey\}/, 'artists are listed by key');
  assert.match(nowPlaying, /getAlbumTracksByKey\(deferredTrack\.albumKey\)/, 'Now Playing finds the rest of the album by key');
  assert.match(quickPlay, /api\.getAlbumTracksByKey\(item\.album\.albumKey\)/, 'Quick Play plays an album by key');
}

console.log('[album-identity-override-test] ok: split and group again survive rescans, new ids and restarts');
