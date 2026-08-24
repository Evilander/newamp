// Unit tests for LibraryStore query performance fixes (B1 de-N+1 ordering, and
// B2 getLibraryHealth caching). Builds electron to dist-electron, opens a temp
// LibraryStore, seeds via upsertTracks (no ffmpeg needed). Mirrors the setup of
// scripts/library-smoke.mjs. Run: npm run build:electron && node scripts/library-query-test.mjs
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
const RESULT = resolve(repoRoot, 'tmp/library-query-test-result.txt');
writeFileSync(RESULT, '[library-query-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const smokeRoot = join(repoRoot, 'tmp', 'library-query-test');
const dbPath = join(smokeRoot, 'library.db');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const lib = await LibraryStore.open(dbPath);

function track(i) {
  return {
    path: `/music/track-${i}.flac`,
    title: `Track ${i}`,
    artist: `Artist ${i % 7}`,
    album: `Album ${i % 13}`,
    albumArtist: `Artist ${i % 7}`,
    trackNo: i, discNo: 1, year: 2000 + (i % 20), genre: 'Test',
    duration: 180, bitrate: 1000, sampleRate: 44100,
    replayGainTrackDb: null, replayGainAlbumDb: null,
    size: 1000 + i, mtime: 1700000000 + i, art: null,
  };
}

const N = 1000;
lib.upsertTracks(Array.from({ length: N }, (_, k) => track(k + 1)));

const all = lib.getTracks({ limit: N + 10, offset: 0 });
const idByPath = new Map(all.map((t) => [t.path, t.id]));
const id = (i) => idByPath.get(`/music/track-${i}.flac`);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// Order preserved, DUPLICATES preserved (a queue may repeat a track), missing ids skipped.
// This matches the prior ids.map(getTrack).filter(Boolean) behavior.
const want = [id(5), id(1), id(5), 999999999, id(3)];
const got = lib.getTracksByIdsInOrder(want).map((t) => t.path);
log.push('B1 ordered result: ' + JSON.stringify(got));
if (JSON.stringify(got) !== JSON.stringify(['/music/track-5.flac', '/music/track-1.flac', '/music/track-5.flac', '/music/track-3.flac'])) {
  fail('B1 ordering/duplicate-preservation/missing-skip incorrect');
}
const ids = Array.from({ length: N }, (_, k) => id(k + 1));
const big = lib.getTracksByIdsInOrder(ids);
if (big.length !== N) fail(`B1 expected ${N} tracks, got ${big.length}`);
if (big[0].path !== '/music/track-1.flac' || big[N - 1].path !== `/music/track-${N}.flac`) fail('B1 large-request order wrong');

// B2: getLibraryHealth is cached and invalidated on write.
const h1 = lib.getLibraryHealth();
const h2 = lib.getLibraryHealth();
if (h2 !== h1) fail('B2 getLibraryHealth should return the SAME cached object reference on repeat calls');
lib.upsertTracks([track(N + 1)]);
const h3 = lib.getLibraryHealth();
if (h3 === h1) fail('B2 getLibraryHealth cache should be invalidated after upsertTracks');
log.push(`B2 cache: same-ref-before=${h2 === h1} new-ref-after-write=${h3 !== h1}`);

// B2b: a ReplayGain write also invalidates health (it feeds the RG-ready count).
const h3b = lib.getLibraryHealth(); // re-cache
lib.setTrackReplayGain(id(1), -6.5);
const h4 = lib.getLibraryHealth();
if (h4 === h3b) fail('B2 setTrackReplayGain should invalidate the health cache (RG-ready count)');
log.push(`B2b RG-write invalidates health: ${h4 !== h3b}`);

// B2c: a manual metadata edit (artist/album/year feed missing-metadata +
// duplicate detection) also invalidates health.
const h4b = lib.getLibraryHealth(); // re-cache
lib.applyManualMetadataPatch(id(2), { artist: 'Renamed Artist' });
const h5 = lib.getLibraryHealth();
if (h5 === h4b) fail('B2 applyManualMetadataPatch should invalidate the health cache');
log.push(`B2c manual-edit invalidates health: ${h5 !== h4b}`);

// LIKE escaping: a '%' or '_' in the search term must match itself literally,
// not act as a wildcard. Depends on every LIKE consuming an escapeLike()
// pattern carrying a matching ESCAPE clause.
{
  const special = [
    { n: 9001, title: 'Song 100% Live' },
    { n: 9002, title: 'under_score' },
    { n: 9003, title: 'underXscore' },
    { n: 9004, title: 'Plain Song' },
  ].map(({ n, title }) => ({
    path: `/music/special-${n}.flac`,
    title,
    artist: 'Escape Artist',
    album: 'Escape Album',
    albumArtist: 'Escape Artist',
    trackNo: 1, discNo: 1, year: 2020, genre: 'Test',
    duration: 100, bitrate: 1000, sampleRate: 44100,
    replayGainTrackDb: null, replayGainAlbumDb: null,
    size: 1000 + n, mtime: 1700000000 + n, art: null,
  }));
  lib.upsertTracks(special);

  const titlesFor = (search) =>
    lib.getTracks({ search, limit: 500 }).map((t) => t.title).sort();

  // Without ESCAPE '\' the escaped pattern degenerates and either matches
  // everything or nothing — here it must match ONLY the literal "100%".
  const pct = titlesFor('100%');
  if (JSON.stringify(pct) !== JSON.stringify(['Song 100% Live'])) {
    fail(`searching "100%" must match only the literal title, got ${JSON.stringify(pct)}`);
  }
  // '_' must not become a single-char wildcard: under_score != underXscore.
  const underscore = titlesFor('under_score');
  if (JSON.stringify(underscore) !== JSON.stringify(['under_score'])) {
    fail(`searching "under_score" must not match underXscore, got ${JSON.stringify(underscore)}`);
  }
  const albumHit = lib.getAlbums({ search: 'under_score' });
  if (albumHit.length !== 1 || albumHit[0].album !== 'Escape Album') {
    fail(`album search for "under_score" should surface Escape Album once, got ${JSON.stringify(albumHit.map((a) => a.album))}`);
  }
  log.push('LIKE escaping: literal %/_ matching verified');
}

// Album search matchedTrackTitles: GROUP_CONCAT joins with char(31); the
// split must use that unit separator so multi-title results render as whole
// titles ("A · B"), never as loose characters.
{
  const sep = String.fromCharCode(31);
  const multi = [1, 2].map((k) => ({
    path: `/music/sep-${k}.flac`,
    title: k === 1 ? 'Midnight Lullaby' : 'Sweet Lullaby',
    artist: 'Separator Artist',
    album: 'Separator Album',
    albumArtist: 'Separator Artist',
    trackNo: k, discNo: 1, year: 1999, genre: 'Test',
    duration: 200, bitrate: 1000, sampleRate: 44100,
    replayGainTrackDb: null, replayGainAlbumDb: null,
    size: 3000 + k, mtime: 1700000000 + k, art: null,
  }));
  lib.upsertTracks(multi);
  const hit = lib.getAlbums({ search: 'lullaby' }).find((a) => a.album === 'Separator Album');
  if (!hit) {
    fail('separator album should be found when searching its track titles');
  } else if (!hit.matchedOnTrack) {
    fail('Separator Album should report matchedOnTrack');
  } else if (
    !hit.matchedTrackTitles ||
    !hit.matchedTrackTitles.includes('Midnight Lullaby') ||
    !hit.matchedTrackTitles.includes('Sweet Lullaby') ||
    hit.matchedTrackTitles.includes(sep)
  ) {
    fail(
      'matchedTrackTitles must contain whole titles separated by " · ", got ' +
        JSON.stringify(hit.matchedTrackTitles),
    );
  } else {
    log.push(`matchedTrackTitles separator: "${hit.matchedTrackTitles}"`);
  }
}

// Rescan must not wipe UI-applied album art: upserting a changed file that
// has NO embedded art keeps the existing art instead of nulling it, while a
// file that DOES carry embedded art still replaces what was there.
{
  const uiArt = {
    mime: 'image/png',
    data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    ),
  };
  const embeddedArt = {
    mime: 'image/png',
    data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  };
  const base = (over) => ({
    path: '/music/art-carrier.flac',
    title: 'Art Carrier',
    artist: 'Art Artist',
    album: 'Art Album',
    albumArtist: 'Art Artist',
    trackNo: 1, discNo: 1, year: 2021, genre: 'Test',
    duration: 90, bitrate: 1000, sampleRate: 44100,
    replayGainTrackDb: null, replayGainAlbumDb: null,
    size: 4001, mtime: 1700000010, art: null,
    ...over,
  });
  lib.upsertTracks([base()]);
  const uiApplied = lib.applyAlbumArtToAlbum('Art Album', 'Art Artist', uiArt, 'test-ui');
  if (!uiApplied) {
    fail('UI art apply should succeed');
  } else {
    const withUiArt = lib.getTracks({ search: 'art carrier' })[0];
    if (withUiArt?.hasArt !== 1) fail('UI-applied art should mark the track as having art');
  }

  // "Rescan" the changed file — it still carries no embedded art.
  lib.upsertTracks([base({ mtime: 1700009999, title: 'Art Carrier v2' })]);
  const afterRescan = lib.getTracks({ search: 'art carrier v2' })[0];
  if (afterRescan?.hasArt !== 1) fail('rescan of an art-less file must preserve UI-applied art');
  const kept = afterRescan ? lib.getArt(afterRescan.id) : null;
  if (!kept || !kept.data.equals(uiArt.data)) fail('preserved art must be the UI-applied image');

  // A rescan where the file NOW embeds art replaces the preserved art.
  lib.upsertTracks([base({ mtime: 1700010000, art: embeddedArt })]);
  const afterEmbedded = lib.getTracks({ search: 'art carrier' })[0];
  const replaced = afterEmbedded ? lib.getArt(afterEmbedded.id) : null;
  if (!replaced || !replaced.data.equals(embeddedArt.data)) fail('embedded art from the file must win on rescan');
  log.push('rescan preserves UI-applied art; embedded art still wins');
}

const report = log.join('\n') + '\n' + (pass ? '[library-query-test] PASS' : '[library-query-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
