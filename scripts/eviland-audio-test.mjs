// Runtime unit test for the Eviland audio reactor (no GPU, no audio
// hardware). Bundles eviland-audio.ts for Node and drives it with synthetic
// audio through an AnalyserNode emulation: noisiness and flatness, level
// invariance, tempo, re-locking on a tempo change and the beat clock,
// frame-rate invariance, and the live section detector on a verse/chorus form.
// Run: node scripts/eviland-audio-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeForm, makeSynth, percentile, runReactor } from './lib/eviland-synth.mjs';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/audio-test-result.txt');
writeFileSync(RESULT, '[audio-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-audio.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/audio-bundle.mjs'), logLevel: 'silent',
});
const { createEvilandReactor } = await import(pathToFileURL(resolve('tmp/audio-bundle.mjs')).href);

const SR = 48000;
const BINS = 1024;
const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const fmt = (v, d = 2) => v.toFixed(d);

// ── Noisiness on linear power; flatness keeps its old meaning ───────────────
// The analyser's bytes are linear in dB, so a geometric/arithmetic mean of
// them reads every music as noise: that is `flatness`, which the looks' decay
// bindings are tuned to, and it stays as it was. `noisiness` is the linear
// power version that tells a flute from a mix from noise. Feed crafted byte
// spectra straight in.
{
  const settle = (bytes) => {
    const reactor = createEvilandReactor({ sampleRate: SR, fftSize: 2048, binCount: BINS });
    let frame;
    for (let i = 0; i < 90; i++) frame = reactor.analyze(bytes, bytes, bytes, bytes, 16.7, i * 16.7);
    return { noisiness: frame.noisiness, flatness: frame.flatness };
  };
  const byteAt = (db) => Math.round(((db + 86) / 76) * 255);
  const sine = new Uint8Array(BINS);
  sine[43] = byteAt(-20);
  const harmonics = new Uint8Array(BINS);
  for (let h = 1; h <= 8; h++) harmonics[12 * h] = byteAt(-24 - 3 * h); // a 280 Hz flute-ish tone
  const noise = new Uint8Array(BINS).fill(byteAt(-40));
  const pop = new Uint8Array(BINS);
  for (let k = 1; k < BINS; k++) pop[k] = byteAt(-38 - 12 * Math.log10(k / 10) + (k % 7 === 0 ? 6 : 0));
  const f = { sine: settle(sine), harmonics: settle(harmonics), pop: settle(pop), noise: settle(noise) };
  log.push(`noisiness: sine ${fmt(f.sine.noisiness)} harmonics ${fmt(f.harmonics.noisiness)} pop ${fmt(f.pop.noisiness)} white noise ${fmt(f.noise.noisiness)}; flatness pop ${fmt(f.pop.flatness)} noise ${fmt(f.noise.flatness)}`);
  if (f.sine.noisiness > 0.1) fail(`a lone sine reads ${fmt(f.sine.noisiness)} noisiness; expected tonal`);
  if (f.harmonics.noisiness > 0.3) fail(`a harmonic tone reads ${fmt(f.harmonics.noisiness)} noisiness; expected under 0.3`);
  if (f.noise.noisiness < 0.9) fail(`white noise reads ${fmt(f.noise.noisiness)} noisiness; expected over 0.9`);
  if (!(f.harmonics.noisiness < f.pop.noisiness && f.pop.noisiness < f.noise.noisiness)) fail('noisiness does not order tone < mix < noise');
  if (f.pop.flatness < 0.8 || f.noise.flatness < 0.95) fail(`flatness reads ${fmt(f.pop.flatness)} for a mix and ${fmt(f.noise.flatness)} for noise; it must keep its dB-mapped range for the decay bindings`);
}

// ── Level: the same groove at three master levels ───────────────────────────
function groove({ bpm = 120, seconds = 30, hats = true, snare = true, bass8ths = false } = {}) {
  const s = makeSynth(SR, seconds);
  const beat = 60 / bpm;
  for (let b = 0; b * beat < seconds; b++) {
    const at = b * beat;
    const inBar = b % 4;
    s.kick(at, inBar === 0 ? 0.75 : 0.6);
    if (snare && (inBar === 1 || inBar === 3)) s.snare(at, 0.35);
    if (hats) { s.hat(at, 0.14); s.hat(at + beat / 2, 0.12); }
    if (bass8ths) s.bass(at + beat / 2, beat / 2, 55, 0.5);
    if (inBar === 0) for (const m of [60, 64, 67]) s.tone(at, beat * 4, s.midiHz(m), 0.06, 2);
  }
  s.normalise(0.9);
  return s;
}
function levels(s, from = 10) {
  const energy = [];
  const kick = [];
  const noisiness = [];
  runReactor(createEvilandReactor, s.L, s.R, SR, (f, t) => { if (t > from) { energy.push(f.energy); kick.push(f.kick); noisiness.push(f.noisiness); } });
  return {
    energy95: percentile(energy, 0.95), energy50: percentile(energy, 0.5), energy5: percentile(energy, 0.05),
    kick95: percentile(kick, 0.95), noisiness50: percentile(noisiness, 0.5),
  };
}
{
  const loud = levels(groove());
  const quiet12 = groove(); quiet12.scale(() => 10 ** (-12 / 20));
  const quiet24 = groove(); quiet24.scale(() => 10 ** (-24 / 20));
  const at12 = levels(quiet12);
  const at24 = levels(quiet24);
  log.push(`level: energy p05/p50/p95 ${[loud, at12, at24].map((q) => `${fmt(q.energy5)}/${fmt(q.energy50)}/${fmt(q.energy95)}`).join(' | ')}, kick p95 ${fmt(loud.kick95)} / ${fmt(at12.kick95)} / ${fmt(at24.kick95)}, noisiness p50 ${fmt(loud.noisiness50)} / ${fmt(at12.noisiness50)} / ${fmt(at24.noisiness50)} at 0 / -12 / -24 dB`);
  for (const [name, q] of [['-12 dB', at12], ['-24 dB', at24]]) {
    // p95 saturates at 1 on any normaliser that clips; p05 and p50 cannot.
    if (q.energy95 < 0.85 * loud.energy95) fail(`${name} master energy p95 ${fmt(q.energy95)} is not within 15% of the loud one (${fmt(loud.energy95)})`);
    if (Math.abs(q.energy50 - loud.energy50) > 0.1 * loud.energy50) fail(`${name} master energy p50 ${fmt(q.energy50)} is not within 10% of the loud one (${fmt(loud.energy50)})`);
    if (Math.abs(q.energy5 - loud.energy5) > 0.1 * loud.energy5) fail(`${name} master energy p05 ${fmt(q.energy5)} is not within 10% of the loud one (${fmt(loud.energy5)})`);
    if (q.kick95 < 0.8 * loud.kick95) fail(`${name} master kick p95 ${fmt(q.kick95)} is not within 20% of the loud one (${fmt(loud.kick95)})`);
    if (Math.abs(q.noisiness50 - loud.noisiness50) > 0.1) fail(`${name} master noisiness ${fmt(q.noisiness50)} differs from the loud one (${fmt(loud.noisiness50)}): the analyser floor is reading as spectrum`);
  }
  if (loud.energy95 - loud.energy5 < 0.1) fail('energy shows no dynamics inside a bar');

  // A gap after a quiet track must read as silence, not as the lifted floor:
  // the whole tail once the envelope has had a second to settle.
  const gap = groove({ seconds: 24 });
  gap.scale((t) => (t < 20 ? 10 ** (-24 / 20) : 0));
  let tail = 0;
  runReactor(createEvilandReactor, gap.L, gap.R, SR, (f, t) => { if (t > 21) tail = Math.max(tail, f.energy); });
  if (tail > 0.02) fail(`digital silence after a quiet track reads energy up to ${fmt(tail, 3)}`);
  log.push(`silence after a -24 dB track: energy at most ${fmt(tail, 3)}`);
}

// ── Tempo from kick events, and the beat clock ──────────────────────────────
function tempo(s, { hopMs = 1000 / 60, from = 10, to = Infinity } = {}) {
  const bpms = [];
  const clocks = [];
  const kicks = [];
  let events = 0;
  let lastEventMs = -Infinity;
  let seconds = 0;
  runReactor(createEvilandReactor, s.L, s.R, SR, (f, t, nowMs) => {
    seconds = t;
    if (t > from && t < to) {
      bpms.push(f.bpm);
      clocks.push({ t, clock: f.beatClock, phase: f.beatPhase });
    }
    // Real kick onsets, not the near-zero re-triggers on a decaying tail.
    const real = f.onsets.filter((o) => o.group === 'kick' && o.intensity >= 0.15).length;
    kicks.push(real);
    // One event per kick, the way the estimator counts them.
    if (real > 0 && nowMs - lastEventMs > 120) { events++; lastEventMs = nowMs; }
  }, { hopMs });
  return { bpm: percentile(bpms, 0.5), clocks, kicksPerSecond: kicks.reduce((a, b) => a + b, 0) / seconds, eventsPerSecond: events / seconds };
}
{
  const cases = [
    ['120 four-on-floor + snare + hats', groove(), 120, 1.5],
    ['120 pure kicks', (() => { const s = makeSynth(SR, 30); for (let b = 0; b * 0.5 < 30; b++) s.kick(b * 0.5, 0.7); s.normalise(0.9); return s; })(), 120, 1.5],
    ['110 kick + 8th-note bass', groove({ bpm: 110, bass8ths: true, hats: false, snare: false }), 110, 3],
    ['70 slow four-on-floor', groove({ bpm: 70 }), 70, 1.5],
  ];
  for (const [name, s, truth, tolerance] of cases) {
    const r = tempo(s);
    log.push(`tempo: ${name} reads ${fmt(r.bpm, 1)} BPM`);
    if (Math.abs(r.bpm - truth) > tolerance) fail(`${name}: live bpm ${fmt(r.bpm, 1)}, expected ${truth} ±${tolerance}`);
  }

  // A tempo change is followed within a few bars, an octave change too once
  // it has held; a fill is not a change.
  const twoTempo = (bpmA, bpmB, { switchAt = 15, seconds = 60, fill = false } = {}) => {
    const s = makeSynth(SR, seconds);
    let t = 0;
    let b = 0;
    while (t < seconds) {
      const beat = 60 / (t < switchAt ? bpmA : bpmB);
      const inBar = b % 4;
      if (fill && Math.floor(b / 4) % 4 === 3 && inBar === 3) for (let k = 0; k < 4; k++) s.kick(t + (k * beat) / 4, 0.6);
      else s.kick(t, inBar === 0 ? 0.75 : 0.6);
      if (inBar === 1 || inBar === 3) s.snare(t, 0.35);
      s.hat(t, 0.14);
      s.hat(t + beat / 2, 0.12);
      t += beat;
      b++;
    }
    s.normalise(0.9);
    return s;
  };
  const changes = [
    ['100 -> 60', twoTempo(100, 60), 100, 60],
    ['120 -> 90', twoTempo(120, 90), 120, 90],
    ['120 -> 60 (octave)', twoTempo(120, 60), 120, 60],
    ['60 -> 120 (octave)', twoTempo(60, 120), 60, 120],
    ['120 with a 16th-note kick fill every fourth bar', twoTempo(120, 120, { fill: true }), 120, 120],
  ];
  for (const [name, s, before, after] of changes) {
    const early = tempo(s, { from: 8, to: 15 }).bpm;
    const late = tempo(s, { from: 30, to: 60 }).bpm;
    log.push(`tempo change: ${name} reads ${fmt(early, 1)} BPM before and ${fmt(late, 1)} BPM after`);
    if (Math.abs(early - before) > 0.015 * before) fail(`${name}: ${fmt(early, 1)} BPM before the change, expected ${before}`);
    if (Math.abs(late - after) > 0.02 * after) fail(`${name}: ${fmt(late, 1)} BPM 15 s after the change, expected ${after}`);
  }

  // Paint rate must not move the estimate or the onset statistics. Band
  // onsets differ by about a tenth between rates (a kick's rise spans a
  // different number of frames); the events the estimator counts must not.
  const at60 = tempo(groove());
  const at30 = tempo(groove(), { hopMs: 1000 / 30 });
  log.push(`frame rate: 60 Hz ${fmt(at60.bpm, 1)} BPM, ${fmt(at60.kicksPerSecond, 1)} kick onsets/s, ${fmt(at60.eventsPerSecond)} events/s; 30 Hz ${fmt(at30.bpm, 1)} BPM, ${fmt(at30.kicksPerSecond, 1)} kick onsets/s, ${fmt(at30.eventsPerSecond)} events/s`);
  if (Math.abs(at30.bpm - 120) > 1.5) fail(`at 30 Hz the groove reads ${fmt(at30.bpm, 1)} BPM`);
  if (Math.abs(at30.kicksPerSecond - at60.kicksPerSecond) > 0.15 * at60.kicksPerSecond) fail('kick onset rate depends on the paint rate');
  if (Math.abs(at30.eventsPerSecond - at60.eventsPerSecond) > 0.1 * at60.eventsPerSecond) fail('kick event rate depends on the paint rate');

  // The beat clock: monotonic, one per beat, in step with the beat phase.
  const clocks = at60.clocks;
  let backwards = 0;
  let largestStep = 0;
  let phaseDisagree = 0;
  for (let i = 1; i < clocks.length; i++) {
    const step = clocks[i].clock - clocks[i - 1].clock;
    if (step < 0) backwards++;
    largestStep = Math.max(largestStep, step);
    const frac = clocks[i].clock - Math.floor(clocks[i].clock);
    let diff = Math.abs(frac - clocks[i].phase);
    if (diff > 0.5) diff = 1 - diff;
    if (diff > 0.1) phaseDisagree++;
  }
  const span = clocks[clocks.length - 1].t - clocks[0].t;
  const beats = clocks[clocks.length - 1].clock - clocks[0].clock;
  log.push(`beat clock: ${fmt(beats, 1)} beats over ${fmt(span, 1)} s (expected ${fmt(span * 2, 1)}), largest frame step ${fmt(largestStep, 3)} beats, ${phaseDisagree} of ${clocks.length} frames off the beat phase`);
  if (backwards > 0) fail(`beat clock ran backwards on ${backwards} frames`);
  if (Math.abs(beats - span * 2) > 1) fail(`beat clock advanced ${fmt(beats, 1)} beats in ${fmt(span, 1)} s at 120 BPM`);
  if (largestStep > 0.06) fail(`beat clock jumped ${fmt(largestStep, 3)} beats in one frame (a sawtooth, not a clock)`);
  if (phaseDisagree > 0.05 * clocks.length) fail('beat clock fraction disagrees with beatPhase once locked');
}

// ── Structure: boundaries, returns, nothing on a loop or a fade ─────────────
function structure(form) {
  const events = [];
  runReactor(createEvilandReactor, form.synth.L, form.synth.R, SR, (f, t) => {
    if (f.sectionChanged) events.push({ t, id: f.sectionId, ret: f.sectionReturn });
  });
  return events;
}
{
  const form = makeForm(SR, {});
  const events = structure(form);
  log.push(`form A B A B C B: boundaries at ${events.map((e) => `${fmt(e.t, 1)}s${e.ret >= 0 ? '<-' + e.ret : ''}`).join(' ')} (truth ${form.boundaries.join(', ')})`);
  const hits = form.boundaries.filter((truth) => events.some((e) => e.t >= truth - 1 && e.t <= truth + 4));
  const extras = events.filter((e) => !form.boundaries.some((truth) => e.t >= truth - 1 && e.t <= truth + 4));
  if (hits.length < 5) fail(`only ${hits.length} of 5 section boundaries found within 4 s`);
  if (extras.length > 0) fail(`spurious boundaries at ${extras.map((e) => fmt(e.t, 1)).join(', ')}s`);
  // The section that ENDS at each boundary is what gets fingerprinted: the
  // second verse (ending near 48 s) returns to the first, the second chorus
  // (ending near 64 s) to the first chorus, and a chorus is never a return
  // of a verse.
  const near = (t) => events.find((e) => e.t >= t - 1 && e.t <= t + 4);
  const [b16, b32, b48, b64] = [16, 32, 48, 64].map(near);
  if (b16?.ret !== -1) fail(`the first verse was reported as a return (${b16?.ret})`);
  if (b32?.ret !== -1) fail(`the first chorus was reported as a return of section ${b32?.ret}`);
  if (b48?.ret !== 0) fail(`the second verse was not recognised as the first (return ${b48?.ret})`);
  if (b64?.ret !== 1) fail(`the second chorus was not recognised as the first (return ${b64?.ret})`);

  const loop = structure(makeForm(SR, { form: ['A', 'A', 'A', 'A', 'A', 'A'] }));
  log.push(`six identical verses: ${loop.length} boundaries`);
  if (loop.length > 0) fail(`structureless material fired ${loop.length} boundaries at ${loop.map((e) => fmt(e.t, 1)).join(', ')}s`);

  const fade = makeForm(SR, { form: ['B', 'B', 'B', 'B', 'B', 'B'], fadeOutSeconds: 20 });
  const fadeEvents = structure(fade);
  const inFade = fadeEvents.filter((e) => e.t > fade.fadeAt);
  log.push(`six choruses with a 20 s fade-out: ${fadeEvents.length} boundaries, ${inFade.length} inside the fade`);
  if (inFade.length > 0) fail(`a look change fired inside the fade-out at ${inFade.map((e) => fmt(e.t, 1)).join(', ')}s`);
}

const report = log.join('\n') + '\n' + (pass ? '[audio-test] PASS' : '[audio-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
