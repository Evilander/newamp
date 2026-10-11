// The headless producer behind the detached projector: what it carries from
// one track to the next, what it feeds the projector's MilkDrop, and how it
// follows a sample-rate change from Bit-Perfect output.
//
// The producer is bundled with a stubbed IPC api and driven by hand: a fake
// engine whose spectrum and time-domain bytes the test sets, a fake interval
// timer, and a fake message port standing in for the projector.
//
// Run: node scripts/eviland-producer-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const stubApi = {
  name: 'stub-api',
  setup(b) {
    b.onResolve({ filter: /[\\/]lib[\\/]api$/ }, () => ({ path: 'stub-api', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        const none = async () => null;
        const own = { getArtUrl: (id) => 'art://' + id };
        export const api = new Proxy(own, { get: (target, key) => (key in target ? target[key] : none) });
      `,
      loader: 'js',
    }));
  },
};

// ── A page for it to run in ──────────────────────────────────────────────────
const clock = { t: 1000 };
const intervals = new Map();
let nextTimer = 1;
const prefs = {};
globalThis.performance = { now: () => clock.t };
globalThis.window = {
  localStorage: { getItem: (key) => prefs[key] ?? null, setItem: (key, value) => { prefs[key] = value; } },
  setInterval: (fn) => { const id = nextTimer++; intervals.set(id, fn); return id; },
  clearInterval: (id) => { intervals.delete(id); },
  setTimeout: () => nextTimer++,
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};
globalThis.Image = class { set src(_) {} };
globalThis.document = { hidden: false, documentElement: {}, createElement: () => ({ getContext: () => null }) };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

const bundled = await build({
  stdin: {
    contents: `
      export { startEvilandProducer } from './src/visualizer/eviland-producer';
      export { frameBus } from './src/visualizer/frame-bus';
      export { feedSampleRate } from './src/butterchurn-iframe/feed';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  plugins: [stubApi],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const { startEvilandProducer, frameBus, feedSampleRate } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const FFT = 2048;
const BINS = FFT / 2;

// The engine as the producer sees it: the test sets what the analyser reads.
const engine = {
  rate: 44100,
  spectrum: new Uint8Array(BINS),
  wave: new Uint8Array(FFT).fill(128),
  ctx: { state: 'running', resume: async () => {} },
  fftSize: FFT,
  frequencyBinCount: BINS,
  getSampleRate() { return this.rate; },
  getState() { return { trackId: 1 }; },
  getPlaybackPosition() { return 0; },
  getFreqData(buf) { buf.set(this.spectrum); },
  getOnsetFreqData(buf) { buf.set(this.spectrum); },
  getLeftFreqData(buf) { buf.set(this.spectrum); },
  getRightFreqData(buf) { buf.set(this.spectrum); },
  getOnsetTimeData(buf) { buf.set(this.wave); },
};

const posted = [];
const port = { postMessage: (payload) => posted.push({ ...payload, wave: payload.wave ? Uint8Array.from(payload.wave) : undefined }), close() {}, start() {} };

const ui = {
  director: true, seed: null, nonce: 0, waveMode: 'auto', trackId: 1, cueStart: null, projectorQuality: 'medium', transport: null,
};
const stop = startEvilandProducer(engine, () => ui);
frameBus.attachDetachedPort(port);
assert.equal(intervals.size, 1, 'attaching a projector starts the producer loop');

const tick = (times = 1) => {
  for (let i = 0; i < times; i += 1) {
    clock.t += 33;
    for (const fn of intervals.values()) fn();
  }
};
const diag = () => window.__newampProducerDiag;
const lastPayload = () => posted.at(-1);

const lowHalf = new Uint8Array(BINS);
const highHalf = new Uint8Array(BINS);
for (let i = 0; i < BINS; i += 1) (i < BINS / 2 ? lowHalf : highHalf)[i] = 200;

// ── 1. The reactor's memory belongs to the track that built it ──────────────
// How long the reactor takes to call a section depends on its detector, so the
// passages alternate until it has one rather than for a fixed time.
const PASSAGE_TICKS = 130;
const MAX_PASSAGES = 20;
let passages = 0;
while (diag().sectionId < 1 && passages < MAX_PASSAGES) {
  engine.spectrum = passages % 2 === 0 ? lowHalf : highHalf;
  tick(PASSAGE_TICKS);
  passages += 1;
}
assert.ok(diag().sectionId >= 1, `setup: ${passages} alternating passages should have built a section (sectionId ${diag().sectionId})`);

ui.trackId = 2;
tick(2);
assert.equal(diag().sectionId, 0, 'a track change starts the reactor over: the new track begins at section 0');
const memoryRemains = (() => {
  ui.trackId = 2;
  tick(40);
  return diag().sectionId;
})();
assert.ok(memoryRemains <= 1, `the new track builds its own structure from scratch (sectionId ${memoryRemains})`);

// ── 2. MilkDrop is fed the latest contiguous samples at the rate it is told ─
engine.rate = 48000;
tick(20); // past the rate check
for (let i = 0; i < FFT; i += 1) engine.wave[i] = i % 251 < 125 ? 150 : 106;
prefs['newamp:viz:reactivity'] = 'truth';
tick(20); // the producer re-reads the toolbar tuning twice a second
const payload = lastPayload();
assert.equal(payload.sampleRate, feedSampleRate(48000), 'the projector is told the rate of the samples in the wave');
assert.deepEqual(Array.from(payload.wave), Array.from(engine.wave.subarray(FFT - 1024)), 'the wave is the most recent 1024 samples, not every other one');

// A device rate above what the frame accepts is filtered and reported at the lower rate.
engine.rate = 192000;
tick(20);
assert.equal(lastPayload().sampleRate, 96000);

// ── 3. A rate change moves the band map with it ─────────────────────────────
// A tone near 15.5 kHz belongs in the top band whatever the rate; a reactor
// left at the rate of the previous track would put it somewhere else.
const topBand = (rate) => {
  engine.rate = rate;
  const spectrum = new Uint8Array(BINS);
  const bin = Math.round(15500 / (rate / FFT));
  for (let k = -2; k <= 2; k += 1) spectrum[bin + k] = 220;
  engine.spectrum = spectrum;
  tick(40);
  const bands = Array.from(lastPayload().frame.bands);
  return bands.indexOf(Math.max(...bands));
};
assert.equal(topBand(44100), 23);
assert.equal(topBand(96000), 23, 'after the device moves to 96 kHz the top band still holds 15.5 kHz');
assert.equal(topBand(44100), 23);

// ── 4. Stopping ─────────────────────────────────────────────────────────────
stop();
assert.equal(intervals.size, 0, 'stopping the producer clears its timer');

console.log('[eviland-producer-test] PASS');
