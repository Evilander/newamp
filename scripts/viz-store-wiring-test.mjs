// The Eviland and visualizer-preset actions of the real player store: a
// randomized look is kept as a seed code that pastes back, next and previous
// look reach the Directors (or become a new look when you are holding one of
// your own), and a held arrow key stepping through presets is not undone by
// the saves coming back late.
// Run: node scripts/viz-store-wiring-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map(frame => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('Viz store test timed out'); process.exit(1); }, 90000);
deadline.unref();

class Param {
  constructor(value = 0) { this.value = value; }
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
}
class Node {
  constructor() { this.gain = new Param(1); }
  connect() {}
  disconnect() {}
}
class Context {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = new Node(); }
  createGain() { return new Node(); }
  createBiquadFilter() { return Object.assign(new Node(), { gain: new Param(), frequency: new Param(), Q: new Param() }); }
  createDynamicsCompressor() { return Object.assign(new Node(), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(k => [k, new Param()]))); }
  createAnalyser() { return new Node(); }
  createChannelSplitter() { return new Node(); }
  createMediaElementSource() { return new Node(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
class Audio {
  constructor() { this.src = ''; this.currentSrc = ''; this.currentTime = 0; this.duration = 180; this.paused = true; this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
  play() { this.paused = false; this.currentSrc = this.src; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
globalThis.Audio = Audio;
globalThis.AudioContext = Context;
globalThis.document = { documentElement: { dataset: {}, style: { removeProperty() {}, setProperty() {} } } };
globalThis.window = {
  newamp: {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  location: { search: '' },
  winctl: { notifyPlayback() {} },
};
const makeStorage = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
};

const root = resolve('tmp/viz-store-wiring-test');
mkdirSync(root, { recursive: true });
const bundlePath = resolve(root, 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './src/store/usePlayerStore';
      export { api, DEFAULT_SETTINGS } from './src/lib/api';
      export { createLookRequestCursor } from './src/visualizer/look-requests';
      export { decode, generate, seedCodeFor } from './src/visualizer/eviland-randomizer';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: bundlePath, define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent',
});

let instances = 0;
/** A fresh copy of the store module over fresh localStorage. */
async function load() {
  globalThis.localStorage = makeStorage();
  const mod = await import(`${pathToFileURL(bundlePath).href}?instance=${instances++}`);
  await new Promise(queueMicrotask);
  const { api, usePlayerStore: store, DEFAULT_SETTINGS } = mod;
  const rig = { mod, api, store, settings: { ...DEFAULT_SETTINGS }, saves: [] };
  api.setSettings = async (patch) => { rig.saves.push(patch); rig.settings = { ...rig.settings, ...patch }; return rig.settings; };
  api.getSettings = async () => rig.settings;
  store.setState({ settings: rig.settings });
  return rig;
}
const CODE = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const director = () => {
  const calls = [];
  return { calls, skip: () => calls.push('skip'), previous: () => { calls.push('previous'); return true; } };
};

// ── Randomize keeps a code that pastes back ─────────────────────────────────
{
  const first = await load();
  const second = await load();
  first.store.getState().randomizeEviland();
  second.store.getState().randomizeEviland();
  const a = first.store.getState().evilandSeed;
  const b = second.store.getState().evilandSeed;
  assert.match(a, CODE, 'the seed box holds a code, not a counter');
  assert.match(b, CODE);
  assert.notEqual(a, b, 'two fresh sessions do not begin on the same look');
  assert.equal(first.store.getState().evilandDirector, false, 'a look of your own stays up');
  assert.equal(first.store.getState().evilandConfigNonce, 1);

  // Pasting what the box shows gives the same look back.
  const shown = first.store.getState().evilandSeed;
  assert.equal(first.store.getState().applyEvilandCode(shown), true);
  assert.equal(first.store.getState().evilandSeed, shown);
  assert.equal(first.mod.decode(shown).seed, shown);

  first.store.getState().randomizeEviland();
  assert.notEqual(first.store.getState().evilandSeed, shown, 'each randomize is a new look');
  assert.equal(first.store.getState().evilandConfigNonce, 3);

  // A code typed in stays that code; other text is turned into one that gives the same look every time.
  first.store.getState().randomizeEviland(shown.toLowerCase());
  assert.equal(first.store.getState().evilandSeed, shown);
  first.store.getState().randomizeEviland('  my seed  ');
  const typed = first.store.getState().evilandSeed;
  assert.match(typed, CODE);
  assert.equal(typed, first.mod.seedCodeFor('my seed'));
  assert.equal(first.mod.decode(typed).name, first.mod.generate('my seed').config.name, 'the code regenerates the look the text made');
  second.store.getState().randomizeEviland('my seed');
  assert.equal(second.store.getState().evilandSeed, typed, 'on another machine too');
}

// ── Next look and previous look ─────────────────────────────────────────────
{
  const rig = await load();
  const { store, mod } = rig;
  store.setState({ evilandDirector: true });
  const cursor = mod.createLookRequestCursor();
  const d = director();

  store.getState().skipEvilandLook();
  cursor.drain(d, true);
  assert.deepEqual(d.calls, ['skip'], 'with the Director driving, skip reaches the Director');
  assert.equal(store.getState().evilandConfigNonce, 0, 'and does not make a manual look');
  assert.equal(store.getState().evilandDirector, true);

  store.getState().previousEvilandLook();
  cursor.drain(d, true);
  assert.deepEqual(d.calls, ['skip', 'previous'], 'previous reaches it too');

  // With a look of your own up, next is a new look of your own; previous has no history.
  store.getState().randomizeEviland();
  const shown = store.getState().evilandSeed;
  const nonce = store.getState().evilandConfigNonce;
  const other = director();
  store.getState().skipEvilandLook();
  store.getState().previousEvilandLook();
  cursor.drain(other, true);
  assert.deepEqual(other.calls, [], 'a manual look sends the Director nothing');
  assert.equal(store.getState().evilandConfigNonce, nonce + 1, 'skip drew a new look');
  assert.notEqual(store.getState().evilandSeed, shown);
  assert.match(store.getState().evilandSeed, CODE);
}

// ── A held arrow key through the presets ────────────────────────────────────
{
  const rig = await load();
  const { store, api } = rig;
  // Saves that finish when the test says so, as the main process's replies do.
  const pending = [];
  api.setSettings = (patch) => new Promise((resolve, reject) => {
    pending.push({ patch, resolve: () => { rig.settings = { ...rig.settings, ...patch }; resolve(rig.settings); }, reject });
  });
  const settle = () => new Promise(setImmediate);

  store.getState().setVizPreset('galaxy');
  store.getState().setVizPreset('aurora');
  store.getState().setVizPreset('eviland');
  assert.equal(store.getState().vizPreset, 'eviland');
  assert.equal(pending.length, 3);

  pending[0].resolve();
  await settle();
  assert.equal(store.getState().vizPreset, 'eviland', 'the first save coming back does not put the first preset back');
  assert.equal(store.getState().settings.visualizerPreset, 'eviland', 'and the settings agree with the screen');
  pending[1].resolve();
  await settle();
  assert.equal(store.getState().vizPreset, 'eviland');
  assert.equal(store.getState().settings.visualizerPreset, 'eviland');
  pending[2].resolve();
  await settle();
  assert.equal(store.getState().vizPreset, 'eviland');
  assert.equal(store.getState().settings.visualizerPreset, 'eviland');

  // Replies the other way round: the last one is the one that counts, a late old one changes nothing.
  pending.length = 0;
  store.getState().setVizPreset('spectrum');
  store.getState().setVizPreset('radial');
  pending[1].resolve();
  await settle();
  pending[0].resolve();
  await settle();
  assert.equal(store.getState().vizPreset, 'radial');
  assert.equal(store.getState().settings.visualizerPreset, 'radial');

  // A single pick still takes the main process's normalised answer.
  pending.length = 0;
  store.getState().setVizPreset('tunnel');
  pending[0].patch.visualizerPreset = 'tunnel';
  rig.settings = { ...rig.settings, visualizerPreset: 'tunnel' };
  pending[0].resolve();
  await settle();
  assert.equal(store.getState().vizPreset, 'tunnel');

  // A failed save is not an error and leaves the pick where it is.
  pending.length = 0;
  store.getState().setVizPreset('plasma-grid');
  pending[0].reject(new Error('disk full'));
  await settle();
  assert.equal(store.getState().vizPreset, 'plasma-grid');
}

console.log(JSON.stringify({ ok: true }, null, 2));
process.exit(0);
