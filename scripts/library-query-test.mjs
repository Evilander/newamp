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

const report = log.join('\n') + '\n' + (pass ? '[library-query-test] PASS' : '[library-query-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
