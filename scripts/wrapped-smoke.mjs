import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

// Exercises getWrappedStats aggregation math against a seeded fixture DB across
// all five ranges (day / week / month / year / all). Pure-node + CI-safe.
// Timestamps are built with the LOCAL Date constructor so calendar month/year
// boundaries line up with the library's local-time bucketing on any runner TZ.

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'wrapped-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const library = await LibraryStore.open(dbPath);
const mkTrack = (name, title, artist, genre, duration) => ({
  path: join(musicRoot, name),
  title,
  artist,
  album: `${artist} Album`,
  albumArtist: artist,
  trackNo: 1,
  discNo: null,
  year: 2026,
  genre,
  duration,
  bitrate: null,
  sampleRate: null,
  bpm: null,
  key: null,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 0,
  mtime: Date.now(),
  art: null,
});

library.upsertTracks([
  mkTrack('a.mp3', 'Alpha', 'Artist One', 'Synthwave', 200),
  mkTrack('b.mp3', 'Beta', 'Artist One', 'Synthwave', 180),
  mkTrack('c.mp3', 'Gamma', 'Artist Two', 'Jazz', 240),
  mkTrack('d.mp3', 'Delta', 'Artist Three', 'Rock', 160),
]);

const tracks = library.getTracks({ sort: 'album', limit: 10 });
const id = (t) => tracks.find((x) => x.title === t).id;
const A = id('Alpha');
const B = id('Beta');
const C = id('Gamma');
const D = id('Delta');

const now = new Date(2026, 4, 15, 12, 0, 0).getTime(); // May 15 2026, noon local
const day = 86_400_000;

// today (3 plays): Alpha x2, Beta x1
library.recordPlay(A, now - 1 * 60 * 60 * 1000);
library.recordPlay(A, now - 2 * 60 * 60 * 1000);
library.recordPlay(B, now - 30 * 60 * 1000);
// this week but not today: Gamma (May 12)
library.recordPlay(C, now - 3 * day);
// this month but not this week: Delta (May 3)
library.recordPlay(D, now - 12 * day);
// this year but not this month: Alpha (Feb 10)
library.recordPlay(A, new Date(2026, 1, 10, 9, 0, 0).getTime());
// previous year (all-time only): Gamma (Nov 2025)
library.recordPlay(C, new Date(2025, 10, 1, 20, 0, 0).getTime());

const wrapped = (range) => library.getWrappedStats({ range, now });

// --- totals per range ---
assert.equal(wrapped('day').totals.plays, 3, 'day: 3 plays today');
assert.equal(wrapped('day').totals.durationSec, 580, 'day: 200+200+180');
assert.equal(wrapped('week').totals.plays, 4, 'week: today (3) + Gamma May 12');
assert.equal(wrapped('month').totals.plays, 5, 'month: week (4) + Delta May 3');
assert.equal(wrapped('year').totals.plays, 6, 'year: month (5) + Alpha Feb 10');
assert.equal(wrapped('all').totals.plays, 7, 'all: year (6) + Gamma Nov 2025');

// --- labels ---
assert.equal(wrapped('day').label, 'Today');
assert.equal(wrapped('week').label, 'This Week');
assert.equal(wrapped('month').label, 'May 2026');
assert.equal(wrapped('year').label, '2026');
assert.equal(wrapped('all').label, 'All Time');

const all = wrapped('all');
// uniques
assert.equal(all.totals.uniqueTracks, 4, 'all: 4 distinct tracks');
assert.equal(all.totals.uniqueArtists, 3, 'all: 3 distinct artists');
// top tracks: Alpha (3) then Gamma (2)
assert.equal(all.topTracks[0].title, 'Alpha');
assert.equal(all.topTracks[0].plays, 3);
assert.equal(all.topTracks[1].title, 'Gamma');
assert.equal(all.topTracks[1].plays, 2);
// top artist: Artist One (Alpha 3 + Beta 1 = 4)
assert.equal(all.topArtists[0].artist, 'Artist One');
assert.equal(all.topArtists[0].plays, 4);
// genres: Synthwave (4) > Jazz (2) > Rock (1)
assert.deepEqual(all.genres.map((g) => [g.genre, g.plays]), [['Synthwave', 4], ['Jazz', 2], ['Rock', 1]]);
// listening clock sums to plays
assert.equal(all.listeningClock.reduce((s, n) => s + n, 0), 7, 'clock sums to total plays');
assert.equal(all.listeningClock.length, 24);
// busiest day is today (3 plays)
assert.ok(all.busiestDay && all.busiestDay.plays === 3, 'busiest day has 3 plays');

// --- discoveries (global first-play inside window) ---
// first plays: Alpha=Feb 2026, Beta=today(May), Gamma=Nov 2025, Delta=May 3.
assert.equal(wrapped('month').totals.discoveries, 2, 'month discoveries: Beta + Delta first-played in May');
assert.equal(wrapped('year').totals.discoveries, 3, 'year discoveries: Alpha + Beta + Delta first-played in 2026');
assert.equal(wrapped('all').totals.discoveries, 4, 'all discoveries: every track');

// no DNA seeded → taste is null and degrades gracefully
assert.equal(all.taste, null, 'taste null when no DNA present');

// empty range still returns a well-formed object
const future = library.getWrappedStats({ range: 'day', now: new Date(2099, 0, 1).getTime() });
assert.equal(future.totals.plays, 0);
assert.equal(future.topTracks.length, 0);
assert.equal(future.listeningClock.length, 24);

// --- wiring: IPC + view registration ---
const { readFile } = await import('node:fs/promises');
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const [main, preload, apiSrc, types, view, app, sidebar] = await Promise.all([
  read('electron/main.ts'),
  read('electron/preload.ts'),
  read('src/lib/api.ts'),
  read('shared/types.ts'),
  read('src/components/views/WrappedView.tsx'),
  read('src/App.tsx'),
  read('src/components/Sidebar.tsx'),
]);
assert.match(main, /ipcMain\.handle\(\s*'history:wrapped'/, 'main must handle history:wrapped');
assert.match(preload, /getWrappedStats:/, 'preload must expose getWrappedStats');
assert.match(apiSrc, /getWrappedStats: async/, 'api fallback must stub getWrappedStats');
assert.match(types, /export type WrappedRange/, 'types must define WrappedRange');
assert.match(view, /composeShareCard/, 'WrappedView must compose a shareable PNG card');
assert.match(view, /saveCaptureBytes|copyPngToClipboard/, 'WrappedView must reuse the capture save/clipboard path');
assert.match(app, /view === 'wrapped'/, 'App must route the wrapped view');
assert.match(sidebar, /id: 'wrapped'/, 'Sidebar must expose the Wrapped nav entry');

console.log(JSON.stringify({ ok: true, all: all.totals, month: wrapped('month').totals }, null, 2));
