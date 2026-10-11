// The in-house shader modes as they run: what is uploaded to the GPU each frame
// and what is handed back when the mode is left.
//
// startShaderVisualizer() is bundled and run against a fake WebGL2 context and
// a hand-driven display. The shaders themselves are not executed; this checks
// the inputs they get. The phase uniforms (u_bassTime...) are integrals of the
// audio levels over the time each frame covered, so after an hour of uptime a
// frame still moves them by well under a radian, where the old
// `u_time * (0.6 + u_bass)` moved the picture by the uptime times the change
// in the music. The loop paints at its cadence on a 60 Hz display, and the
// canvas gives up its GL context when it leaves the page.
//
// Run: node scripts/viz-shader-runtime-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { FakeCanvas, installFakeDom } from './lib/fake-gl.mjs';

// ── The page ─────────────────────────────────────────────────────────────────
const frames = [];
globalThis.requestAnimationFrame = (fn) => frames.push(fn);
globalThis.cancelAnimationFrame = () => {};
installFakeDom();
globalThis.screen = { width: 1920, height: 1080 };
globalThis.document.documentElement = {};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /[\\/]lib[\\/]api$/ }, () => ({ path: 'api', namespace: 'stub' }));
    b.onResolve({ filter: /[\\/]store[\\/]usePlayerStore$/ }, () => ({ path: 'store', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      loader: 'js',
      contents: args.path === 'store'
        ? 'export const usePlayerStore = Object.assign(() => ({}), { getState: () => ({ current: null }) });'
        : 'const none = async () => null; export const api = new Proxy({ getArtUrl: () => "" }, { get: (t, k) => (k in t ? t[k] : none) });',
    }));
  },
};
const bundled = await build({
  stdin: { contents: `export { startShaderVisualizer } from './src/components/Visualizer';`, resolveDir: process.cwd(), loader: 'ts' },
  plugins: [stubs],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent', jsx: 'automatic',
});
const { startShaderVisualizer } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

// ── A fake engine, display and canvas ────────────────────────────────────────
const FFT = 2048;
const BINS = FFT / 2;
let seed = 5;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const spectrum = new Uint8Array(BINS);
let level = 0.5;
const refill = () => {
  // The music moves a little every frame: the case that broke the old phases.
  level = Math.min(1, Math.max(0.1, level + (rnd() - 0.5) * 0.15));
  for (let i = 0; i < BINS; i += 1) spectrum[i] = Math.round(255 * level * Math.exp(-i / 160) * (0.7 + 0.3 * rnd()));
};
const engine = {
  fftSize: FFT,
  frequencyBinCount: BINS,
  getSampleRate: () => 48000,
  getFreqData: (buf) => { refill(); buf.set(spectrum); },
  getOnsetFreqData: (buf) => buf.set(spectrum),
  getTimeData: (buf) => buf.fill(128),
};

function mount() {
  const written = [];
  const canvas = new FakeCanvas({ onUniform: (_program, name, values) => written.push([name, values]) });
  canvas.clientWidth = 640;
  canvas.clientHeight = 360;
  canvas.isConnected = true;
  canvas.setAttribute = () => {};
  const stop = startShaderVisualizer({
    canvas,
    canvasRef: { current: canvas },
    engine,
    mode: 'burning-cloud',
    tuning: { current: { palette: 'look', reactivity: 'punch' } },
    frameIntervalMs: 1000 / 45,
    dprCap: 1,
    maxPixels: 2_100_000,
  });
  return { canvas, stop, written };
}

// Runs the display for `seconds` at `hz`, starting `startMs` into the page's life.
function runDisplay(startMs, seconds, hz = 60) {
  const period = 1000 / hz;
  for (let i = 0; i * period < seconds * 1000; i += 1) {
    const now = startMs + i * period;
    for (const fn of frames.splice(0)) fn(now);
  }
}

// ── 1. The program takes integrated phases ──────────────────────────────────
const first = mount();
assert.ok(first.stop, 'the shader mode starts on a context that can host it');
const program = first.canvas.fake.find('void main')[0];
assert.ok(program, 'the fragment program was built');
for (const name of ['u_bassTime', 'u_midTime', 'u_beatTime', 'u_bandTime0', 'u_bandTime3']) {
  assert.ok(program.shaders.some((s) => s.source.includes(`uniform`) && s.source.includes(name)), `${name} is declared in the shader`);
}

// An hour into the page's life, two minutes of music at the cadence's 45 fps.
const HOUR = 3_600_000;
const snapshots = [];
const draws = () => first.canvas.fake.draws(program).length;
let lastDraws = 0;
{
  const period = 1000 / 60;
  for (let i = 0; i * period < 120_000; i += 1) {
    const now = HOUR + i * period;
    for (const fn of frames.splice(0)) fn(now);
    if (draws() !== lastDraws) {
      lastDraws = draws();
      const u = program.uniforms;
      snapshots.push({ time: u.u_time, bass: u.u_bassTime, mid: u.u_midTime, beat: u.u_beatTime, band: u.u_bandTime0.slice() });
    }
  }
}
assert.ok(snapshots.length > 5000, `painted ${snapshots.length} frames in two minutes`);
const fps = snapshots.length / 120;
assert.ok(Math.abs(fps - 45) < 1, `45 fps target painted ${fps.toFixed(1)} fps on a 60 Hz display`);

assert.ok(snapshots[0].time < 1, `u_time starts with the mode, not with the page (${snapshots[0].time})`);
let worst = 0;
let worstBand = 0;
for (let i = 1; i < snapshots.length; i += 1) {
  const a = snapshots[i - 1];
  const b = snapshots[i];
  worst = Math.max(worst, Math.abs(b.time - a.time), Math.abs(b.bass - a.bass), Math.abs(b.mid - a.mid), Math.abs(b.beat - a.beat));
  for (let k = 0; k < 4; k += 1) worstBand = Math.max(worstBand, Math.abs(b.band[k] - a.band[k]));
}
assert.ok(worst < 0.05, `a frame moved a phase uniform by ${worst}`);
assert.ok(worstBand < 0.05, `a frame moved a band phase by ${worstBand}`);
// The integral follows the level it integrates.
const lastSnap = snapshots.at(-1);
assert.ok(lastSnap.bass > 5 && lastSnap.bass < lastSnap.time, `bass phase ${lastSnap.bass} after ${lastSnap.time} s`);

// ── 2. Leaving the mode ─────────────────────────────────────────────────────
// Re-running the effect on the same canvas keeps its context for the next run.
first.stop();
assert.equal(first.canvas.fake.log.loseContext, 0, 'a canvas still on the page keeps its context');
// A canvas that has left the page hands its context back at once.
const second = mount();
runDisplay(HOUR, 1);
second.canvas.isConnected = false;
second.stop();
assert.equal(second.canvas.fake.log.loseContext, 1, 'a canvas that left the page loses its context');
assert.equal(second.canvas.fake.log.doubleDelete, 0);

console.log('[viz-shader-runtime-test] PASS');
