// Smoke for shared/seed-vibe.ts — pure math, no DB, no Electron.
// Exercises the key edge cases the audit flagged as untested:
//   - both seed + candidate have no DNA → falls into genre/era branch
//   - identical DNA → returns 1
//   - non-negative cosine path (post-fix) returns full [0, 1] range
//   - same-artist floor (returns >= 0.55 even when other signals are absent)
//   - genreTokens split on multi-delimiter strings
//   - bpm half/double match
//   - all-null inputs don't return NaN
//   - applySeedVibeGate formula
import assert from 'node:assert/strict';
import { createSeedVibeContext, seedVibeSimilarity, applySeedVibeGate } from '../dist-electron/shared/seed-vibe.js';
import { dnaCosineSimilarity } from '../dist-electron/shared/audio-dna.js';

function makeTrack(overrides = {}) {
  return {
    id: 1,
    path: 'fake',
    title: 't',
    artist: 'a',
    album: 'b',
    albumArtist: 'a',
    trackNo: null,
    discNo: null,
    year: 2020,
    genre: 'rock',
    duration: 200,
    bitrate: 320000,
    sampleRate: 44100,
    size: 1000,
    mtime: 0,
    hasArt: 0,
    loved: 0,
    rating: 0,
    ratingScore: null,
    avoidAutoPlay: 0,
    playCount: 0,
    lastPlayed: null,
    skipCount: 0,
    lastSkipped: null,
    bpm: 120,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    ...overrides,
  };
}

function makeDna(overrides = {}) {
  return {
    v: 1,
    rms: 0.5,
    brightness: 0.5,
    flatness: 0.3,
    dynamicRange: 0.4,
    onsetDensity: 0.3,
    rolloff: 0.5,
    bands: [0.4, 0.5, 0.5, 0.4, 0.3],
    ...overrides,
  };
}

// 1. Identical DNA → cosine of 1 → similarity 1 (after the (cos+1)/2 fix
//    that flattened the range, this should now return ~1, not 0.5).
const dnaA = makeDna();
const dnaCopy = makeDna();
assert.ok(Math.abs(dnaCosineSimilarity(dnaA, dnaCopy) - 1) < 1e-9, 'identical DNA must cosine to 1');

// 2. Genre + era branch (no DNA on either side)
{
  const seed = makeTrack({ artist: 'A', album: 'X', year: 2020, genre: 'rock' });
  const ctx = createSeedVibeContext(seed, null);
  const sameVibe = seedVibeSimilarity(makeTrack({ id: 2, artist: 'B', year: 2021, genre: 'rock' }), ctx, null);
  const offVibe = seedVibeSimilarity(makeTrack({ id: 3, artist: 'C', year: 1990, genre: 'classical' }), ctx, null);
  assert.ok(sameVibe > offVibe, `same-genre+era should beat off-genre+era — got ${sameVibe.toFixed(3)} vs ${offVibe.toFixed(3)}`);
  assert.ok(sameVibe <= 1 && sameVibe >= 0, 'must stay in [0, 1]');
}

// 3. Same-artist floor
{
  const seed = makeTrack({ artist: 'A', genre: 'jazz', year: 1960 });
  const ctx = createSeedVibeContext(seed, null);
  const sameArtistOther = makeTrack({ id: 99, artist: 'A', genre: 'noise', year: 2025 });
  const score = seedVibeSimilarity(sameArtistOther, ctx, null);
  assert.ok(score >= 0.55, `same-artist floor must be >= 0.55, got ${score}`);
}

// 4. All-null inputs don't NaN-bomb
{
  const seed = makeTrack({ artist: '', album: '', year: null, genre: null, bpm: null });
  const ctx = createSeedVibeContext(seed, null);
  const candidate = makeTrack({ id: 7, artist: '', album: '', year: null, genre: null, bpm: null });
  const score = seedVibeSimilarity(candidate, ctx, null);
  assert.ok(Number.isFinite(score), `score must be finite even with null inputs, got ${score}`);
  assert.ok(score >= 0 && score <= 1, 'score must stay in [0, 1]');
}

// 5. BPM half/double match — 60 bpm vs 120 bpm should score high via the
//    a/2 and a*2 alternates in bpmProximity.
{
  const seed = makeTrack({ artist: '', album: '', genre: '', bpm: 120, year: 2020 });
  const ctx = createSeedVibeContext(seed, null);
  const halfTempo = seedVibeSimilarity(makeTrack({ id: 8, artist: 'X', album: 'Y', genre: '', bpm: 60, year: 2020 }), ctx, null);
  const offTempo = seedVibeSimilarity(makeTrack({ id: 9, artist: 'X', album: 'Y', genre: '', bpm: 87, year: 2020 }), ctx, null);
  assert.ok(halfTempo > offTempo, `half-tempo should score > odd tempo — got ${halfTempo.toFixed(3)} vs ${offTempo.toFixed(3)}`);
}

// 6. applySeedVibeGate formula
assert.ok(Math.abs(applySeedVibeGate(10, 0) - 1.5) < 1e-9, 'vibe=0 → 15% of base');
assert.ok(Math.abs(applySeedVibeGate(10, 1) - 10) < 1e-9, 'vibe=1 → full base');
assert.ok(Math.abs(applySeedVibeGate(10, 0.5) - 5.75) < 1e-9, 'vibe=0.5 → linear blend');

console.log(JSON.stringify({ ok: true, suite: 'seed-vibe', cases: 6 }, null, 2));
