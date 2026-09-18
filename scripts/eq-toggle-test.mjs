// The real engine + store against a fake Web Audio graph: turning the EQ off
// and back on must re-apply the band gains. It didn't — the store's "on" path
// pushed the band values into the engine but never re-enabled it, and the
// engine ignores band values while disabled, so after one off the EQ was dead
// until restart. Run: node scripts/eq-toggle-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Just enough Web Audio for ensureGraph() ──────────────────────────────
// `target` is where the param is heading: a direct .value write (graph build)
// or the setTargetAtTime ramp the engine uses for live changes.
class FakeParam {
  constructor(value = 0) {
    this.target = value;
  }
  get value() { return this.target; }
  set value(v) { this.target = v; }
  cancelScheduledValues() {}
  setValueAtTime() {}
  linearRampToValueAtTime(value) { this.target = value; }
  setTargetAtTime(target) { this.target = target; }
}
class FakeNode {
  constructor() { this.gain = new FakeParam(1); }
  connect() {}
  disconnect() {}
}
class FakeFilter extends FakeNode {
  constructor() { super(); this.gain = new FakeParam(0); this.frequency = new FakeParam(0); this.Q = new FakeParam(1); }
}
class FakeAudioContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 48000; this.destination = new FakeNode(); this.filters = []; }
  createGain() { return new FakeNode(); }
  createBiquadFilter() { const f = new FakeFilter(); this.filters.push(f); return f; }
  createDynamicsCompressor() { const n = new FakeNode(); for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new FakeParam(0); return n; }
  createAnalyser() { return new FakeNode(); }
  createChannelSplitter() { return new FakeNode(); }
  createMediaElementSource() { return new FakeNode(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
class FakeAudio {
  constructor() { this.listeners = {}; this.src = ''; this.paused = true; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  pause() {}
  load() {}
}
globalThis.AudioContext = FakeAudioContext;
globalThis.Audio = FakeAudio;
globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, location: { search: '' }, winctl: { notifyPlayback() {} } };

const root = resolve('tmp/eq-toggle-test');
mkdirSync(root, { recursive: true });
await build({
  stdin: {
    contents: `export { usePlayerStore, engine } from './src/store/usePlayerStore';
      export { api, DEFAULT_SETTINGS } from './src/lib/api';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve(root, 'bundle.mjs'), define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent',
});
const { usePlayerStore: store, engine, api, DEFAULT_SETTINGS } = await import(pathToFileURL(resolve(root, 'bundle.mjs')));
// The browser stub answers setSettings with defaults + patch; the real main
// process merges into the saved settings. Merge, or every call wipes the curve.
api.setSettings = async (patch) => ({ ...store.getState().settings, ...patch });

const curve = [6, 4, 2, 0, -2, -4, -2, 0, 2, 4];
const flat = curve.map(() => 0);
const bands = () => engine.ctx.filters.map((f) => f.gain.target);
engine.ctx; // build the graph first: the bug is in the live retarget path, not graph construction

store.setState({ settings: { ...DEFAULT_SETTINGS, equalizer: curve, eqEnabled: true } });
await store.getState().setEqEnabled(true);
assert.deepEqual(bands(), curve, 'EQ on: the band gains follow the settings');

await store.getState().setEqEnabled(false);
assert.deepEqual(bands(), flat, 'EQ off: every band goes flat');

await store.getState().setEqEnabled(true);
assert.deepEqual(bands(), curve, 'EQ on again: the band gains must come back (this is the bug)');

// Picking a preset while the EQ is off is an implicit "on".
await store.getState().setEqEnabled(false);
const preset = [3, 3, 0, 0, 0, 0, 0, 0, 3, 3];
await store.getState().setEqPreset(preset);
assert.equal(store.getState().settings.eqEnabled, true, 'a preset turns the EQ on in settings');
assert.deepEqual(bands(), preset, 'a preset chosen while off must be audible');

// A slider moved while the EQ is off is remembered but not applied.
await store.getState().setEqEnabled(false);
await store.getState().setEqBand(0, 9);
assert.equal(bands()[0], 0, 'a band moved while off stays silent');
await store.getState().setEqEnabled(true);
assert.equal(bands()[0], 9, 'and applies once the EQ is on');

console.log('[eq-toggle-test] PASS');
process.exit(0); // the engine's 100 ms tick interval would otherwise keep node alive
