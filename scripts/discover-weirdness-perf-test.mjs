// weirdnessScore used to re-scan the entire library (tracks.filter over all
// n tracks) once per track being scored on the Weird Shelf, which is itself
// an O(n)-sized subset (every track with playCount <= 1) on a library that's
// mostly unplayed — an O(n^2) main-thread stall at real (60k+ track) library
// sizes. This builds a synthetic library large enough that the old behavior
// would take seconds and the fixed O(n) behavior finishes near-instantly,
// then asserts on wall-clock time plus that the ranking is still correct.
// Run with: npm run test:discover-weirdness-perf

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = resolve('tmp', 'discover-weirdness-perf-test');
await mkdir(outDir, { recursive: true });
const outfile = join(outDir, 'discover.mjs');
await build({
  entryPoints: [resolve('shared', 'discover.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const { buildDiscoverSurface } = await import(pathToFileURL(outfile).toString());

const GENRES = Array.from({ length: 40 }, (_, i) => `Genre ${i}`);
const TRACK_COUNT = 12000;
const now = Date.UTC(2026, 4, 17, 12, 0, 0);

function track(i) {
  return {
    id: i + 1,
    path: `B:/music/track-${i}.mp3`,
    title: `Track ${i}`,
    artist: `Artist ${i % 500}`,
    album: `Album ${i % 800}`,
    albumArtist: `Artist ${i % 500}`,
    trackNo: (i % 12) + 1,
    discNo: 1,
    year: 1970 + (i % 55),
    // A single rare genre stands out against 40 common ones so the ranking
    // assertion below can tell a real score computation from a broken one.
    genre: i === 0 ? 'Solo Rarity' : GENRES[i % GENRES.length],
    duration: 180 + (i % 120),
    bitrate: 320000,
    sampleRate: 44100,
    size: 4_000_000,
    mtime: now - i * 1000,
    hasArt: 0,
    loved: 0,
    rating: 0,
    ratingScore: null,
    avoidAutoPlay: 0,
    // Mostly unplayed — the worst case for the Weird Shelf's O(n) pre-filter.
    // (i > 0 so track 0, the rarity-ranking anchor below, stays unplayed.)
    playCount: i > 0 && i % 37 === 0 ? 5 : 0,
    lastPlayed: null,
    skipCount: 0,
    lastSkipped: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
  };
}

const tracks = Array.from({ length: TRACK_COUNT }, (_, i) => track(i));

const startedAt = performance.now();
const surface = buildDiscoverSurface({ tracks, now, limit: 12, seed: 'perf-test' });
const elapsedMs = performance.now() - startedAt;

// Generous ceiling: the O(n) fix finishes in tens of milliseconds for 12k
// tracks. The prior O(n^2) genre-count rescan took multiple seconds at this
// size (and scales quadratically — a 60k-track library would be ~25x worse
// again), so this threshold only passes for the fixed, linear version.
assert.ok(
  elapsedMs < 3000,
  `buildDiscoverSurface over ${TRACK_COUNT} tracks took ${elapsedMs.toFixed(0)}ms — expected well under 3000ms for the O(n) weirdnessScore fix`,
);

const weirdShelfCard = surface.cards.find((card) => card.id === 'weird-shelf');
assert.ok(weirdShelfCard, 'discover surface should include a weird shelf card');
assert.ok(weirdShelfCard.tracks.length > 0, 'weird shelf should not be empty for this fixture');
// Track 0 has a genre unique to itself (rarest possible) and is unplayed —
// it should rank at or near the top of the weird shelf. This would fail if
// the O(1) map lookup were wired to the wrong key or always returned the
// same count (a correctness regression the perf fix could easily introduce).
const rarityIndex = weirdShelfCard.tracks.findIndex((t) => t.id === 1);
assert.ok(rarityIndex >= 0 && rarityIndex < 3, `the uniquely-genred unplayed track should rank near the top of the weird shelf, got index ${rarityIndex}`);

// --- Source assertion: the O(n) fix (a precomputed genre map, not a
// tracks.filter() rescan per track) must actually be in place.
const discoverSource = await readFile(new URL('../shared/discover.ts', import.meta.url), 'utf8');
assert.match(discoverSource, /function buildGenreCounts\(/, 'discover.ts should precompute genre counts once');
assert.doesNotMatch(
  discoverSource,
  /tracks\.filter\(\(item\) => \(item\.genre/,
  'weirdnessScore should no longer rescan the full tracks array per call',
);

console.log(JSON.stringify({ ok: true, elapsedMs: Math.round(elapsedMs), trackCount: TRACK_COUNT }, null, 2));
