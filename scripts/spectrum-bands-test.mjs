import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// The Now Playing spectrum and the Auto-VJ's energy reading are anchored in Hz,
// so the same music reads the same at 44.1, 96 and 192 kHz (Bit-Perfect output
// moves the device rate per track).

Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map(frame => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('Spectrum bands test timed out'); process.exit(1); }, 30000);
deadline.unref();

const bundled = await build({
  stdin: {
    contents: `
      export { bandPeak } from './src/components/views/spectrumBands';
      export { visualizerEnergy, ENERGY_BANDS } from './src/components/visualizer-energy';
      export { logBandEdges } from './src/visualizer/band-edges';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const { bandPeak, visualizerEnergy, ENERGY_BANDS, logBandEdges } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const FFT = 2048;
const RATES = [44100, 48000, 96000, 192000];

// A frame at `rate` whose level at each bin is `level(hz)`.
function frame(rate, level) {
  const freq = new Uint8Array(FFT / 2);
  for (let k = 1; k < freq.length; k += 1) freq[k] = Math.max(0, Math.min(255, Math.round(level(k * rate / FFT))));
  return freq;
}
const tone = (hz) => (f) => (Math.abs(f - hz) < 1 ? 255 : 0);

// --- spectrum bars ----------------------------------------------------------------------

function litBar(rate, hz, bars) {
  const nearest = Math.round(hz / (rate / FFT));
  const freq = new Uint8Array(FFT / 2);
  freq[nearest] = 255;
  const edges = logBandEdges(rate, FFT, bars);
  const lit = [];
  for (let i = 0; i < bars; i += 1) if (bandPeak(freq, edges, i) === 1) lit.push(i);
  return lit;
}

for (const bars of [12, 24, 36]) {
  for (const hz of [60, 250, 1000, 4000, 12000]) {
    const reference = litBar(44100, hz, bars);
    assert.ok(reference.length >= 1, `${hz} Hz lights a bar of ${bars} at 44.1 kHz`);
    for (const rate of RATES) {
      const lit = litBar(rate, hz, bars);
      assert.ok(lit.length >= 1, `${hz} Hz lights a bar at ${rate}`);
      // A coarse bin can straddle a band edge, so a tone may sit one bar over,
      // and where bands are finer than a bin (the bass at 96 kHz) several bars
      // start on the same bin and show it together.
      assert.ok(
        lit.some((a) => reference.some((b) => Math.abs(a - b) <= 1)),
        `${hz} Hz lights bars ${lit} at ${rate} Hz and ${reference} at 44.1 kHz (${bars} bars)`,
      );
    }
  }
}

// Bass stays in the first half of the bars and treble in the second, at any rate.
for (const rate of RATES) {
  assert.ok(litBar(rate, 80, 24).every((i) => i < 12), `80 Hz is in the lower half at ${rate}`);
  assert.ok(litBar(rate, 8000, 24).every((i) => i >= 12), `8 kHz is in the upper half at ${rate}`);
}

{
  const edges = logBandEdges(44100, FFT, 24);
  const freq = new Uint8Array(FFT / 2);
  freq[40] = 51;
  freq[41] = 204;
  const owner = [...Array(24).keys()].filter((i) => bandPeak(freq, edges, i) > 0);
  assert.ok(owner.length >= 1);
  for (const i of owner) assert.ok(bandPeak(freq, edges, i) >= 0.2, 'a bar shows its loudest bin');
  assert.ok(owner.some((i) => bandPeak(freq, edges, i) === 0.8), 'and that bin as a fraction of full scale');
  assert.equal(bandPeak(new Uint8Array(FFT / 2), edges, 5), 0, 'silence is zero');
  assert.equal(bandPeak(new Uint8Array(4), edges, 23), 0, 'a short frame does not read past its end');
}

// --- Auto-VJ energy -------------------------------------------------------------------

const music = (f) => (f <= 700 ? 190 : f <= 3400 ? 120 : f <= 16000 ? 60 : 0);
const bass = (f) => (f <= 700 ? 200 : 0);
const treble = (f) => (f > 3400 && f <= 16000 ? 200 : 0);

for (const shape of [music, bass, treble]) {
  const readings = RATES.map((rate) => visualizerEnergy(frame(rate, shape), rate, FFT));
  const spread = Math.max(...readings) - Math.min(...readings);
  assert.ok(spread < 0.04, `${shape.name} reads the same at every rate (${readings.map((r) => r.toFixed(3)).join(', ')})`);
}

{
  const at = (shape) => visualizerEnergy(frame(44100, shape), 44100, FFT);
  assert.ok(at(bass) > at(treble), 'bass weighs more than treble');
  assert.ok(at(music) > at(treble) && at(music) > 0.2 && at(music) < 0.9, 'music sits mid-scale');
  assert.equal(at(() => 0), 0, 'silence is zero');
  assert.equal(at(() => 255), 1, 'full scale is one');
}

// At 44.1 kHz the Hz-anchored reading has to land where the bin-index reading
// (bins 0-36 low, 36-180 mid, 180-420 high) did, because the Auto-VJ's gates
// (0.42 to switch early, 0.12 and 0.68 to pick a preset) were set against it.
{
  const mean = (freq, from, to) => {
    let total = 0;
    for (let k = from; k < to && k < freq.length; k += 1) total += freq[k];
    return total / (to - from);
  };
  const binIndexEnergy = (freq) => Math.min(1, Math.pow(
    (mean(freq, 0, 36) * 0.48 + mean(freq, 36, 180) * 0.36 + mean(freq, 180, 420) * 0.16) / 255, 0.72));
  const spectra = {
    pink: (f) => 235 * Math.pow(100 / (f + 100), 0.55),
    steepPink: (f) => 255 * Math.pow(60 / (f + 60), 0.8),
    bassHeavy: (f) => (f < 150 ? 245 : 200 * Math.pow(150 / f, 0.9)),
    quiet: (f) => 0.5 * 235 * Math.pow(100 / (f + 100), 0.55),
    voice: (f) => (f > 200 && f < 3000 ? 200 : 40),
    bright: (f) => (f < 300 ? 60 : f < 12000 ? 190 : 30),
    flat: () => 128,
    sparseTreble: (f) => (f > 4000 && f < 9000 && Math.round(f / 200) % 7 === 0 ? 200 : 6),
    nearSilence: () => 10,
  };
  for (const [name, shape] of Object.entries(spectra)) {
    const freq = frame(44100, shape);
    const before = binIndexEnergy(freq);
    const after = visualizerEnergy(freq, 44100, FFT);
    assert.ok(Math.abs(after - before) < 0.04, `${name} reads ${after.toFixed(3)} at 44.1 kHz, ${before.toFixed(3)} by bin index`);
    for (const rate of RATES) {
      const other = visualizerEnergy(frame(rate, shape), rate, FFT);
      assert.ok(Math.abs(other - after) < 0.04, `${name} reads ${other.toFixed(3)} at ${rate} Hz, ${after.toFixed(3)} at 44.1 kHz`);
    }
  }
}

assert.equal(visualizerEnergy(new Uint8Array(0), 44100, FFT), 0, 'no frame, no energy');
assert.equal(visualizerEnergy(new Uint8Array(FFT / 2).fill(200), 0, FFT), 0, 'an unknown sample rate reads as silence');
assert.equal(visualizerEnergy(new Uint8Array(FFT / 2).fill(200), 44100, 0), 0);
assert.ok(ENERGY_BANDS >= 9, 'enough bands for the low, mid and high groups');

// --- wiring --------------------------------------------------------------------------------

// The helpers above are only worth anything while the views call them.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
{
  const nowPlaying = read('src/components/views/NowPlayingView.tsx');
  assert.match(nowPlaying, /let edges = logBandEdges\(engine\.getSampleRate\(\), engine\.fftSize, bars\);/, 'the spectrum starts from Hz-anchored bands');
  assert.match(nowPlaying, /createSampleRateWatch\(\(\) => engine\.getSampleRate\(\), engine\.getSampleRate\(\)\)/, 'and watches for a new sample rate');
  assert.match(nowPlaying, /edges = logBandEdges\(newRate, engine\.fftSize, bars\);/, 'rebuilding its bands when the rate moves');
  assert.match(nowPlaying, /const norm = bandPeak\(freq, edges, i\);/, 'and reads each bar through bandPeak');
  assert.doesNotMatch(nowPlaying, /Math\.pow\(i \/ bars, curve\)/, 'the bin-index power curve is gone');

  const fullscreen = read('src/components/FullscreenVisualizer.tsx');
  assert.match(fullscreen, /visualizerEnergy\(freq, engine\.getSampleRate\(\), engine\.fftSize\)/, 'the Auto-VJ reads the rate and FFT size it is analysing');
  assert.doesNotMatch(fullscreen, /function (visualizerEnergy|averageBand)\(/, 'and has no bin-index reading of its own');
}

console.log('spectrum-bands-test ok');
