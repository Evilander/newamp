// The conductor's beat clock and bar pulse against a hand-built score: the
// clock counts whole beats from the downbeat without resetting, jumps only on
// a seek, the pulse falls on bar lines in bars of three or four, and on every
// beat when the bar phase is a guess.
// Run: node scripts/eviland-beat-clock-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-beat-clock-test-result.txt');
writeFileSync(RESULT, '[eviland-beat-clock-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-conductor.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-beat-clock-bundle.mjs'), logLevel: 'silent',
});
const { createConductor } = await import(pathToFileURL(resolve('tmp/eviland-beat-clock-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const BEAT = 0.5;
function makeScore({ beatsPerBar = 4, downbeat = 1, downbeatConfidence = 1 } = {}) {
  return {
    v: 2, duration: 60, bpm: 120, beatConfidence: 0.9, downbeat, downbeatConfidence, beatsPerBar,
    beats: Array.from({ length: 120 }, (_, i) => i * BEAT),
    homeKey: { tonic: 0, minor: false, confidence: 1 },
    energy: new Array(120).fill(0.5),
    sections: [{
      start: 0, end: 60, label: 0, tier: 'steady', intensity: 0.5, keyShift: 0,
      key: { tonic: 0, minor: false, confidence: 1 }, fingerprint: new Array(24).fill(0.25), build: null,
    }],
  };
}
const frame = () => ({
  bands: new Float32Array(24), onsets: [],
  kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0, energy: 0.5,
  centroid: 0.5, flatness: 0.2, crest: 0.5, rolloff: 0.5, width: 0.3, pan: 0,
  beatPhase: 0, beatConfidence: 0.2, bpm: 97, beatClock: 7.3, novelty: 0,
  sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
});

/** Conduct at 60 fps from `from` to `to` seconds; returns one row per frame. */
function run(score, from, to, { seekAt } = {}) {
  const conductor = createConductor();
  conductor.setScore(score);
  const rows = [];
  const dt = 1 / 60;
  for (let seconds = from; seconds < to; seconds += dt) {
    const f = frame();
    const at = seekAt && seconds >= seekAt.when ? seconds - seekAt.when + seekAt.to : seconds;
    conductor.conduct(f, at, dt * 1000);
    rows.push({ seconds: at, clock: f.beatClock, phase: f.beatPhase, downbeat: f.score.downbeat });
  }
  return rows;
}

// ── A continuous clock in bars of four ──────────────────────────────────────
{
  const rows = run(makeScore(), 0, 20);
  let backwards = 0;
  let largest = 0;
  for (let i = 1; i < rows.length; i++) {
    const step = rows[i].clock - rows[i - 1].clock;
    if (step < 0) backwards++;
    largest = Math.max(largest, step);
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const expected = (last.seconds - first.seconds) / BEAT;
  log.push(`bars of four: clock ${first.clock.toFixed(3)} -> ${last.clock.toFixed(3)} over ${(last.seconds - first.seconds).toFixed(2)} s (${expected.toFixed(2)} beats), largest frame step ${largest.toFixed(4)}`);
  if (backwards) fail(`the clock ran backwards on ${backwards} frames`);
  if (Math.abs(last.clock - first.clock - expected) > 0.05) fail('the clock does not count one per beat');
  if (largest > (1 / 60 / BEAT) * 1.5) fail(`the clock jumped ${largest.toFixed(3)} beats in one frame`);
  // Beat 1 is the downbeat: the clock reads 0 there, so bar lines sit on multiples of four.
  const atDownbeat = rows.find((r) => Math.abs(r.seconds - BEAT) < 1e-6);
  if (!atDownbeat || Math.abs(atDownbeat.clock) > 0.02) fail(`clock at the downbeat is ${atDownbeat?.clock}, expected 0`);
  const fracOff = rows.filter((r) => Math.abs(r.clock - Math.floor(r.clock) - r.phase) > 1e-6).length;
  if (fracOff) fail(`clock fraction disagrees with beatPhase on ${fracOff} frames`);
  const pulses = rows.filter((r) => r.downbeat).map((r) => r.seconds);
  log.push(`bar pulses at ${pulses.map((t) => t.toFixed(2)).join(' ')}`);
  if (pulses.length < 8) fail(`only ${pulses.length} bar pulses in 20 s`);
  for (const t of pulses) {
    const beat = Math.round(t / BEAT);
    if ((beat - 1) % 4 !== 0) fail(`a bar pulse fired on beat ${beat}, not a bar line`);
  }
}

// ── Bars of three ───────────────────────────────────────────────────────────
{
  const rows = run(makeScore({ beatsPerBar: 3, downbeat: 2 }), 0, 15);
  const pulses = rows.filter((r) => r.downbeat).map((r) => Math.round(r.seconds / BEAT));
  log.push(`bars of three: pulses on beats ${pulses.join(' ')}`);
  if (pulses.length < 8) fail(`only ${pulses.length} pulses in 15 s of 3/4`);
  for (const beat of pulses) if ((beat - 2) % 3 !== 0) fail(`a 3/4 bar pulse fired on beat ${beat}`);
}

// ── An unsure bar phase pulses on every beat ────────────────────────────────
{
  const rows = run(makeScore({ downbeatConfidence: 0.1 }), 0, 10);
  const pulses = rows.filter((r) => r.downbeat).length;
  log.push(`unsure bar phase: ${pulses} pulses in 10 s`);
  if (pulses < 18) fail(`an unsure bar phase should pulse every beat (about 20 in 10 s), got ${pulses}`);
}

// ── A seek jumps the clock once; playback through does not ──────────────────
{
  const rows = run(makeScore(), 0, 20, { seekAt: { when: 10, to: 30 } });
  const jumps = [];
  for (let i = 1; i < rows.length; i++) {
    const step = rows[i].clock - rows[i - 1].clock;
    if (Math.abs(step) > 0.5) jumps.push({ at: rows[i].seconds, step });
  }
  log.push(`seek: ${jumps.length} clock jump(s): ${jumps.map((j) => `${j.step.toFixed(1)} beats at ${j.at.toFixed(2)} s`).join(', ')}`);
  if (jumps.length !== 1) fail(`expected exactly one clock jump at the seek, got ${jumps.length}`);
  else if (Math.abs(jumps[0].step - 40) > 0.1) fail(`the seek from 10 s to 30 s moved the clock by ${jumps[0].step.toFixed(2)} beats, expected 40`);
}

const report = log.join('\n') + '\n' + (pass ? '[eviland-beat-clock-test] PASS' : '[eviland-beat-clock-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
