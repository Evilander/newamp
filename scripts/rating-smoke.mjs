import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'rating-smoke');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const library = await LibraryStore.open(dbPath);
library.upsertTracks([
  fixtureTrack('a.mp3', 'Five Star Song', 'The Ratings', 'Stars', 1),
  fixtureTrack('b.mp3', 'Three Star Song', 'The Ratings', 'Stars', 2),
  fixtureTrack('c.mp3', 'Unrated Song', 'The Ratings', 'Stars', 3),
]);

const initial = library.getTracks({ limit: 10, sort: 'artist' });
assert.equal(initial[0].rating, 0, 'tracks should default to unrated');

const five = library.setTrackRating(initial[0].id, 7);
assert.ok(five, 'setTrackRating should return the updated track');
assert.equal(five.rating, 5, 'ratings should clamp to five stars');

const three = library.setTrackRating(initial[1].id, 3.2);
assert.equal(three?.rating, 3, 'ratings should round to whole stars');

const cleared = library.setTrackRating(initial[0].id, -1);
assert.equal(cleared?.rating, 0, 'ratings should clear to zero');
library.setTrackRating(initial[0].id, 5);

const ratedSort = library.getTracks({ limit: 10, sort: 'rating' });
assert.deepEqual(
  ratedSort.map((track) => track.rating),
  [5, 3, 0],
  'rating sort should put highest-rated tracks first without hiding unrated tracks',
);

const highRated = library.getTracks({ search: 'rating:>=4', limit: 10, sort: 'rating' });
assert.deepEqual(highRated.map((track) => track.title), ['Five Star Song']);

const unrated = library.getTracks({ search: 'rating:0', limit: 10, sort: 'artist' });
assert.deepEqual(unrated.map((track) => track.title), ['Unrated Song']);

library.close();

const reloaded = await LibraryStore.open(dbPath);
assert.equal(reloaded.getTracks({ search: 'rating:5', limit: 10, sort: 'artist' }).length, 1);
reloaded.close();

const [typesSource, librarySource, mainSource, preloadSource, apiSource, storeSource, libraryViewSource, nowPlayingSource, packageSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /rating: number/, 'Track type should expose rating');
assert.match(typesSource, /setTrackRating/, 'shared API should expose setTrackRating');
assert.match(librarySource, /rating\s+INTEGER/, 'tracks schema should persist rating');
assert.match(mainSource, /library:set-rating/, 'main process should register rating IPC');
assert.match(preloadSource, /setTrackRating/, 'preload should expose rating updates');
assert.match(apiSource, /setTrackRating/, 'browser-safe API should include rating updates');
assert.match(storeSource, /setTrackRating/, 'player store should update current queue rating state');
assert.match(libraryViewSource, /data-newamp-rating/, 'Library rows should expose rating controls');
assert.match(nowPlayingSource, /Rating/, 'Now Playing should expose current-track rating');
assert.match(packageSource, /smoke:rating/, 'package scripts should include rating smoke');

console.log(JSON.stringify({
  ok: true,
  ratings: ratedSort.map((track) => ({ title: track.title, rating: track.rating })),
}, null, 2));

function fixtureTrack(path, title, artist, album, trackNo) {
  return {
    path: join(smokeRoot, path),
    title,
    artist,
    album,
    albumArtist: artist,
    trackNo,
    discNo: null,
    year: 2026,
    genre: 'Rock',
    duration: 180,
    bitrate: 320000,
    sampleRate: 44100,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1000,
    mtime: Date.now(),
    art: null,
  };
}
