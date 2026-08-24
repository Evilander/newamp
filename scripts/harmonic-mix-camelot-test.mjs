// parseKey's Camelot branch computed circleIndex as (camelotNumber - 1) — a
// different numbering scheme than the letter-name branch's
// CIRCLE.indexOf(root), so a Camelot-notated key and its letter-notated
// equivalent (e.g. "8B" and "C") scored as a "distant key" (0.24) instead of
// the same/relative key they actually are. Traced by hand against the
// standard Camelot wheel: 8B=C major, 8A=A minor (its relative minor).
// Run: npm run build:electron && node scripts/harmonic-mix-camelot-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harmonicTransitionScore } from '../dist-electron/shared/harmonic-mix.js';

function track(overrides) {
  return {
    id: overrides.id ?? 1, path: 'x', title: 't', artist: 'a', album: 'al', albumArtist: 'a',
    trackNo: 1, discNo: null, year: null, genre: null, duration: 200, bitrate: 320000,
    sampleRate: 44100, size: 1, mtime: 1, hasArt: 0, loved: 0, rating: 0, ratingScore: null,
    avoidAutoPlay: 0, playCount: 0, lastPlayed: null, skipCount: 0, lastSkipped: null,
    bpm: 120, key: null, replayGainTrackDb: null, replayGainAlbumDb: null,
    ...overrides,
  };
}

// 8B (Camelot) and C (letter name) are the literal same key.
const camelot8B = track({ id: 1, key: '8B' });
const letterC = track({ id: 2, key: 'C' });
const sameKey = harmonicTransitionScore(camelot8B, letterC).keyScore;
assert.ok(sameKey >= 0.95, `8B and C are the same key and should score >= 0.95, got ${sameKey}`);

// 8A and 8B are Camelot's own relative minor/major pair for the SAME key
// signature — this should score just as high even entirely within Camelot
// notation (no letter-name key involved at all).
const camelot8A = track({ id: 3, key: '8A' });
const relativePair = harmonicTransitionScore(camelot8A, camelot8B).keyScore;
assert.ok(relativePair >= 0.95, `8A and 8B are a relative minor/major pair and should score >= 0.95, got ${relativePair}`);

// Sanity check against the letter-name equivalents directly (Am is 8A's
// letter-name equivalent, matching the standard Camelot wheel).
const letterAm = track({ id: 4, key: 'Am' });
const camelotVsLetterMinor = harmonicTransitionScore(camelot8A, letterAm).keyScore;
assert.ok(camelotVsLetterMinor >= 0.95, `8A and Am are the same key and should score >= 0.95, got ${camelotVsLetterMinor}`);

// A genuinely distant key pair should still score low — this fix must not
// have made everything score as compatible.
const camelot1B = track({ id: 5, key: '1B' }); // B major, far from C major
const distant = harmonicTransitionScore(camelot8B, camelot1B).keyScore;
assert.ok(distant < 0.7, `8B and 1B (B major) are meaningfully different keys and should not score highly, got ${distant}`);

// --- Source assertions ---
const source = await readFile(new URL('../shared/harmonic-mix.ts', import.meta.url), 'utf8');
if (!/const circleIndex = mod\(number - 8 \+ \(mode === 'minor' \? 3 : 0\), CIRCLE\.length\);/.test(source)) {
  throw new Error('FAIL: parseKey\'s Camelot branch should compute circleIndex on the same numbering scheme as the letter-name branch');
}
if (/circleIndex: number - 1,/.test(source)) {
  throw new Error('FAIL: the old mismatched circleIndex formula (number - 1) should be gone');
}
if (!/const parseKeyCache = new Map/.test(source)) {
  throw new Error('FAIL: parseKey results should be memoized (buildHarmonicMix re-parses the same previous-track key once per candidate)');
}

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
assert.match(packageSource, /"test:harmonic-mix-camelot"/, 'package.json should expose the harmonic mix Camelot test');

console.log(JSON.stringify({ ok: true, sameKey, relativePair, camelotVsLetterMinor, distant }, null, 2));
