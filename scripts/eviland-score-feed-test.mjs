// Score-feed test: the app-side wrapper around the conductor. Uses ONE reused
// frame object, the way the real reactor does — that is what makes stale cues
// possible — and checks they never outlive their track, plus the cue-sheet
// offset, the look-ahead preference, the toolbar status and prefetch gating.
// esbuild harness like eviland-director-test. Run: node scripts/eviland-score-feed-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-score-feed-test-result.txt');
writeFileSync(RESULT, '[eviland-score-feed-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

// A stand-in for the preload bridge and the browser globals the feed touches.
const BEAT = 0.5;
const section = (start, end, label, tier, extra = {}) => ({
  start, end, label, tier, intensity: 0.5, keyShift: 0,
  key: { tonic: 0, minor: false, confidence: 1 }, fingerprint: new Array(24).fill(0.25), build: null, ...extra,
});
const score = {
  v: 1, duration: 80, bpm: 120, beatConfidence: 0.9, downbeat: 0, downbeatConfidence: 0.8,
  beats: Array.from({ length: 160 }, (_, i) => i * BEAT),
  homeKey: { tonic: 0, minor: false, confidence: 1 }, energy: new Array(160).fill(0.5),
  sections: [
    section(0, 64, 0, 'calm'),
    section(64, 80, 1, 'climax', { keyShift: 3, build: { seconds: 4, strength: 0.8, gapSeconds: 0.5 } }),
  ],
};
const requests = [];
const storage = new Map();
let now = 1000;
globalThis.window = {
  newamp: {
    getSongScore: async (id) => {
      requests.push(id);
      return id === 1 ? score : null; // track 2 is a stream / too short: no score
    },
  },
  localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
};
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });

await build({
  entryPoints: [resolve('src/visualizer/eviland-score-feed.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  alias: { '@shared': resolve('shared') },
  // lib/api.ts reads Vite's import.meta.env; there is no Vite here.
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  outfile: resolve('tmp/eviland-score-feed-bundle.mjs'), logLevel: 'silent',
});
const { createScoreFeed, prefetchSongScore, songScoreStatus } = await import(
  pathToFileURL(resolve('tmp/eviland-score-feed-bundle.mjs')).href
);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const settle = () => new Promise((r) => setTimeout(r, 5));

// The reactor returns the same object from every analyze() call.
const frame = {
  bands: new Float32Array(24), onsets: [],
  kick: 0.3, bass: 0.3, snare: 0.2, hat: 0.2, vocal: 0.2, energy: 0.2,
  centroid: 0.5, flatness: 0.2, crest: 0.5, rolloff: 0.5, width: 0.3, pan: 0,
  beatPhase: 0, beatConfidence: 0.1, bpm: 0, novelty: 0,
  sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
};

// Nothing is fetched while no Eviland visualizer is running.
prefetchSongScore(1);
if (requests.length) fail('prefetch ran with no active feed — idle listeners would pay for analysis');
if (songScoreStatus() !== 'idle') fail(`status with no feed should be idle, got ${songScoreStatus()}`);

let track = { id: 1 };
let position = 0;
const feed = createScoreFeed({ getTrack: () => track, getPosition: () => position });
const tick = (seconds) => {
  position = seconds;
  now += 16;
  return feed.conduct(frame, 16);
};

// First frames of a new track: the score hasn't arrived yet.
tick(0.1);
if (frame.score !== undefined) fail('cues appeared before the score arrived');
if (songScoreStatus() !== 'analysing') fail(`status while fetching should be analysing, got ${songScoreStatus()}`);
await settle();
tick(0.2);
if (!frame.score || frame.score.tier !== 'calm') fail('cues did not start once the score arrived');
if (songScoreStatus() !== 'scored') fail(`status once conducting should be scored, got ${songScoreStatus()}`);
if (requests.filter((id) => id === 1).length !== 1) fail(`track 1 fetched ${requests.filter((id) => id === 1).length} times`);

// Play into the held silence before the drop, then past it into the shifted key.
for (let t = 60; t < 63.8; t += 1 / 30) tick(t);
tick(63.8);
if (!(frame.score?.blackout > 0.9 && frame.score.anticipation > 0.5)) fail('expected to be deep in the build/blackout at 63.8 s');
for (let t = 63.85; t < 70; t += 1 / 30) tick(t);
if (!(frame.score?.keyShift > 0.1)) fail('expected a key shift in the last section');

// THE bug this test exists for: skip to a track with no score while cues are
// live. The very next frame must carry none of them.
track = { id: 2 };
tick(0.05);
if (frame.score !== undefined) fail(`the previous track's cues survived the track change: ${JSON.stringify(frame.score)}`);
await settle();
tick(0.1);
if (frame.score !== undefined) fail('cues reappeared on a track that has no score');
if (songScoreStatus() !== 'unavailable') fail(`status for an unscorable track should be unavailable, got ${songScoreStatus()}`);

// Back to the scored track: served from the feed's recent-score cache.
track = { id: 1 };
tick(10);
await settle();
tick(10.1);
if (!frame.score) fail('cues did not return for a track whose score was already fetched');
if (requests.filter((id) => id === 1).length !== 1) fail('a recently fetched score was requested again');

// A cue-sheet track's clock is offset into its file.
track = { id: 1, cueStart: 100 };
tick(140);
if (!frame.score || Math.abs(frame.score.arc - 0.5) > 0.02) fail(`cue offset ignored: arc ${frame.score?.arc} at file time 140 s with cueStart 100`);

// With a feed running, the gapless prepare warms the next track.
prefetchSongScore(3);
if (!requests.includes(3)) fail('prefetch did not run while a feed was active');

// Turning look-ahead off clears the cues within half a second, and on again restores them.
storage.set('newamp:viz:lookahead', 'off');
now += 600;
tick(141);
if (frame.score !== undefined) fail('cues kept flowing after look-ahead was turned off');
if (songScoreStatus() !== 'off') fail(`status when disabled should be off, got ${songScoreStatus()}`);
const before = requests.length;
prefetchSongScore(4);
if (requests.length !== before) fail('prefetch ran while look-ahead was off');
storage.set('newamp:viz:lookahead', 'on');
now += 600;
tick(142);
await settle();
tick(142.1);
if (!frame.score) fail('cues did not come back after look-ahead was turned on again');

feed.dispose();
if (songScoreStatus() !== 'idle') fail(`status after the last feed is disposed should be idle, got ${songScoreStatus()}`);

const report = log.join('\n') + '\n' + (pass ? '[eviland-score-feed-test] PASS' : '[eviland-score-feed-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
