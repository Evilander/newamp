import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'history-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { name: '01-alpha.mp3', title: 'Alpha', artist: 'Alpha Artist', album: 'Alpha Album', duration: 180 },
  { name: '02-beta.mp3', title: 'Beta', artist: 'Beta Artist', album: 'Beta Album', duration: 240 },
  { name: '03-gamma.mp3', title: 'Gamma', artist: 'Gamma Artist', album: 'Gamma Album', duration: 120 },
];

for (const fixture of fixtures) await writeFile(join(musicRoot, fixture.name), '');

const library = await LibraryStore.open(dbPath);
library.upsertTracks(fixtures.map((fixture, index) => ({
  path: join(musicRoot, fixture.name),
  title: fixture.title,
  artist: fixture.artist,
  album: fixture.album,
  albumArtist: fixture.artist,
  trackNo: index + 1,
  discNo: null,
  year: 2026,
  genre: 'Smoke',
  duration: fixture.duration,
  bitrate: null,
  sampleRate: null,
  bpm: null,
  key: null,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 0,
  mtime: Date.now(),
  art: null,
})));

const tracks = library.getTracks({ sort: 'album', limit: 10 });
const alpha = tracks.find((track) => track.title === 'Alpha');
const beta = tracks.find((track) => track.title === 'Beta');
const gamma = tracks.find((track) => track.title === 'Gamma');
assert.ok(alpha && beta && gamma, 'fixture tracks should exist');

const now = Date.UTC(2026, 4, 15, 12, 0, 0);
const dayMs = 24 * 60 * 60 * 1000;
const alphaToday = now - 60 * 60 * 1000;
const betaYesterday = now - dayMs;
const alphaThisWeek = now - 2 * dayMs;
const gammaOlder = now - 10 * dayMs;
const betaSkipToday = now - 30 * 60 * 1000;
const gammaSkipYesterday = now - dayMs + 60 * 60 * 1000;

library.recordPlay(alpha.id, gammaOlder);
library.recordPlay(beta.id, betaYesterday);
library.recordPlay(alpha.id, alphaToday);
library.recordSkip(beta.id, betaSkipToday, 18);
library.recordSkip(gamma.id, gammaSkipYesterday, 12);

const history = library.getListeningHistory({ limit: 10 });
assert.deepEqual(history.map((item) => item.track.title), ['Alpha', 'Beta', 'Alpha']);
assert.deepEqual(history.map((item) => item.playedAt), [alphaToday, betaYesterday, gammaOlder]);
assert.equal(history[0].track.playCount, 2);
assert.equal(library.getListeningHistory({ limit: 1 })[0].track.title, 'Alpha');

library.recordPlay(gamma.id, alphaThisWeek);
assert.deepEqual(library.getListeningHistory({ limit: 4 }).map((item) => item.track.title), [
  'Alpha',
  'Beta',
  'Gamma',
  'Alpha',
]);
assert.deepEqual(library.getListeningHistory({ limit: 2, offset: 0 }).map((item) => item.track.title), [
  'Alpha',
  'Beta',
]);
assert.deepEqual(library.getListeningHistory({ limit: 2, offset: 2 }).map((item) => item.track.title), [
  'Gamma',
  'Alpha',
]);

const insights = library.getListeningInsights({ now });
assert.equal(insights.generatedAt, now);
assert.equal(library.getListeningInsights({ now: 0 }).generatedAt, 0, 'explicit zero timestamp should be preserved');
assert.deepEqual(insights.total, {
  plays: 4,
  duration: 720,
  skips: 2,
  uniqueTracks: 3,
  uniqueSkippedTracks: 2,
  firstPlayedAt: gammaOlder,
  lastPlayedAt: alphaToday,
  lastSkippedAt: betaSkipToday,
});
assert.deepEqual(insights.today, { plays: 1, duration: 180, skips: 1 });
assert.deepEqual(insights.week, { plays: 3, duration: 540, skips: 2 });
assert.deepEqual(insights.topArtists.map((item) => [item.artist, item.plays, item.duration, item.skips]), [
  ['Alpha Artist', 2, 360, 0],
  ['Beta Artist', 1, 240, 1],
  ['Gamma Artist', 1, 120, 1],
]);
assert.deepEqual(insights.topAlbums.map((item) => [item.album, item.albumArtist, item.plays]), [
  ['Alpha Album', 'Alpha Artist', 2],
  ['Beta Album', 'Beta Artist', 1],
  ['Gamma Album', 'Gamma Artist', 1],
]);
assert.deepEqual(
  insights.topAlbums.map((item) => [item.album, item.albumArtist, item.skips]),
  [
    ['Alpha Album', 'Alpha Artist', 0],
    ['Beta Album', 'Beta Artist', 1],
    ['Gamma Album', 'Gamma Artist', 1],
  ],
);
assert.deepEqual(insights.recentDays.map((item) => item.date), [
  localDateKey(alphaToday),
  localDateKey(betaYesterday),
  localDateKey(alphaThisWeek),
  localDateKey(gammaOlder),
]);
assert.deepEqual(insights.recentDays.map((item) => [item.date, item.skips]), [
  [localDateKey(alphaToday), 1],
  [localDateKey(betaYesterday), 1],
  [localDateKey(alphaThisWeek), 0],
  [localDateKey(gammaOlder), 0],
]);
library.clearListeningHistory();
assert.equal(library.getListeningHistory({ limit: 10 }).length, 0);
assert.equal(library.getListeningInsights({ now }).total.plays, 0);
assert.equal(library.getListeningInsights({ now }).total.skips, 0);
assert.equal(library.getTrack(alpha.id)?.playCount, 2, 'clearing event history should not erase aggregate play counts');
assert.equal(library.getTrack(beta.id)?.skipCount, 1, 'clearing event history should not erase aggregate skip counts');
library.close();

const [sharedTypes, mainSource, preloadSource, apiSource, appSource, sidebarSource, historyViewSource, storeSource, releaseGateSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/HistoryView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
  ]);

assert.match(sharedTypes, /ListeningHistoryItem/, 'shared API should expose listening history items');
assert.match(sharedTypes, /ListeningInsights/, 'shared API should expose listening insights');
assert.match(sharedTypes, /skipCount/, 'shared Track type should expose aggregate skip counts');
assert.match(sharedTypes, /recordSkip/, 'shared API should expose skip recording');
assert.match(mainSource, /history:get/, 'main process should register history IPC');
assert.match(mainSource, /history:insights/, 'main process should register history insights IPC');
assert.match(mainSource, /library:record-skip/, 'main process should register skip recording IPC');
assert.match(preloadSource, /getListeningHistory/, 'preload should expose getListeningHistory');
assert.match(preloadSource, /getListeningInsights/, 'preload should expose getListeningInsights');
assert.match(preloadSource, /recordSkip/, 'preload should expose recordSkip');
assert.match(apiSource, /clearListeningHistory/, 'renderer API should expose history clearing');
assert.match(apiSource, /getListeningInsights/, 'renderer API should expose listening insights');
assert.match(apiSource, /recordSkip/, 'renderer API should expose skip recording');
assert.match(appSource, /HistoryView/, 'App should render the history view');
assert.match(sidebarSource, /History/, 'Sidebar should include History navigation');
assert.match(historyViewSource, /Listening History/, 'History view should render the listening history surface');
assert.match(historyViewSource, /HistoryInsights/, 'History view should render listening insights');
assert.match(historyViewSource, /Top Artists/, 'History view should show top artist insights');
assert.match(historyViewSource, /Recent Days/, 'History view should show recent-day activity');
assert.match(historyViewSource, /skip/i, 'History insights should expose skip behavior');
assert.match(historyViewSource, /playQueue/, 'History view should replay from a history row');
assert.match(historyViewSource, /const HISTORY_PAGE_SIZE = 500/, 'History view should centralize its page size');
assert.match(historyViewSource, /limit: HISTORY_PAGE_SIZE \+ 1/, 'History view should over-fetch to detect more history');
assert.match(historyViewSource, /offset: items\.length/, 'History view should request later history pages by loaded row count');
assert.match(historyViewSource, /hasMoreHistory/, 'History view should track whether more listening history exists');
assert.match(historyViewSource, /Load more history/, 'History view should expose explicit history pagination');
assert.match(storeSource, /recordManualSkip/, 'player store should record manual early skips');
assert.match(storeSource, /api\.recordSkip/, 'player store should call the skip recording API');
assert.match(releaseGateSource, /smoke:history/, 'release gate should include the history smoke');

console.log(JSON.stringify({
  ok: true,
  history: history.map((item) => ({ title: item.track.title, playedAt: item.playedAt })),
  insights: {
    total: insights.total,
    today: insights.today,
    week: insights.week,
    topArtist: insights.topArtists[0],
  },
}, null, 2));

function localDateKey(value) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}
