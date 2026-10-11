// What MilkDrop is fed from the analyser, and how the iframe host reacts to it.
//
// Butterchurn places its bass/mid/treb band edges from the sample rate it is
// told and reads BUTTERCHURN_FFT_SIZE contiguous samples. The feed used to take
// every second sample of a longer window and report the full rate, which put
// every edge an octave low. These checks run Butterchurn's own band arithmetic
// over what the feed produces.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const bundle = async (contents) => {
  const out = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
};
const { feedDecimation, feedSampleRate, fillButterchurnSamples, waveGainFor } = await bundle(`export * from './src/butterchurn-iframe/feed';`);
const { createActivityTracker, applyConfig, fitCanvasSize, paintsFromMessage, STARVED_PAINT_MS } = await bundle(`export * from './src/butterchurn-iframe/host-policy';`);
const { retuneButterchurnBands } = await bundle(`export * from './src/butterchurn-iframe/band-tuning';`);

const N = 1024;

// ── Butterchurn's band arithmetic (node_modules/butterchurn audioLevels.js) ──
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function bandEdges(sampleRate) {
  const bucketHz = sampleRate / N;
  return [20, 320, 2800, 11025].map((hz) => clamp(Math.round(hz / bucketHz) - 1, 0, N / 2 - 1));
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}
// bass / mid / treb magnitude sums for one fed window, the way AudioLevels
// adds up its freqArray between its edges.
function bandSums(window, toldRate) {
  const re = Float64Array.from(window, (b) => b - 128);
  const im = new Float64Array(N);
  fft(re, im);
  const edges = bandEdges(toldRate);
  const sums = [0, 0, 0];
  for (let k = 0; k < N / 2; k += 1) {
    const mag = Math.hypot(re[k], im[k]);
    for (let band = 0; band < 3; band += 1) if (k >= edges[band] && k < edges[band + 1]) sums[band] += mag;
  }
  return sums;
}
const share = (sums) => { const t = sums[0] + sums[1] + sums[2] || 1; return sums.map((v) => v / t); };

// What the analyser hands over: `length` bytes of a sine, 0.5 full scale.
const toneBytes = (hz, rate, length = 2048) =>
  Uint8Array.from({ length }, (_, i) => clamp(Math.round(128 + 64 * Math.sin((2 * Math.PI * hz * i) / rate)), 0, 255));

// The feed as it was: every second sample of the window, told the full rate.
function legacyFeed(wave) {
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i += 1) out[i] = wave[i * 2];
  return out;
}

// ── 1. tones land in the band they belong to ────────────────────────────────
for (const rate of [44100, 48000]) {
  const feed = (hz) => {
    const out = new Uint8Array(N);
    fillButterchurnSamples(toneBytes(hz, rate), out, 1, rate);
    return share(bandSums(out, feedSampleRate(rate)));
  };
  assert.ok(feed(150)[0] >= 0.7, `${rate}: 150 Hz should read as bass, got ${feed(150)}`);
  assert.ok(feed(1500)[1] >= 0.9, `${rate}: 1.5 kHz should read as mid, got ${feed(1500)}`);
  assert.ok(feed(6000)[2] >= 0.9, `${rate}: 6 kHz should read as treble, got ${feed(6000)}`);

  // The old feed misreads the same tones, which is what these assertions guard.
  const old1500 = share(bandSums(legacyFeed(toneBytes(1500, rate)), rate));
  assert.ok(old1500[2] > old1500[1], `${rate}: the decimated feed should have read 1.5 kHz as treble, not mid (${old1500})`);
}

// A rate above what the iframe accepts is filtered down, and the rate it is
// told is the rate of what it gets.
assert.equal(feedDecimation(44100), 1);
assert.equal(feedDecimation(96000), 1);
assert.equal(feedDecimation(176400), 2);
assert.equal(feedDecimation(192000), 2);
assert.equal(feedDecimation(384000), 4);
assert.equal(feedSampleRate(192000), 96000);
assert.equal(feedSampleRate(352800), 88200);
for (const rate of [96000, 192000]) {
  const out = new Uint8Array(N);
  fillButterchurnSamples(toneBytes(6000, rate, 4096), out, 1, rate);
  const s = share(bandSums(out, feedSampleRate(rate)));
  assert.ok(s[2] >= 0.9, `${rate}: 6 kHz should read as treble after decimation, got ${s}`);
}

// ── 2. gain: linear, limited at full scale, identity for truth ──────────────
{
  const wave = Uint8Array.from({ length: 2048 }, (_, i) => (i * 37) % 256);
  const out = new Uint8Array(N);
  fillButterchurnSamples(wave, out, waveGainFor('truth'), 48000);
  assert.deepEqual(Array.from(out), Array.from(wave.subarray(2048 - N)), 'truth is the most recent window, unchanged');

  const square = Uint8Array.from({ length: 2048 }, (_, i) => (i % 2 ? 250 : 6));
  fillButterchurnSamples(square, out, waveGainFor('wild'), 48000);
  assert.ok(out.every((b) => b >= 0 && b <= 255), 'limited samples stay inside a byte');
  assert.equal(Math.min(...out), 0);
  assert.equal(Math.max(...out), 255);
  assert.ok(waveGainFor('truth') < waveGainFor('punch') && waveGainFor('punch') < waveGainFor('wild'));
}

// ── 3. the reactivity control reaches MilkDrop ──────────────────────────────
// Butterchurn's levels are each frame's sum over a running average, so a linear
// gain cancels out of them. What the control can move is the waveform it draws,
// and it must not take contrast away from the bands on the way.
{
  const rate = 48000;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const total = rate * 6;
  const signal = new Float32Array(total);
  let hp = 0, prev = 0;
  for (let i = 0; i < total; i += 1) {
    const t = i / rate;
    const beatT = t % 0.5;
    const kick = 0.45 * Math.exp(-beatT * 18) * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-beatT * 30)) * beatT);
    const n = rnd(); hp = 0.6 * (hp + n - prev); prev = n;
    const hat = 0.18 * Math.exp(-((t + 0.25) % 0.5) * 60) * hp;
    signal[i] = kick + hat + 0.05 * Math.sin(2 * Math.PI * 220 * t);
  }
  const contrast = (fill) => {
    const long = [1, 1, 1];
    const series = [[], [], []];
    const out = new Uint8Array(N);
    for (let end = 2048, frame = 0; end < total; end += Math.round(rate / 45), frame += 1) {
      const wave = Uint8Array.from({ length: 2048 }, (_, i) => clamp(Math.round(128 + signal[end - 2048 + i] * 128), 0, 255));
      fill(wave, out);
      const imm = bandSums(out, rate);
      for (let b = 0; b < 3; b += 1) {
        const r = Math.pow(frame < 50 ? 0.9 : 0.992, 30 / 45);
        long[b] = long[b] * r + imm[b] * (1 - r);
        if (frame > 120) series[b].push(imm[b] / Math.max(1e-9, long[b]));
      }
    }
    return series.map((v) => { v.sort((a, b) => a - b); return v[Math.floor(v.length * 0.95)] / Math.max(1e-6, v[Math.floor(v.length * 0.05)]); });
  };
  const fed = (reactivity) => contrast((wave, out) => fillButterchurnSamples(wave, out, waveGainFor(reactivity), rate));
  const truth = fed('truth');
  const punch = fed('punch');
  const wild = fed('wild');
  for (let b = 0; b < 3; b += 1) {
    // A gain cancels out of the bands (imm over its running average), so the
    // control must not cost them contrast: the soft clip that used to sit here
    // compressed the peaks against the bed.
    assert.ok(punch[b] >= truth[b] * 0.9 && wild[b] >= truth[b] * 0.9, `band ${b}: raising reactivity lost contrast (${truth[b]} -> ${punch[b]} -> ${wild[b]})`);
  }

  // What the control does change is the drawn waveform: its swing grows with it.
  const swing = (reactivity) => {
    const out = new Uint8Array(N);
    fillButterchurnSamples(toneBytes(440, rate), out, waveGainFor(reactivity), rate);
    return Math.max(...out) - Math.min(...out);
  };
  assert.ok(swing('truth') < swing('punch') && swing('punch') < swing('wild'), 'the waveform swing should grow with reactivity');
}

// ── 4. a quiet passage is not a pause ───────────────────────────────────────
{
  const IDLE = 3000;
  const flat = createActivityTracker(IDLE);
  // Flat bytes alone are the pause signal for a parent that says nothing else.
  flat.observe(0, true, undefined);
  assert.equal(flat.idle(2000), false);
  assert.equal(flat.idle(3500), true);
  flat.observe(4000, false, undefined);
  assert.equal(flat.idle(9000), false, 'live bytes end the quiet');

  // A parent that says the track is playing is believed over flat bytes.
  const quiet = createActivityTracker(IDLE);
  for (let t = 0; t <= 20000; t += 50) quiet.observe(t, true, true);
  assert.equal(quiet.idle(20000), false, 'a pianissimo passage with playing=true stays at the live cadence');

  const paused = createActivityTracker(IDLE);
  for (let t = 0; t <= 4000; t += 50) paused.observe(t, false, false);
  assert.equal(paused.idle(4000), true, 'a paused track idles whatever the bytes are');
  paused.observe(4050, true, true);
  assert.equal(paused.idle(4100), false, 'resuming ends the idle');
}

// ── 5. config after init ────────────────────────────────────────────────────
{
  const config = { dpr: 1, maxPixels: Infinity, quality: 'medium', sampleRate: 44100 };
  const none = { dpr: false, maxPixels: false, quality: false, sampleRate: false };
  assert.deepEqual(applyConfig(config, { type: 'config', dpr: 2 }), { ...none, dpr: true });
  assert.equal(config.dpr, 2);
  assert.deepEqual(applyConfig(config, { type: 'config', dpr: 2 }), none, 'the same value is not a change');
  assert.deepEqual(applyConfig(config, { type: 'config', quality: 'low', sampleRate: 96000 }), { ...none, quality: true, sampleRate: true });
  assert.equal(config.quality, 'low');
  assert.equal(config.sampleRate, 96000);
  assert.deepEqual(applyConfig(config, { type: 'config', maxPixels: 8_300_000 }), { ...none, maxPixels: true });
  assert.equal(config.maxPixels, 8_300_000);
  assert.deepEqual(applyConfig(config, { type: 'config', dpr: -1, sampleRate: 0, maxPixels: 0 }), none);
  assert.equal(config.dpr, 2, 'a nonsense ratio is ignored');
  assert.equal(config.maxPixels, 8_300_000, 'a nonsense budget is ignored');
}

// ── 5b. the canvas fits the pixel budget ────────────────────────────────────
{
  const area = (size) => size.width * size.height;
  // A 4K-class window on a 2x display is 14.7 Mpx before the budget.
  const crowded = fitCanvasSize(2560, 1440, 2, 8_300_000);
  assert.ok(area(crowded) <= 8_300_000, `fitted to ${area(crowded)} px`);
  assert.ok(area(crowded) > 8_300_000 * 0.99, 'and not smaller than it needs to be');
  assert.ok(Math.abs(crowded.width / crowded.height - 2560 / 1440) < 0.01, 'the aspect ratio holds');
  // Without a budget the canvas is the CSS box at the display's ratio.
  assert.deepEqual(fitCanvasSize(1280, 720, 2, Infinity), { width: 2560, height: 1440 });
  // A box inside the budget is left alone.
  assert.deepEqual(fitCanvasSize(1280, 720, 1, 2_100_000), { width: 1280, height: 720 });
  // The governor's step comes off after the budget.
  assert.deepEqual(fitCanvasSize(1000, 500, 1, Infinity, 0.5), { width: 500, height: 250 });
  const governed = fitCanvasSize(2560, 1440, 2, 8_300_000, 0.7);
  assert.ok(Math.abs(area(governed) / area(crowded) - 0.49) < 0.01, 'the governor scales the fitted size');
  assert.deepEqual(fitCanvasSize(0, 0, 1, 1000), { width: 8, height: 8 }, 'a collapsed box still gets a drawable canvas');
}

// ── 6. the audio message paints right away only while frames are flowing ────
{
  assert.equal(paintsFromMessage(1000, 950, 940), true, 'frames are arriving: paint from the message');
  assert.equal(paintsFromMessage(1000, 500, 900), false, 'no frames and a recent paint: wait');
  assert.equal(paintsFromMessage(1000, 500, 1000 - STARVED_PAINT_MS - 1), true, 'no frames for a while: the slow starved paint');
}

// ── 7. Butterchurn's bands follow a rate change ─────────────────────────────
{
  const levels = { starts: [0, 6, 59], stops: [6, 59, 235] };
  const visualizer = { renderer: { audio: { fftSize: 1024, numSamps: 512 }, audioLevels: levels } };
  assert.equal(retuneButterchurnBands(visualizer, 96000), true);
  const expected = bandEdges(96000);
  assert.deepEqual(levels.starts, [expected[0], expected[1], expected[2]]);
  assert.deepEqual(levels.stops, [expected[1], expected[2], expected[3]]);
  assert.equal(retuneButterchurnBands({ renderer: {} }, 48000), false, 'an unexpected renderer is left alone');
  assert.equal(retuneButterchurnBands(null, 48000), false);

  // The pinned Butterchurn still builds AudioLevels the way this assumes.
  const source = readFileSync('node_modules/butterchurn/lib/butterchurn.js', 'utf8');
  assert.match(source, /this\.starts = \[bassLow, bassHigh, midHigh\];/, 'AudioLevels.starts changed shape');
  assert.match(source, /this\.stops = \[bassHigh, midHigh, trebHigh\];/, 'AudioLevels.stops changed shape');
  assert.match(source, /this\.audioLevels = new _audio_audioLevels__WEBPACK_IMPORTED_MODULE_0__\["default"\]\(this\.audio\);/, 'Renderer.audioLevels moved');
  assert.match(source, /var bucketHz = sampleRate \/ this\.audio\.fftSize;/, 'the band edge formula changed');
  for (const hz of [20, 320, 2800, 11025]) assert.match(source, new RegExp(`Math\\.round\\(${hz} / bucketHz\\)`), `edge ${hz} Hz moved`);
}

console.log('[butterchurn-feed-test] PASS');
