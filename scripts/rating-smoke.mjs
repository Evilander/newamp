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

// Album rating round-trip. The 1.5.4 album_ratings table is independent
// of tracks.rating; verifying both that the round-trip persists AND that
// setting an album rating does NOT clobber per-track ratings (that was
// the exact bug 1.5.4 was meant to fix).
const albumRated = library.setAlbumRatingScore('The Ratings', 'Stars', 75);
assert.equal(albumRated?.rating, 4, '75/100 should round to 4 stars');
assert.equal(albumRated?.ratingScore, 75, 'fine album score should round-trip');
assert.equal(library.getAlbumRating('The Ratings', 'Stars')?.ratingScore, 75, 'getAlbumRating should return what we wrote');

// NOCASE composite key — different casing must hit the same row (ASCII
// caveat documented in the schema; non-ASCII titles diverge).
assert.equal(
  library.getAlbumRating('the ratings', 'STARS')?.ratingScore,
  75,
  'album rating lookup should be case-insensitive for ASCII',
);

// The exact bug 1.5.4 was meant to fix: setting an album rating must NOT
// rewrite per-track rating_score. If we ever regress to cascade behavior,
// this assertion fires.
const fiveStarTrack = library.getTracks({ search: 'rating:5', limit: 10, sort: 'artist' });
assert.equal(fiveStarTrack.length, 1, 'pre-existing per-track rating must survive the album rating write');
assert.equal(fiveStarTrack[0].title, 'Five Star Song');

// getAlbums must surface the album rating through the bulk Map merge
// (no LEFT JOIN — that was the 1.5.4 ambiguous-column regression). This
// assertion fires if either: (a) the merge breaks; (b) the SQL query
// itself fails to return rows after an album_ratings row exists (the
// exact "empty library" symptom users hit in 1.5.4).
const albumsListed = library.getAlbums({ limit: 100 });
assert.ok(albumsListed.length > 0, 'getAlbums must return rows when album_ratings has data — 1.5.4 LEFT JOIN regression would fire ambiguous-column SQL here');
const starsRow = albumsListed.find((a) => a.album === 'Stars');
assert.equal(starsRow?.ratingScore, 75, 'getAlbums must merge album_ratings into the returned rows');
assert.equal(starsRow?.rating, 4, '75/100 must round to 4 stars in the listing');

// Clear path — must DELETE the row, not just zero it out. Returns null
// on successful clear (distinct from the throw on invalid input).
const cleared2 = library.setAlbumRatingScore('The Ratings', 'Stars', null);
assert.equal(cleared2, null, 'clearing an album rating should return null');
assert.equal(library.getAlbumRating('The Ratings', 'Stars'), null, 'cleared album should have no row');

// Invalid input throws (1.5.7 H13 hardening) — empty albumArtist must
// be a programmer error, not "this is an unrated album" silently.
assert.throws(
  () => library.setAlbumRatingScore('', 'Stars', 50),
  /requires non-empty albumArtist/,
  'empty albumArtist must throw, not silently no-op',
);
assert.throws(
  () => library.getAlbumRating('', 'Stars'),
  /requires non-empty albumArtist/,
  'getAlbumRating with empty input must throw too',
);

library.close();

const reloaded = await LibraryStore.open(dbPath);
assert.equal(reloaded.getTracks({ search: 'rating:5', limit: 10, sort: 'artist' }).length, 1);
// Persist album rating across reopen.
reloaded.setAlbumRatingScore('The Ratings', 'Stars', 91);
reloaded.close();
const reloaded2 = await LibraryStore.open(dbPath);
assert.equal(
  reloaded2.getAlbumRating('The Ratings', 'Stars')?.ratingScore,
  91,
  'album rating must persist across LibraryStore reopen',
);
reloaded2.close();

const [typesSource, librarySource, mainSource, preloadSource, apiSource, storeSource, libraryViewSource, albumsViewSource, nowPlayingSource, packageSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/AlbumsView.tsx', import.meta.url), 'utf8'),
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
assert.match(libraryViewSource, /storeToggleLove/, 'shared track tables should love tracks outside the main Library view');
assert.match(libraryViewSource, /storeSetTrackRating/, 'shared track tables should rate tracks outside the main Library view');
assert.match(libraryViewSource, /patchLocalTrack/, 'shared track tables should re-render local row actions without mutating DOM');
assert.match(albumsViewSource, /data-newamp-album-rating/, 'Albums view should expose an album-level score slider');
// The 1.5.4 refactor split album rating from track rating — the album
// slider must call setAlbumRatingScore, not cascade to setTrackRatingScore.
// The bug we're locking down: writing to every track in the album
// silently destroyed per-song user nuance.
assert.match(albumsViewSource, /api\.setAlbumRatingScore/, 'Album rating must call setAlbumRatingScore (independent of track rating)');
assert.doesNotMatch(
  albumsViewSource,
  /tracks\.map\(\(track\) => setTrackRatingScore/,
  'Album rating MUST NOT cascade to track ratings — that destroyed per-song nuance pre-1.5.4',
);
assert.match(albumsViewSource, /albumScore/, 'Album rating should summarize selected album track scores as fallback');
assert.match(nowPlayingSource, /Rating/, 'Now Playing should expose current-track rating');
assert.match(nowPlayingSource, /ScoreRating/, 'Now Playing should use the decimal score control');
const scoreRatingSource = await readFile(new URL('../src/components/ScoreRating.tsx', import.meta.url), 'utf8');
assert.match(scoreRatingSource, /data-newamp-score-rating-input/, 'score rating should expose a direct typed numeric input');
assert.match(scoreRatingSource, /type="number"/, 'score rating input should be numeric');
assert.match(scoreRatingSource, /step=\{SCORE_STEP_FINE\}/, 'score rating input should accept exact 0.1 steps');
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
