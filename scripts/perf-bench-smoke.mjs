// Performance regression smoke. Synthesizes a 60 000-track library, stamps
// DNA on 12 000 of them, then asserts the hot paths complete inside time
// budgets that are forgiving on a low-end Linux laptop and tight on a modern
// desktop. The point is to catch a 5× regression, not to micro-benchmark.
//
// Run on a quiet machine; numbers drift under contention.

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeDir = join(repoRoot, 'tmp', `perf-bench-${process.pid}-${Date.now()}`);
const dbPath = join(smokeDir, 'library.db');
await rm(smokeDir, { recursive: true, force: true });
const { mkdir } = await import('node:fs/promises');
await mkdir(smokeDir, { recursive: true });

const TRACK_COUNT = 60_000;
const DNA_COUNT = 12_000;

// Budgets are intentionally loose enough for ~2× slowdown on weaker
// hardware (we test against actual Tyler-class numbers locally; CI may be
// slower). If something blows past these, the recompute or DNA cache
// regressed.
const BUDGETS_MS = {
  insertTracks: 2500,
  stampDna: 4000,
  getAllTrackDna: 250,
  findSimilar: 500,
  recomputeTags: 4000,
  previewTagRule: 800,
};

const fixtures = [];
for (let i = 0; i < TRACK_COUNT; i++) {
  fixtures.push({
    path: `B:/perf-bench/track-${String(i).padStart(6, '0')}.flac`,
    title: `Track ${i}`,
    artist: 'Bench',
    album: `Album ${Math.floor(i / 20)}`,
    albumArtist: 'Bench',
    trackNo: i % 20,
    discNo: null,
    year: 2020,
    genre: i % 2 === 0 ? 'Synth' : 'Rock',
    duration: 180,
    bitrate: 320000,
    sampleRate: 44100,
    bpm: 80 + (i % 100),
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1024,
    mtime: i * 1000,
    art: null,
  });
}

const library = await LibraryStore.open(dbPath);
const measured = {};

measured.insertTracks = await time(() => library.upsertTracks(fixtures));
assertBudget('insertTracks', measured.insertTracks);

const ids = library.getTrackIds({ limit: DNA_COUNT, sort: 'artist' });
measured.stampDna = await time(() => {
  for (const id of ids) {
    library.setTrackDna(id, {
      v: 1,
      framesAnalyzed: 60,
      secondsAnalyzed: 3,
      rms: pseudoRandom(id, 0),
      dynamicRange: pseudoRandom(id, 1),
      brightness: pseudoRandom(id, 2),
      flatness: pseudoRandom(id, 3),
      bands: [
        pseudoRandom(id, 4),
        pseudoRandom(id, 5),
        pseudoRandom(id, 6),
        pseudoRandom(id, 7),
        pseudoRandom(id, 8),
      ],
      onsetDensity: pseudoRandom(id, 9),
      rolloff: pseudoRandom(id, 10),
    });
  }
});
assertBudget('stampDna', measured.stampDna);

let allDnaSize = 0;
measured.getAllTrackDna = await time(() => {
  allDnaSize = library.getAllTrackDna().length;
});
assert.equal(allDnaSize, DNA_COUNT);
assertBudget('getAllTrackDna', measured.getAllTrackDna);

let similarSize = 0;
measured.findSimilar = await time(() => {
  similarSize = library.findSimilarTracks(ids[0], 20).length;
});
assert.equal(similarSize, 20);
assertBudget('findSimilar', measured.findSimilar);

library.saveTagRule({ name: 'fast_tracks', body: 'tag(fast_tracks) when bpm > 120' });
library.saveTagRule({ name: 'mid_energy', body: 'tag(mid_energy) when dna.energy in 0.3..0.7' });

let recomputeResult = null;
measured.recomputeTags = await time(() => {
  recomputeResult = library.recomputeTags();
});
assert.equal(recomputeResult.tracksEvaluated, TRACK_COUNT);
assert.equal(recomputeResult.rulesEvaluated, 2);
assertBudget('recomputeTags', measured.recomputeTags);

let previewMatched = 0;
measured.previewTagRule = await time(() => {
  const preview = library.previewTagRule({ body: 'tag(probe) when bpm > 130', limit: 5000 });
  previewMatched = preview.matchCount;
});
assert.ok(previewMatched > 0, 'preview should match some tracks');
assertBudget('previewTagRule', measured.previewTagRule);

library.close();

console.log(JSON.stringify({
  ok: true,
  trackCount: TRACK_COUNT,
  dnaCount: DNA_COUNT,
  durations_ms: measured,
  budgets_ms: BUDGETS_MS,
  headroom: Object.fromEntries(
    Object.keys(BUDGETS_MS).map((k) => [k, +(BUDGETS_MS[k] / Math.max(1, measured[k])).toFixed(2)]),
  ),
  tagsAssigned: recomputeResult.tagsAssigned,
  previewMatched,
}, null, 2));

async function time(fn) {
  const start = Date.now();
  const out = await fn();
  void out;
  return Date.now() - start;
}

function assertBudget(label, ms) {
  const budget = BUDGETS_MS[label];
  if (ms > budget) {
    throw new Error(`${label} blew its budget: ${ms} ms > ${budget} ms (recompute/DNA cache regression?)`);
  }
}

function pseudoRandom(id, salt) {
  const v = (id * 2654435761 + salt * 16777619) >>> 0;
  return (v & 0xffffff) / 0xffffff;
}
