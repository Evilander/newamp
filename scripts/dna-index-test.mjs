// The DNA index behind seeded mixes once the whole library has DNA:
//  - it is read in pages, handing the main thread back between them, and
//    holds exactly what getAllTrackDna() returns;
//  - DNA saved by the background analysis goes into a built index instead of
//    throwing it away, so a run that saves every few seconds doesn't make the
//    next mix read every track again;
//  - DNA saved while the index is being built starts the build again, so no
//    page read before the save keeps the old value.
// Run: npm run build:electron && node scripts/dna-index-test.mjs
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'dna-index-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const TRACKS = 4500;
const dna = (rms) => ({ v: 1, framesAnalyzed: 10, secondsAnalyzed: 1, rms, dynamicRange: 0.1, brightness: 0.4, flatness: 0.2, bands: [0.2, 0.2, 0.2, 0.2, 0.2], onsetDensity: 0.3, rolloff: 0.5 });
const incoming = (i) => ({
  path: `/music/a${i % 30}/b${i % 90}/t${i}.mp3`, title: `T${i}`, artist: `A${i % 30}`, album: `B${i % 90}`, albumArtist: `A${i % 30}`,
  trackNo: null, discNo: null, year: null, genre: null, duration: 200, bitrate: null, sampleRate: null,
  replayGainTrackDb: null, replayGainAlbumDb: null, size: 1000, mtime: 1, art: null,
});

const store = await LibraryStore.open(join(root, 'library.db'));
store.upsertTracks(Array.from({ length: TRACKS }, (_, i) => incoming(i)));
const ids = store.db.exec('SELECT id FROM tracks ORDER BY id')[0].values.map((r) => r[0]);
store.saveAnalysis(ids.map((id, i) => ({ id, dna: dna(0.1 + (i % 50) / 100), touched: ['dna'] })));

// 1. Built in pages, and the same as reading every row at once.
store.invalidateDnaIndexCache();
const steps = store.dnaIndexSteps();
let turns = 0;
let next = steps.next();
while (!next.done) {
  turns += 1;
  next = steps.next();
}
const index = next.value;
assert.ok(turns >= 2, `${TRACKS} tracks take more than one page (turns handed back: ${turns})`);
const all = store.getAllTrackDna();
assert.equal(index.size, all.length);
for (const row of all) assert.deepEqual(index.get(row.id), row.dna);

// 2. An analysis save updates the built index in place.
store.saveAnalysis([{ id: ids[7], dna: dna(0.99), touched: ['dna'] }]);
assert.equal(store.buildDnaIndex(), index, 'the built index is kept');
assert.equal(index.get(ids[7]).rms, 0.99, 'and holds the new value');

// 3. A save during a build restarts it, so an early page can't keep old DNA.
store.invalidateDnaIndexCache();
const restarting = store.dnaIndexSteps();
restarting.next(); // the first page (ids[0] onwards) has been read
store.saveAnalysis([{ id: ids[3], dna: dna(0.42), touched: ['dna'] }]);
let done = restarting.next();
while (!done.done) done = restarting.next();
assert.equal(done.value.get(ids[3]).rms, 0.42, 'the restarted build reads the new value');
assert.equal(done.value.size, TRACKS);

store.close();
await rm(root, { recursive: true, force: true });
console.log(`[dna-index-test] PASS: ${TRACKS} tracks in ${turns + 1} pages, saves update a built index, a save mid-build restarts it`);
