import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HISTORY_IMPORT_MAX_ENTRIES,
  fetchLastfmHistory,
  LastfmHistoryImportTruncatedError,
  parseHistoryImport,
} from '../dist-electron/electron/history-import.js';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'history-import-test');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { name: '01-alpha.mp3', title: 'Alpha', artist: 'Alpha Artist', album: 'Alpha Album', duration: 180 },
  { name: '02-beta.mp3', title: 'Beta', artist: 'Beta Artist', album: 'Beta Album', duration: 220 },
  { name: '03-collide-left.mp3', title: 'Shared Title', artist: 'Collision', album: 'Left Album', duration: 200 },
  { name: '04-collide-right.mp3', title: 'Shared Title', artist: 'Collision', album: 'Right Album', duration: 200 },
  { name: '05-unicode.mp3', title: '東京', artist: '宇多田ヒカル', album: 'First Love', duration: 240 },
  { name: '06-accent.mp3', title: 'Canción', artist: 'Acento', album: 'Exact', duration: 240 },
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
  genre: 'Import',
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

const beta = library.getTracks({ search: 'Beta', limit: 1 })[0];
assert.ok(beta, 'fixture beta track should exist');
const oldPlayAt = Date.UTC(2026, 0, 1, 9, 0, 0);
library.recordPlay(beta.id, oldPlayAt);

const alphaPath = join(musicRoot, '01-alpha.mp3');
const csvText = [
  'played_at,path,artist,title,album,play_count',
  `"2026-05-15T12:00:00.000Z","${alphaPath}","Wrong Artist","Wrong Title","Wrong Album","48"`,
  '"1778846460000","","Beta Artist","Beta","Beta Album","12"',
  '"1778846460000","","Beta Artist","Beta","Beta Album","12"',
  '"2026-05-15T12:03:00.000Z","","Collision","Shared Title","","1"',
  '"2026-05-15T12:04:00.000Z","","Missing","Track","Album","1"',
  '"","","Alpha Artist","Alpha","Alpha Album","9"',
].join('\n');

assert.equal(HISTORY_IMPORT_MAX_ENTRIES, 500000);

const parsedCsv = parseHistoryImport(csvText, 'csv');
assert.equal(parsedCsv.entries.length, 5, 'CSV parser should keep only rows with real timestamps');
assert.equal(parsedCsv.invalid, 1, 'CSV parser should reject rows without timestamps instead of inventing dates');
assert.equal(parsedCsv.entries[0].playedAt, Date.UTC(2026, 4, 15, 12, 0, 0));

const importResult = library.importListeningHistory(parsedCsv.entries);
assert.deepEqual(
  pickCounts(importResult),
  { imported: 2, duplicates: 1, unmatched: 1, ambiguous: 1, invalid: 0 },
  'import should report exact event outcomes',
);
assert.equal(library.getTrack(beta.id)?.playCount, 2, 'existing plays should be preserved and imported events added');
assert.equal(library.getTrack(beta.id)?.lastPlayed, 1778846460000);
assert.equal(library.getListeningHistory({ limit: 10 }).length, 3);

const repeated = library.importListeningHistory(parsedCsv.entries);
assert.deepEqual(
  pickCounts(repeated),
  { imported: 0, duplicates: 3, unmatched: 1, ambiguous: 1, invalid: 0 },
  're-importing the same events should be idempotent',
);

const jsonText = JSON.stringify({
  history: [
    { playedAt: '2026-05-15T12:05:00.000Z', artist: 'Collision', title: 'Shared Title', album: 'Right Album' },
    { playedAt: '2026-05-15T12:06:00.000Z', artist: '宇多田ヒカル', title: '東京', album: 'First Love' },
    { playedAt: '2026-05-15T12:07:00.000Z', artist: 'Acento', title: 'Cancion', album: 'Exact' },
  ],
});
const parsedJson = parseHistoryImport(jsonText, 'json');
const jsonResult = library.importListeningHistory(parsedJson.entries);
assert.deepEqual(pickCounts(jsonResult), { imported: 2, duplicates: 0, unmatched: 1, ambiguous: 0, invalid: 0 });

assert.throws(
  () => library.importListeningHistory(Array.from({ length: HISTORY_IMPORT_MAX_ENTRIES + 1 }, (_, index) => ({
    playedAt: 1778847000000 + index,
    artist: 'Alpha Artist',
    title: 'Alpha',
    album: 'Alpha Album',
  }))),
  /limited to 500,000 entries/,
);

const fetched = await fetchLastfmHistory({
  username: 'public-user',
  apiKey: 'public-api-key',
  toUnixSeconds: 1778846900,
  maxPages: 5,
  fetchImpl: async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('method'), 'user.getrecenttracks');
    assert.equal(parsed.searchParams.get('limit'), '200');
    assert.equal(parsed.searchParams.get('format'), 'json');
    assert.equal(parsed.searchParams.get('to'), '1778846900');
    const page = Number(parsed.searchParams.get('page'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        recenttracks: {
          '@attr': { page: String(page), totalPages: '2' },
          track: page === 1
            ? [
                {
                  artist: { '#text': 'Alpha Artist' },
                  name: 'Alpha',
                  album: { '#text': 'Alpha Album' },
                  date: { uts: '1778846760' },
                },
                {
                  '@attr': { nowplaying: 'true' },
                  artist: { '#text': 'Beta Artist' },
                  name: 'Beta',
                  album: { '#text': 'Beta Album' },
                },
              ]
            : [{
                artist: { '#text': 'Beta Artist' },
                name: 'Beta',
                album: { '#text': 'Beta Album' },
                date: { uts: '1778846820' },
              }],
        },
      }),
    };
  },
});
assert.equal(fetched.pagesFetched, 2, 'Last.fm recenttracks import should fetch all reported pages');
assert.equal(fetched.entries.length, 2, 'Last.fm currently-playing rows without date should not become imported plays');
assert.equal(fetched.invalid, 0);
assert.equal(fetched.skippedNowPlaying, 1);

await assert.rejects(
  () => fetchLastfmHistory({
    username: 'public-user',
    apiKey: 'public-api-key',
    toUnixSeconds: 1778846900,
    maxPages: 1,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        recenttracks: {
          '@attr': { page: '1', totalPages: '2' },
          track: [{
            artist: { '#text': 'Alpha Artist' },
            name: 'Alpha',
            album: { '#text': 'Alpha Album' },
            date: { uts: '1778846760' },
          }],
        },
      }),
    }),
  }),
  (err) => err instanceof LastfmHistoryImportTruncatedError && err.partial.truncated === true,
);

await assert.rejects(
  () => fetchLastfmHistory({
    username: 'public-user',
    apiKey: 'public-api-key',
    toUnixSeconds: 1778846900,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ recenttracks: {} }),
    }),
  }),
  /malformed recenttracks/,
);

const beforeRollbackCount = library.getListeningHistory({ limit: 100 }).length;
const beforeRollbackAlpha = library.getTracks({ search: 'Alpha', limit: 1 })[0];
assert.ok(beforeRollbackAlpha, 'fixture alpha track should exist');
const originalRun = library.db.run.bind(library.db);
let tripped = false;
library.db.run = (sql, params) => {
  if (!tripped && String(sql).includes('INSERT INTO play_history')) {
    tripped = true;
    throw new Error('forced insert failure');
  }
  return originalRun(sql, params);
};
assert.throws(
  () => library.importListeningHistory(parseHistoryImport(
    JSON.stringify([{ played_at: '2026-05-15T12:06:00.000Z', artist: 'Alpha Artist', title: 'Alpha', album: 'Alpha Album' }]),
    'json',
  ).entries),
  /forced insert failure/,
);
library.db.run = originalRun;
assert.equal(library.getListeningHistory({ limit: 100 }).length, beforeRollbackCount, 'failed imports should roll back play_history');
assert.equal(library.getTrack(beforeRollbackAlpha.id)?.playCount, beforeRollbackAlpha.playCount, 'failed imports should roll back play_count');

const pendingFlush = library.flushAsync();
await library.flushPendingWrites();
await pendingFlush;
library.close();
const reloaded = await LibraryStore.open(dbPath);
assert.equal(reloaded.getListeningHistory({ limit: 100 }).length, beforeRollbackCount, 'flushPendingWrites should persist imported history before reopen');
reloaded.close();

console.log(JSON.stringify({ ok: true, importResult, lastfm: { pagesFetched: fetched.pagesFetched } }, null, 2));

function pickCounts(result) {
  return {
    imported: result.imported,
    duplicates: result.duplicates,
    unmatched: result.unmatched,
    ambiguous: result.ambiguous,
    invalid: result.invalid,
  };
}
