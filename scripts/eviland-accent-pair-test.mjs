// The second accent through the engine's shared plumbing: a fade between an old
// look (no accent2) and a new one starts and ends on each side's own partner,
// the partner is stable per look, the producer reads the palette the way the main
// window does, and the audio cues carry the mood fields.
// Run: node scripts/eviland-accent-pair-test.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = resolve('tmp/e2-engine');
mkdirSync(out, { recursive: true });
async function load(entry, name) {
  await build({ entryPoints: [resolve(entry)], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: resolve(out, name), logLevel: 'silent' });
  return import(pathToFileURL(resolve(out, name)).href + `?t=${Date.now()}`);
}
const ops = await load('src/visualizer/eviland-operators.ts', 'ops.mjs');
const app = await load('src/visualizer/eviland-appearance.ts', 'app.mjs');

const failures = [];
const fail = (m) => failures.push(m);
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

const oldLook = { bg: [0.01, 0.01, 0.02], dark: [0.1, 0.2, 0.5], accent: [0.2, 0.8, 0.4], light: [0.8, 1, 0.9] };
const newLook = { bg: [0.02, 0.01, 0.01], dark: [0.5, 0.1, 0.2], accent: [1, 0.3, 0.2], light: [1, 0.9, 0.8], accent2: [0.9, 0.2, 0.8] };

const withPalette = (seed, palette) => ({ ...ops.defaultConfig(), seed, palette });
const a = withPalette('old-look', oldLook);
const b = withPalette('new-look', newLook);

// accentPair is stable for a look and independent of the call order.
const p1 = app.accentPair(oldLook, 'old-look');
app.accentPair(newLook, 'new-look');
const p2 = app.accentPair(oldLook, 'old-look');
if (!near(p1, p2, 0)) fail('accentPair is not stable for one look');

// lerpConfig: ends on each side's own second accent.
const atStart = ops.lerpConfig(a, b, 0).palette.accent2;
const atEnd = ops.lerpConfig(a, b, 1).palette.accent2;
if (!near(atStart, p1, 1e-9)) fail(`fade start accent2 ${atStart} is not the old look's partner ${p1}`);
if (!near(atEnd, newLook.accent2, 1e-9)) fail(`fade end accent2 ${atEnd} is not the new look's own`);

// lerpConfigInto agrees with lerpConfig at every step and never aliases.
const into = ops.cloneConfig(a);
let worstGap = 0;
let prev = null;
let maxStep = 0;
for (let i = 0; i <= 20; i++) {
  const t = i / 20;
  ops.lerpConfigInto(into, a, b, t);
  const ref = ops.lerpConfig(a, b, t).palette.accent2;
  const got = into.palette.accent2;
  if (!got) { fail(`lerpConfigInto left no accent2 at t=${t}`); continue; }
  worstGap = Math.max(worstGap, ...got.map((v, k) => Math.abs(v - ref[k])));
  if (prev) maxStep = Math.max(maxStep, ...got.map((v, k) => Math.abs(v - prev[k])));
  prev = [...got];
  if (into.palette.accent2 === newLook.accent2 || into.palette.accent2 === p1) fail('lerpConfigInto aliased an input colour');
}
if (worstGap > 1e-9) fail(`lerpConfigInto and lerpConfig differ by ${worstGap}`);
// A snap would put the whole distance between the ends into one step; an even
// fade puts 5% of it there, and OKLCh through a wide hue arc stays well under 4x that.
const travel = Math.max(...atEnd.map((v, k) => Math.abs(v - atStart[k])));
if (maxStep > travel * 0.2) fail(`accent2 moves ${maxStep.toFixed(3)} of ${travel.toFixed(3)} in one 5% fade step: a snap`);

// Two old looks fade through their partners, so the result carries a second accent
// that matches each end.
const old2 = withPalette('other-old', { ...oldLook, accent: [0.9, 0.5, 0.1] });
const bothOld = ops.lerpConfig(a, old2, 0).palette.accent2;
if (!bothOld || !near(bothOld, p1, 1e-9)) fail('a fade between two old looks has no partner at its start');

// The projector reads the palette the way the main window does.
const producer = readFileSync(resolve('src/visualizer/eviland-producer.ts'), 'utf8');
if (!/themePaletteFromAccent\(/.test(producer)) fail('producer does not build its palette with themePaletteFromAccent');
if (!/--viz-light/.test(producer) || !/--accent-dim/.test(producer)) fail('producer ignores --viz-light or --accent-dim');
if (!/frame\.score\?\.minor, frame\.score\?\.keyConfidence/.test(producer)) fail('producer does not pass the mood cues to resolveEvilandPalette');

// ScoreCues carries the mood fields.
const audio = readFileSync(resolve('src/visualizer/eviland-audio.ts'), 'utf8');
const cues = audio.slice(audio.indexOf('export interface ScoreCues'), audio.indexOf('}', audio.indexOf('export interface ScoreCues')));
if (!/minor: number/.test(cues) || !/keyConfidence: number/.test(cues)) fail('ScoreCues lacks minor / keyConfidence');

// ── The engine's tints ─────────────────────────────────────────────────────
// Bundled for node: refreshTints is what the engine runs when the palette changes.
const eng = await load('src/visualizer/eviland.ts', 'eviland.mjs');
const sideOf = (palette, seed) => app.accentPair(palette, seed);
// Two seeds that put the partner on opposite sides of the accent.
let seedA = 'a0';
let seedB = null;
for (let i = 0; i < 64 && !seedB; i++) {
  if (!near(sideOf(oldLook, seedA), sideOf(oldLook, `b${i}`), 1e-6)) seedB = `b${i}`;
}
if (!seedB) fail('no seed found that moves the partner to the other side');
else {
  const t = eng.createTints();
  eng.refreshTints(t, oldLook, seedA);
  const partnerA = sideOf(oldLook, seedA);
  if (!near(t.second, partnerA, 1e-9)) fail(`tints took ${t.second} for a look without accent2, not the seed's partner ${partnerA}`);
  if (!near(t.sun.subarray(0, 3), oldLook.accent, 1e-3)) fail('the sun table does not start on the accent');
  if (!near(t.sun.subarray(t.sun.length - 3), partnerA, 2e-3)) fail('the sun table does not end on the partner');
  const secondBefore = t.second;
  eng.refreshTints(t, { ...oldLook }, seedA);
  if (t.second !== secondBefore) fail('refreshTints rebuilt for a palette that did not change');
  eng.refreshTints(t, oldLook, seedB);
  if (near(t.second, partnerA, 1e-6)) fail('a different look seed did not move the partner: the cache ignored the seed');
  if (!near(t.second, sideOf(oldLook, seedB), 1e-9)) fail('tints do not follow the new look seed');
  // A palette that brings its own accent2 uses it whatever the seed, and ignores a seed change afterwards.
  eng.refreshTints(t, newLook, seedA);
  if (!near(t.second, newLook.accent2, 1e-9)) fail('tints ignored the palette\'s own accent2');
  if (!near(t.sun.subarray(t.sun.length - 3), newLook.accent2, 2e-3)) fail('the sun table does not end on the palette\'s accent2');
  const built = t.second;
  eng.refreshTints(t, newLook, seedB);
  if (t.second !== built) fail('a seed change rebuilt tints for a palette that carries its own accent2');
  // The end of a fade lands on the new look's colours.
  eng.refreshTints(t, ops.lerpConfig(a, b, 1).palette, seedA);
  if (!near(t.second, newLook.accent2, 1e-9)) fail('the fade end did not land on the new look\'s accent2');
}

// ── The overlay and the particle layer pick the same partner as the engine ───
const noop = () => {};
function recordingCanvas() {
  const strokes = [];
  const ctx = new Proxy({}, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop: noop });
      return noop;
    },
    set: (target, key, value) => {
      target[key] = value;
      if (key === 'strokeStyle') strokes.push(value);
      return true;
    },
  });
  return { strokes, canvas: { clientWidth: 640, clientHeight: 360, width: 0, height: 0, getContext: () => ctx } };
}
const overlayMod = await load('src/visualizer/reactor-overlay.ts', 'overlay.mjs');
const snareFrame = () => ({
  bass: 0, pan: 0, bands: new Float32Array(24),
  onsets: [{ group: 'snare', band: 10, intensity: 1, sharpness: 1 }],
});
const snareRgb = (palette, seed) => {
  const { strokes, canvas } = recordingCanvas();
  const overlay = overlayMod.createReactorOverlay(canvas);
  overlay.render(snareFrame(), palette, 16, 1, seed);
  const m = /rgba\((\d+), (\d+), (\d+),/.exec(strokes[0] ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
// What the overlay paints a snare with: the second accent mixed 0.7/0.7/0.8 toward the light role.
const expectSnare = (second, light) => [0, 1, 2].map((i) => Math.round((second[i] + (light[i] - second[i]) * (i === 2 ? 0.8 : 0.7)) * 255));
const overlayOld = snareRgb(oldLook, seedA);
const overlayOtherSide = snareRgb(oldLook, seedB);
if (!overlayOld || !overlayOtherSide) fail('the overlay drew no snare spike to read a colour from');
else {
  if (!near(overlayOld, expectSnare(sideOf(oldLook, seedA), oldLook.light), 1)) fail(`overlay snare ${overlayOld} is not the seed's partner mixed toward light`);
  if (!near(overlayOtherSide, expectSnare(sideOf(oldLook, seedB), oldLook.light), 1)) fail('the overlay did not follow a look seed on the other side');
  if (near(overlayOld, overlayOtherSide, 0)) fail('the overlay painted the same snare colour for seeds on opposite sides');
  const own = snareRgb(newLook, seedA);
  if (!near(own, expectSnare(newLook.accent2, newLook.light), 1)) fail('the overlay ignored the palette\'s own accent2');
}

// The particle layer: a stub WebGL context that records the u_accent2 it is given.
const particleMod = await load('src/visualizer/particle-flow.ts', 'particles.mjs');
function stubGl() {
  const uniforms = new Map();
  let nextLoc = 1;
  const locs = new Map();
  const gl = new Proxy({}, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'getUniformLocation') return (prog, name) => { if (!locs.has(name)) locs.set(name, { name, id: nextLoc++ }); return locs.get(name); };
      if (key === 'uniform3f') return (loc, x, y, z) => { if (loc) uniforms.set(loc.name, [x, y, z]); };
      if (key === 'getShaderParameter' || key === 'getProgramParameter') return () => true;
      if (key === 'getAttribLocation') return () => 0;
      if (key === 'getError') return () => 0;
      if (key === 'getExtension') return () => null;
      if (key === 'isContextLost') return () => false;
      if (key === 'getParameter') return () => 0;
      if (typeof key === 'symbol') return undefined;
      if (/^[A-Z_0-9]+$/.test(key)) return 1;
      return () => ({});
    },
  });
  const canvas = { width: 640, height: 360, clientWidth: 640, clientHeight: 360, getContext: () => gl, addEventListener: noop, removeEventListener: noop };
  return { canvas, uniforms };
}
const features = { bass: 0.3, mid: 0.3, treble: 0.3, rms: 0.3, beat: 0, kick: 0, beatEdge: false };
const particleSecond = (accent, accent2, seed) => {
  const { canvas, uniforms } = stubGl();
  const renderer = particleMod.createParticleFlowRenderer(canvas, { particles: 16 });
  if (!renderer) return null;
  renderer.render(features, accent, 1 / 60, accent2, seed);
  return uniforms.get('u_accent2') ?? null;
};
const pf = particleSecond(oldLook.accent, undefined, seedA);
if (!pf) fail('the particle layer could not be driven with a stub context');
else {
  if (!near(pf, sideOf(oldLook, seedA), 1e-6)) fail('particle layer partner does not match the engine\'s for the same seed');
  if (!near(particleSecond(oldLook.accent, undefined, seedB), sideOf(oldLook, seedB), 1e-6)) fail('particle layer ignored the look seed');
  if (!near(particleSecond(newLook.accent, newLook.accent2, seedA), newLook.accent2, 1e-6)) fail('particle layer ignored a given accent2');
}

// ── The projector resolves the palette the main window does ─────────────────
// The producer is bundled with its palette resolver and score feed wrapped: the
// first records what it is called with, the second stamps a minor-key cue the
// way the conductor would.
const css = { '--accent': '#ff4d6d', '--accent-dim': '#40101c', '--bg': '#0a0608', '--viz-light': '#ffd6e0' };
const prefs = { 'newamp:viz:palette': 'theme' };
globalThis.__palCalls = [];
const clock = { t: 1000 };
const intervals = new Map();
let nextTimer = 1;
globalThis.performance = { now: () => clock.t };
globalThis.window = {
  localStorage: { getItem: (k) => prefs[k] ?? null, setItem: (k, v) => { prefs[k] = v; } },
  setInterval: (fn) => { const id = nextTimer++; intervals.set(id, fn); return id; },
  clearInterval: (id) => { intervals.delete(id); },
  setTimeout: () => nextTimer++, clearTimeout: noop, addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
};
globalThis.Image = class { set src(_) {} };
globalThis.document = { hidden: false, documentElement: {}, createElement: () => ({ getContext: () => null }) };
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => css[name] ?? '' });
const appearancePath = resolve('src/visualizer/eviland-appearance.ts');
const wrap = {
  name: 'wrap',
  setup(bld) {
    bld.onResolve({ filter: /[\\/]lib[\\/]api$/ }, () => ({ path: 'stub-api', namespace: 'stub' }));
    bld.onResolve({ filter: /eviland-appearance$/ }, (args) => (args.importer.endsWith('eviland-producer.ts') ? { path: 'wrapped-appearance', namespace: 'stub' } : null));
    bld.onResolve({ filter: /eviland-score-feed$/ }, (args) => (args.importer.endsWith('eviland-producer.ts') ? { path: 'fake-feed', namespace: 'stub' } : null));
    bld.onLoad({ filter: /^stub-api$/, namespace: 'stub' }, () => ({
      contents: `const none = async () => null; const own = { getArtUrl: (id) => 'art://' + id }; export const api = new Proxy(own, { get: (t, k) => (k in t ? t[k] : none) });`,
      loader: 'js',
    }));
    bld.onLoad({ filter: /^wrapped-appearance$/, namespace: 'stub' }, () => ({
      contents: `import { resolveEvilandPalette as real } from ${JSON.stringify(appearancePath)};
        export * from ${JSON.stringify(appearancePath)};
        export function resolveEvilandPalette(...args) { globalThis.__palCalls.push(args); return real(...args); }`,
      loader: 'js', resolveDir: process.cwd(),
    }));
    bld.onLoad({ filter: /^fake-feed$/, namespace: 'stub' }, () => ({
      contents: `export function createEngineScoreFeed() {
        return { conduct(frame) { frame.score = { anticipation: 0, blackout: 0, impact: 0, impactStart: false, tier: 'steady', keyShift: 0.05, minor: 1, keyConfidence: 0.75, arc: 0.5, downbeat: false, toBoundary: Infinity }; return frame; }, dispose() {} };
      }`,
      loader: 'js',
    }));
  },
};
const bundled = await build({
  stdin: { contents: `export { startEvilandProducer } from './src/visualizer/eviland-producer'; export { frameBus } from './src/visualizer/frame-bus';`, resolveDir: process.cwd(), loader: 'ts' },
  plugins: [wrap], bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const prod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const BINS = 1024;
const engineStub = {
  ctx: { state: 'running', resume: async () => {} }, fftSize: 2048, frequencyBinCount: BINS,
  getSampleRate: () => 44100, getState: () => ({ trackId: 1 }), getPlaybackPosition: () => 0,
  getFreqData: (buf) => buf.fill(0), getOnsetFreqData: (buf) => buf.fill(0), getLeftFreqData: (buf) => buf.fill(0),
  getRightFreqData: (buf) => buf.fill(0), getOnsetTimeData: (buf) => buf.fill(128),
};
const ui = { director: true, seed: null, nonce: 0, waveMode: 'auto', trackId: 1, cueStart: null, projectorQuality: 'medium', transport: null };
const stopProducer = prod.startEvilandProducer(engineStub, () => ui);
prod.frameBus.attachDetachedPort({ postMessage: noop, close: noop, start: noop });
for (let i = 0; i < 3; i++) { clock.t += 33; for (const fn of intervals.values()) fn(); }
stopProducer();
const call = globalThis.__palCalls.at(-1);
if (!call) fail('the producer never resolved a palette');
else {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  // What Visualizer.tsx's readThemePalette builds from the same skin variables.
  const mainWindow = app.themePaletteFromAccent(hex(css['--accent']), hex(css['--accent-dim']), hex(css['--bg']), hex(css['--viz-light']));
  const theme = call[1];
  for (const k of ['accent', 'dark', 'light', 'bg', 'accent2']) {
    if (!theme[k] || !near(theme[k], mainWindow[k], 2e-3)) fail(`producer theme palette ${k} ${theme[k]} differs from the main window's ${mainWindow[k]}`);
  }
  if (call[0] !== 'theme') fail(`producer resolved mode ${call[0]}, expected the stored 'theme'`);
  if (call[3] !== 0.05) fail(`producer passed key shift ${call[3]} in the keyShift slot`);
  if (call[6] !== 1 || call[7] !== 0.75) fail(`producer passed mood (${call[6]}, ${call[7]}) in the last two slots, expected (1, 0.75)`);
  // Handed the same arguments, the shared resolver gives the same palette every host gets.
  const again = app.resolveEvilandPalette(call[0], mainWindow, call[2], call[3], call[4], call[5], call[6], call[7]);
  const viaProducer = app.resolveEvilandPalette(...call);
  for (const k of ['accent', 'dark', 'light', 'accent2']) {
    if (!near(again[k], viaProducer[k], 2e-3)) fail(`resolved ${k} differs between the projector and the main window`);
  }
}

if (failures.length) {
  console.error(failures.map((f) => 'FAIL: ' + f).join('\n'));
  console.error('[eviland-accent-pair-test] FAIL');
  process.exit(1);
}
console.log(`accent2 fade: lerpConfigInto vs lerpConfig worst gap ${worstGap.toExponential(1)}, largest step ${maxStep.toFixed(3)} per 5% of the fade`);
console.log('[eviland-accent-pair-test] PASS');
