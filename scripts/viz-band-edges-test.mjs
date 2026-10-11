// Frequency bands that mean the same Hz at any sample rate, and the in-house
// visualizer analysis built on them.
//
// A bin index is a frequency only at one sample rate. The transport meter
// sliced the first 12 kHz into equal runs of bins, so its first bar was bass
// and most of the rest was above where music has energy; and every band map
// built at mount went wrong when Bit-Perfect output moved the device to
// another rate. The first low bin is the DC offset, which a source with an
// offset turned into a constant kick.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = async (contents) => {
  const out = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
};
const { bandEnd, logBandEdges, createSampleRateWatch } = await bundle(`export * from './src/visualizer/band-edges';`);
const {
  avg, boostFrequencyData, createAudioFeatureAnalyzer, createPhaseClock, settleLatticeDivisor, LATTICE_BASE_DIVISOR,
} = await bundle(`export * from './src/visualizer/viz-features';`);
const { createEvilandReactor } = await bundle(`export * from './src/visualizer/eviland-audio';`);

const RATES = [44100, 48000, 88200, 96000, 176400, 192000];
const FFT = 2048;

// ── 1. logBandEdges ──────────────────────────────────────────────────────────
for (const count of [16, 18, 56, 72]) {
  for (const rate of RATES) {
    const edges = logBandEdges(rate, FFT, count);
    assert.equal(edges.length, count + 1);
    assert.ok(edges[0] >= 1, `${rate}/${count}: the first band must not include the DC bin`);
    assert.ok(edges[count] <= FFT / 2, `${rate}/${count}: the last edge ${edges[count]} is past the spectrum`);
    for (let i = 1; i <= count; i += 1) assert.ok(edges[i] >= edges[i - 1], `${rate}/${count}: edge ${i} goes backwards (${edges[i - 1]}, ${edges[i]})`);
    for (let i = 0; i < count; i += 1) assert.ok(bandEnd(edges, i) > edges[i], `${rate}/${count}: band ${i} is empty`);
    assert.equal(logBandEdges(rate, FFT, count), edges, 'edges are cached per rate and count');
  }

  // Every edge sits at the same Hz whatever the rate, to within a bin of the
  // coarsest one. Where the bands are narrower than a bin they share it rather
  // than pushing the bands above them off their frequencies.
  for (let i = 0; i <= count; i += 1) {
    const hz = RATES.map((rate) => logBandEdges(rate, FFT, count)[i] * (rate / FFT));
    const widest = Math.max(...RATES.map((rate) => rate / FFT));
    assert.ok(Math.max(...hz) - Math.min(...hz) <= widest, `${count} bands, edge ${i}: ${hz.map((v) => v.toFixed(0)).join('/')} Hz differ by more than a bin`);
  }
}

// At a rate too coarse to resolve the bass, the bands above it keep their frequencies.
{
  const edges = logBandEdges(192000, FFT, 56);
  const hz = (bin) => bin * (192000 / FFT);
  const ideal = (i) => 30 * (16000 / 30) ** (i / 56);
  for (const i of [30, 40, 50, 56]) assert.ok(Math.abs(hz(edges[i]) - ideal(i)) <= 192000 / FFT, `edge ${i} at 192 kHz is ${hz(edges[i]).toFixed(0)} Hz, not ${ideal(i).toFixed(0)}`);
  assert.equal(edges[0], 1, 'the lowest band still starts above DC');
  assert.ok(edges[3] === edges[1], 'bands narrower than a bin share it');
}

// The 18-bar transport meter covers the spectrum rather than the bass.
{
  const edges = logBandEdges(48000, FFT, 18);
  const hz = (bin) => bin * (48000 / FFT);
  assert.ok(hz(edges[1]) < 120, `bar 0 reaches ${hz(edges[1]).toFixed(0)} Hz`);
  assert.ok(hz(edges[9]) > 400 && hz(edges[9]) < 1500, `the middle of the meter is at ${hz(edges[9]).toFixed(0)} Hz`);
  assert.ok(hz(edges[18]) > 15000, `the last bar ends at ${hz(edges[18]).toFixed(0)} Hz`);
  const linearFirstBar = 12000 / 18; // what a linear slice of 0-12 kHz gave
  assert.ok(hz(edges[1]) < linearFirstBar / 5);
}

// The same tone lights the band that covers its Hz at every rate.
{
  const BANDS = 16;
  const lit = (rate, hz) => {
    const analyze = createAudioFeatureAnalyzer({ sampleRate: rate, fftSize: FFT });
    const freq = new Uint8Array(FFT / 2);
    const bin = Math.round(hz / (rate / FFT));
    for (let k = -1; k <= 1; k += 1) freq[bin + k] = k === 0 ? 230 : 160;
    const bands = analyze(freq, new Uint8Array(FFT).fill(128), new Uint8Array(FFT / 2)).bands;
    const index = bands.indexOf(Math.max(...bands));
    const edges = logBandEdges(rate, FFT, BANDS);
    const binHz = rate / FFT;
    return { index, from: edges[index] * binHz, to: bandEnd(edges, index) * binHz, binHz };
  };
  for (const hz of [90, 440, 1500, 6000, 12000]) {
    const picks = RATES.map((rate) => lit(rate, hz));
    for (const [i, pick] of picks.entries()) {
      assert.ok(hz >= pick.from - pick.binHz && hz <= pick.to + pick.binHz, `${hz} Hz lit a band covering ${pick.from.toFixed(0)}-${pick.to.toFixed(0)} Hz at ${RATES[i]}`);
    }
    // Where the rate resolves the band, it is the same band at every rate.
    if (hz >= 440) {
      const indices = picks.map((pick) => pick.index);
      assert.ok(Math.max(...indices) - Math.min(...indices) <= 1, `${hz} Hz lands in bands ${indices.join('/')} at ${RATES.join('/')}`);
    }
  }
}

// ── 2. DC is not bass ───────────────────────────────────────────────────────
for (const rate of [44100, 48000, 96000, 192000]) {
  const analyze = createAudioFeatureAnalyzer({ sampleRate: rate, fftSize: FFT });
  const dc = new Uint8Array(FFT / 2);
  dc[0] = 255;
  let features;
  for (let i = 0; i < 30; i += 1) features = analyze(dc, new Uint8Array(FFT).fill(128), dc);
  assert.equal(features.bass, 0, `${rate}: a DC offset read as bass`);
  assert.equal(features.kick, 0, `${rate}: a DC offset read as kick`);
  assert.equal(features.beat, 0);
  assert.equal(features.beatEdge, false);
  assert.ok(features.bands.every((v) => v === 0), `${rate}: a DC offset lit a band`);
}
// A real kick-band signal still registers.
{
  const analyze = createAudioFeatureAnalyzer({ sampleRate: 48000, fftSize: FFT });
  const kick = new Uint8Array(FFT / 2);
  for (let k = 2; k <= 5; k += 1) kick[k] = 220;
  const features = analyze(kick, new Uint8Array(FFT).fill(128), kick);
  assert.ok(features.bass > 0.5 && features.kick > 0.5, `bass ${features.bass}, kick ${features.kick}`);
}

// ── 3. the band-aware lift follows Hz ───────────────────────────────────────
{
  // The same Hz gets the same lift at every rate: a flat spectrum shows where
  // the steps are.
  const stepsAt = (rate) => {
    const arr = new Uint8Array(FFT / 2).fill(100);
    boostFrequencyData(arr, 'punch', rate / FFT);
    const hz = [];
    for (let i = 1; i < arr.length; i += 1) if (arr[i] !== arr[i - 1]) hz.push(i * (rate / FFT));
    return hz;
  };
  const base = stepsAt(44100);
  assert.equal(base.length, 3, 'three lift steps');
  for (const rate of [48000, 96000, 192000]) {
    const steps = stepsAt(rate);
    assert.equal(steps.length, 3);
    steps.forEach((hz, i) => assert.ok(Math.abs(hz - base[i]) <= Math.max(rate, 44100) / FFT, `${rate}: step ${i} at ${hz.toFixed(0)} Hz, ${base[i].toFixed(0)} at 44.1k`));
  }
  // Without a rate it is the 44.1 kHz layout it always was.
  const legacy = new Uint8Array(FFT / 2).fill(100);
  boostFrequencyData(legacy, 'punch');
  const explicit = new Uint8Array(FFT / 2).fill(100);
  boostFrequencyData(explicit, 'punch', 44100 / FFT);
  assert.deepEqual(Array.from(legacy), Array.from(explicit));
  assert.ok(legacy[10] > legacy[400], 'bass is lifted more than treble');
}

// ── 4. a rate change is noticed once, and the reactor is rebuilt for it ─────
{
  let rate = 44100;
  const watch = createSampleRateWatch(() => rate, 44100, 500);
  assert.equal(watch(0), null);
  rate = 96000;
  assert.equal(watch(100), null, 'checked too recently');
  assert.equal(watch(600), 96000);
  assert.equal(watch(1200), null, 'reported once');
  rate = 44100;
  assert.equal(watch(1800), 44100);
  rate = 0;
  assert.equal(watch(2400), null, 'a nonsense rate is not a change');

  // The top Eviland band sits at the top of the range at the rate in use.
  const topBand = (builtFor, actual) => {
    const reactor = createEvilandReactor({ sampleRate: builtFor, fftSize: FFT, binCount: FFT / 2 });
    const freq = new Uint8Array(FFT / 2);
    const bin = Math.round(15500 / (actual / FFT));
    for (let k = -2; k <= 2; k += 1) freq[bin + k] = 220;
    let frame;
    for (let i = 0; i < 40; i += 1) frame = reactor.analyze(freq, freq, freq, freq, 16.7, i * 16.7);
    const bands = Array.from(frame.bands);
    return bands.indexOf(Math.max(...bands));
  };
  assert.equal(topBand(44100, 44100), 23);
  assert.equal(topBand(96000, 96000), 23, 'a reactor rebuilt for 96 kHz keeps 15.5 kHz in the top band');
  assert.notEqual(topBand(44100, 96000), 23, 'a reactor left at 44.1 kHz misplaces it, which is why it is rebuilt');
}

// ── 5. Lattice Strobe does not re-space every dot every frame ───────────────
{
  // Treble wobbling by a few percent around a level, as it does on a still tone.
  const wobble = (i) => LATTICE_BASE_DIVISOR + (0.458 + 0.04 * Math.sin(i * 0.9)) * 6;
  let divisor = LATTICE_BASE_DIVISOR;
  let changes = 0;
  for (let i = 0; i < 600; i += 1) {
    const next = settleLatticeDivisor(divisor, wobble(i));
    if (next !== divisor) changes += 1;
    divisor = next;
  }
  const unsettled = Array.from({ length: 600 }, (_, i) => Math.floor(600 / wobble(i)));
  const unsettledChanges = unsettled.filter((v, i) => i && v !== unsettled[i - 1]).length;
  assert.ok(changes <= 1 && unsettledChanges > 100, `the divisor changed ${changes} times (${unsettledChanges} without hysteresis)`);

  // A real change of level still comes through, in whole steps.
  divisor = LATTICE_BASE_DIVISOR;
  const seen = [];
  for (let i = 0; i < 600; i += 1) {
    divisor = settleLatticeDivisor(divisor, LATTICE_BASE_DIVISOR + (i / 600) * 6);
    if (seen.at(-1) !== divisor) seen.push(divisor);
  }
  assert.ok(seen.every(Number.isInteger) && seen.length >= 3 && seen.length <= 8, `a slow rise took ${seen.join(', ')}`);
  assert.ok(Math.abs(divisor - (LATTICE_BASE_DIVISOR + 6)) <= 0.75 + 1, `settled at ${divisor}`);
  assert.equal(settleLatticeDivisor(16, 16.5), 16);
  assert.equal(settleLatticeDivisor(16, 18.2), 18);
  assert.ok(Number.isInteger(settleLatticeDivisor(16, 21.4)));
}

// ── 6. shader phases advance by frame time, not by uptime x level ───────────
{
  const bands = (noise) => Array.from({ length: 16 }, (_, i) => 0.4 + 0.3 * Math.sin(i) + noise);
  const features = (noise) => ({ bass: 0.5 + noise, mid: 0.4 - noise, beat: 0.2 + noise, bands: bands(noise) });
  const clock = createPhaseClock();
  // An hour in, at 45 fps, with the music moving by +-0.05 every frame.
  const start = 3_600_000;
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.1;
  const frameMs = 1000 / 45;
  let prev = null;
  let worst = 0;
  for (let i = 0; i < 2000; i += 1) {
    const now = start + i * frameMs;
    clock.advance(now, features(rnd()));
    // neon-waves' x phase for band 3, as the shader builds it
    const phase = clock.seconds * 0.74 + clock.bandTime[3] * 0.95;
    if (prev !== null) worst = Math.max(worst, Math.abs(phase - prev));
    prev = phase;
  }
  // With the clock multiplied by the level instead, a 0.05 step in the band an
  // hour in moves the phase by 3600 x 0.05 x 0.95, over 170 rad.
  assert.ok(worst < 0.2, `a frame moved the phase by ${worst.toFixed(3)} rad`);

  // The clock starts at zero on the first frame and ignores a long stall.
  const fresh = createPhaseClock();
  fresh.advance(9_000_000, features(0));
  assert.equal(fresh.seconds, 0);
  assert.equal(fresh.bassTime, 0);
  fresh.advance(9_000_000 + 16, features(0));
  fresh.advance(9_000_000 + 60_000, features(0)); // a minute asleep
  assert.ok(fresh.bassTime < 0.1 * 0.5 + 0.02, `a stalled frame leapt the bass phase to ${fresh.bassTime}`);
  assert.equal(fresh.seconds, 60);
}

assert.equal(avg(new Uint8Array([10, 20, 30]), 1, 3), 25);
assert.equal(avg(new Uint8Array([10, 20, 30]), 3, 3), 0);

console.log('[viz-band-edges-test] PASS');
