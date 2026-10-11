// A frame time, clock or reading that is not a number must not stick in the
// state that carries from frame to frame. The reactor's envelopes, the
// conductor's impact and key glide and the operators' smoothed slots all
// integrate what they are given; one NaN in them would blank the visualizer for
// the rest of the track. Each is fed bad values in the middle of a run and has
// to come back to numbers.
// Run: node scripts/eviland-nan-guards-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAnalyser, makeSynth } from './lib/eviland-synth.mjs';

const root = resolve('tmp/eviland-nan-guards-test');
mkdirSync(root, { recursive: true });
const bundle = async (name, contents) => {
  const outfile = resolve(root, `${name}.mjs`);
  await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
};
const { createEvilandReactor } = await bundle('audio', `export { createEvilandReactor } from './src/visualizer/eviland-audio';`);
const { createConductor, applyScoreCues } = await bundle('conductor', `export { createConductor, applyScoreCues } from './src/visualizer/eviland-conductor';`);
const { evalConfig, createDynamics } = await bundle('operators', `export { evalConfig, createDynamics } from './src/visualizer/eviland-operators';`);
const { generate } = await bundle('randomizer', `export { generate } from './src/visualizer/eviland-randomizer';`);

const SR = 48000;
const FFT = 2048;
const BINS = FFT / 2;
const FPS = 60;
const DT = 1000 / FPS;

const UNIT_FIELDS = ['kick', 'bass', 'snare', 'hat', 'vocal', 'energy', 'centroid', 'flatness', 'noisiness', 'crest', 'rolloff', 'width', 'beatConfidence', 'novelty'];
function assertFrameSane(frame, where) {
  for (const key of UNIT_FIELDS) {
    assert.ok(Number.isFinite(frame[key]) && frame[key] >= 0 && frame[key] <= 1, `${where}: ${key} is ${frame[key]}`);
  }
  assert.ok(Number.isFinite(frame.pan) && frame.pan >= -1 && frame.pan <= 1, `${where}: pan is ${frame.pan}`);
  for (const key of ['bpm', 'beatPhase', 'beatClock']) {
    assert.ok(Number.isFinite(frame[key]), `${where}: ${key} is ${frame[key]}`);
  }
  for (let b = 0; b < frame.bands.length; b++) {
    assert.ok(Number.isFinite(frame.bands[b]) && frame.bands[b] >= 0 && frame.bands[b] <= 1, `${where}: band ${b} is ${frame.bands[b]}`);
  }
  for (const onset of frame.onsets) {
    assert.ok(Number.isFinite(onset.intensity) && Number.isFinite(onset.sharpness), `${where}: onset ${JSON.stringify(onset)}`);
  }
}

// ── The reactor ─────────────────────────────────────────────────────────────
{
  // Twelve seconds of a four-on-the-floor groove, as analyser bytes.
  const seconds = 12;
  const synth = makeSynth(SR, seconds);
  for (let b = 0; b < seconds * 2; b++) {
    synth.kick(b * 0.5, 0.7);
    synth.hat(b * 0.5 + 0.25, 0.14);
    if (b % 2 === 1) synth.snare(b * 0.5, 0.35);
    if (b % 8 === 0) for (const m of [60, 64, 67]) synth.tone(b * 0.5, 4, synth.midiHz(m), 0.06, 2);
  }
  synth.normalise(0.9);
  const smooth = createAnalyser({ fftSize: FFT, smoothing: 0.24 });
  const raw = createAnalyser({ fftSize: FFT });
  const left = createAnalyser({ fftSize: FFT });
  const right = createAnalyser({ fftSize: FFT });
  const hop = SR / FPS;
  const frames = [];
  const mono = new Float32Array(FFT);
  const lw = new Float32Array(FFT);
  const rw = new Float32Array(FFT);
  for (let pos = FFT; pos < synth.total; pos += hop) {
    const end = Math.floor(pos);
    for (let i = 0; i < FFT; i++) {
      lw[i] = synth.L[end - FFT + i];
      rw[i] = synth.R[end - FFT + i];
      mono[i] = 0.5 * (lw[i] + rw[i]);
    }
    const bytes = [new Uint8Array(BINS), new Uint8Array(BINS), new Uint8Array(BINS), new Uint8Array(BINS)];
    smooth.getByteFrequencyData(mono, bytes[0]);
    raw.getByteFrequencyData(mono, bytes[1]);
    left.getByteFrequencyData(lw, bytes[2]);
    right.getByteFrequencyData(rw, bytes[3]);
    frames.push(bytes);
  }

  function drive(corrupt) {
    const reactor = createEvilandReactor({ sampleRate: SR, fftSize: FFT, binCount: BINS });
    const tail = [];
    frames.forEach((bytes, i) => {
      const arrays = [...bytes];
      let dt = DT;
      let now = i * DT;
      const bad = corrupt(i);
      if (bad) {
        if ('dt' in bad) dt = bad.dt;
        if ('now' in bad) now = bad.now;
        if (bad.short) arrays[0] = arrays[0].subarray(0, 100);
        if (bad.short) arrays[2] = arrays[2].subarray(0, 100);
      }
      const frame = reactor.analyze(arrays[0], arrays[1], arrays[2], arrays[3], dt, now);
      assertFrameSane(frame, `frame ${i}${bad ? ` (${JSON.stringify(bad)})` : ''}`);
      if (i >= frames.length - 120) tail.push({ energy: frame.energy, noisiness: frame.noisiness, centroid: frame.centroid });
    });
    const mean = (key) => tail.reduce((sum, f) => sum + f[key], 0) / tail.length;
    return { energy: mean('energy'), noisiness: mean('noisiness'), centroid: mean('centroid') };
  }

  const control = drive(() => null);
  assert.ok(control.energy > 0.2, `the control run has no signal (energy ${control.energy})`);
  const scenarios = {
    'NaN frame time': (i) => (i >= 100 && i < 105 ? { dt: NaN } : null),
    'infinite frame time': (i) => (i === 200 ? { dt: Infinity } : null),
    'negative frame time': (i) => (i === 220 ? { dt: -40 } : null),
    'undefined frame time and clock': (i) => (i === 240 ? { dt: undefined, now: undefined } : null),
    'NaN clock': (i) => (i >= 300 && i < 310 ? { now: NaN } : null),
    'short analyser arrays': (i) => (i >= 400 && i < 410 ? { short: true } : null),
    'all of it': (i) => (i % 97 === 0 ? { dt: NaN, now: NaN } : i % 89 === 0 ? { short: true } : null),
  };
  for (const [name, corrupt] of Object.entries(scenarios)) {
    const run = drive(corrupt);
    assert.ok(Math.abs(run.energy - control.energy) < 0.15, `${name}: energy ${run.energy.toFixed(3)} against ${control.energy.toFixed(3)}`);
    assert.ok(Math.abs(run.noisiness - control.noisiness) < 0.08, `${name}: noisiness ${run.noisiness.toFixed(3)} against ${control.noisiness.toFixed(3)}`);
    assert.ok(Math.abs(run.centroid - control.centroid) < 0.1, `${name}: centroid ${run.centroid.toFixed(3)} against ${control.centroid.toFixed(3)}`);
  }
}

// ── The conductor ───────────────────────────────────────────────────────────
{
  const BEAT = 0.5;
  const section = (start, end, label, tier, extra = {}) => ({
    start, end, label, tier, intensity: 0.5, keyShift: 0,
    key: { tonic: 0, minor: false, confidence: 1 }, fingerprint: new Array(24).fill(0.25), build: null, ...extra,
  });
  const score = (overrides = {}) => ({
    v: 1, duration: 40, bpm: 120, beatConfidence: 0.9, downbeat: 0, downbeatConfidence: 0.8,
    beats: Array.from({ length: 80 }, (_, i) => i * BEAT),
    homeKey: { tonic: 0, minor: false, confidence: 1 },
    energy: new Array(80).fill(0.5),
    sections: [
      section(0, 20, 0, 'steady'),
      section(20, 40, 1, 'climax', { keyShift: 3, build: { seconds: 4, strength: 0.8, gapSeconds: 0.5 }, ...overrides }),
    ],
  });
  const rawFrame = () => ({
    bands: new Float32Array(24), onsets: [],
    kick: 0.3, bass: 0.3, snare: 0.2, hat: 0.2, vocal: 0.2, energy: 0.2,
    centroid: 0.5, flatness: 0.2, crest: 0.5, rolloff: 0.5, width: 0.3, pan: 0,
    beatPhase: 0.77, beatConfidence: 0.1, bpm: 93, novelty: 0,
    sectionId: 41, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
  });
  const cuesAreNumbers = (cues, where) => {
    for (const key of ['anticipation', 'blackout', 'impact', 'keyShift', 'arc']) {
      assert.ok(Number.isFinite(cues[key]), `${where}: ${key} is ${cues[key]}`);
    }
  };

  // A frame time that is not a number on the frame an impact lands on, and after it.
  for (const bad of [NaN, undefined, Infinity]) {
    const conductor = createConductor();
    conductor.setScore(score());
    let impact = null;
    for (let t = 0; t < 26; t += 1 / 60) {
      const landing = t >= 20 && t < 20 + 1 / 60 + 1e-9;
      const frame = conductor.conduct(rawFrame(), t, landing || (t > 20.3 && t < 20.4) ? bad : 1000 / 60);
      cuesAreNumbers(frame.score, `dt ${bad} at ${t.toFixed(2)}`);
      if (t > 25.9) impact = frame.score.impact;
    }
    assert.ok(impact < 0.004, `dt ${bad}: the impact never decayed (${impact})`);
  }

  // A score field that is not a number.
  {
    const conductor = createConductor();
    conductor.setScore(score({ keyShift: NaN, build: { seconds: 4, strength: NaN, gapSeconds: 0.5 } }));
    for (let t = 0; t < 30; t += 1 / 30) {
      const frame = conductor.conduct(rawFrame(), t, 1000 / 30);
      cuesAreNumbers(frame.score, `bad score at ${t.toFixed(2)}`);
    }
  }

  // The cues themselves.
  const dyn = createDynamics();
  const gain = applyScoreCues(dyn, { anticipation: NaN, impact: NaN, blackout: NaN, impactStart: false, tier: 'steady', keyShift: 0, arc: 0, downbeat: false, toBoundary: Infinity });
  assert.ok(Number.isFinite(gain.output) && Number.isFinite(gain.saturation), `gains ${JSON.stringify(gain)}`);
  for (const key of ['zoom', 'decay', 'rotate', 'emitterGain', 'emitterScale', 'waveIntensity', 'bloom']) {
    assert.ok(Number.isFinite(dyn[key]), `${key} is ${dyn[key]} after a NaN cue`);
  }
  assert.equal(gain.output, 1, 'a cue that is not a number is no cue');
}

// ── The operators ───────────────────────────────────────────────────────────
{
  const frame = () => ({
    kick: 0.5, bass: 0.4, snare: 0.3, hat: 0.2, vocal: 0.3, energy: 0.6, centroid: 0.5, flatness: 0.8, crest: 0.4, rolloff: 0.5,
    width: 0.4, pan: 0.1, novelty: 0.2, beatPhase: 0.3, beatConfidence: 0.7, beatClock: 12.3,
  });
  const fields = Object.keys(frame());
  const numbersIn = (out, where) => {
    for (const [key, value] of Object.entries(out)) {
      if (key === 'q') {
        for (const slot of value) assert.ok(Number.isFinite(slot) && Math.abs(slot) <= 8, `${where}: q slot ${slot}`);
      } else {
        assert.ok(Number.isFinite(value), `${where}: ${key} is ${value}`);
      }
    }
    assert.ok(Number.isInteger(out.mirror) || Number.isFinite(out.mirror), `${where}: mirror ${out.mirror}`);
    assert.ok(out.mirror >= 1 && out.mirror <= 16, `${where}: mirror ${out.mirror} out of range`);
    assert.ok(out.decay >= 0.78 && out.decay <= 0.97, `${where}: decay ${out.decay} out of range`);
  };
  let configs = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const config = generate(seed * 7919 + 13).config;
    configs++;
    for (const field of fields) {
      for (const bad of [NaN, Infinity, -Infinity]) {
        const out = createDynamics();
        evalConfig(config, { ...frame(), [field]: bad }, 0.4, out, DT);
        numbersIn(out, `seed ${seed}, ${field}=${bad}`);
        // And it recovers: the next clean frames give the same numbers a clean run gives.
        const clean = createDynamics();
        for (let i = 0; i < 90; i++) {
          evalConfig(config, frame(), 0.4, out, DT);
          evalConfig(config, frame(), 0.4, clean, DT);
        }
        numbersIn(out, `seed ${seed}, ${field}=${bad}, after 90 clean frames`);
        for (let k = 0; k < 8; k++) {
          assert.ok(Math.abs(out.q[k] - clean.q[k]) < 1e-3, `seed ${seed}, ${field}=${bad}: q${k} is ${out.q[k]} against ${clean.q[k]}`);
        }
      }
    }
    for (const dt of [NaN, Infinity, -Infinity, -5, undefined, 1e9]) {
      const out = createDynamics();
      for (let i = 0; i < 5; i++) evalConfig(config, frame(), 0.4, out, i === 2 ? dt : DT);
      numbersIn(out, `seed ${seed}, dt ${dt}`);
    }
    // A frame time that is not a number is read as one ordinary frame: the
    // smoothed slots carry on exactly where a clean run has them, they are not
    // reset.
    {
      const held = createDynamics();
      const clean = createDynamics();
      for (let i = 0; i < 60; i++) {
        evalConfig(config, frame(), 0.4, held, DT);
        evalConfig(config, frame(), 0.4, clean, DT);
      }
      for (const dt of [NaN, undefined]) {
        evalConfig(config, frame(), 0.4, held, dt);
        evalConfig(config, frame(), 0.4, clean, DT);
        for (let k = 0; k < 8; k++) assert.ok(Math.abs(held.q[k] - clean.q[k]) < 1e-12, `seed ${seed}: dt ${dt} moved q${k} (${held.q[k]} against ${clean.q[k]})`);
      }
    }
    const out = createDynamics();
    evalConfig(config, frame(), NaN, out, DT);
    numbersIn(out, `seed ${seed}, section seed NaN`);
  }
  assert.equal(configs, 24);
}

console.log(JSON.stringify({ ok: true }, null, 2));
