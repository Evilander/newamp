// Exercise the real engine/store against delayed transport replies and queue edits.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp/playback-lifecycle-test');
mkdirSync(root, { recursive: true });
globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, location: { search: '' }, winctl: { notifyPlayback() {} } };
await build({
  stdin: {
    contents: `export * from './src/store/usePlayerStore';
      export * from './src/lib/toast';
      export { AudioEngine } from './src/audio/engine';
      export { api, DEFAULT_SETTINGS } from './src/lib/api';
      export * from './shared/queue-edit';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve(root, 'bundle.mjs'), define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent',
});
const { AudioEngine, engine, usePlayerStore: store, api, DEFAULT_SETTINGS, getToasts, clearToasts, moveQueueItem, removeQueueItem } = await import(pathToFileURL(resolve(root, 'bundle.mjs')));
await new Promise(queueMicrotask);

function transport(play) {
  return { play, pause() {}, resume() {}, stop() {}, seek() {}, prepareNext() {} };
}
const settle = () => new Promise(setImmediate);

for (const action of ['stop', 'unload']) {
  for (const rejects of [false, true]) {
    const subject = new AudioEngine();
    let finish;
    let stops = 0;
    subject.setExternalTransport({ ...transport(() => new Promise((resolve, reject) => { finish = rejects ? reject : resolve; })), stop() { stops++; } });
    const pending = subject.play('/a.flac', 1, 5);
    subject[action]();
    finish(rejects ? new Error('late decoder error') : true);
    assert.equal(await pending, 'stale', `${action} cancels late acceptance and errors`);
    assert.equal(subject.getState().playing, false);
    assert.equal(subject.getState().error, null);
    assert.equal(stops, 1, 'main must receive cancellation before external playback becomes active');
    subject.dispose();
  }
}

{
  const subject = new AudioEngine();
  let finishOld;
  subject.setExternalTransport(transport((id) => id === 1 ? new Promise((r) => { finishOld = r; }) : Promise.resolve(true)));
  const old = subject.play('/a.flac', 1);
  subject.stop();
  await subject.play('/b.flac', 2);
  finishOld(true);
  assert.equal(await old, 'stale');
  assert.equal(subject.getState().trackId, 2, 'late cancellation must leave the newer playback alone');
  assert.equal(subject.getState().playing, true);
  subject.dispose();
}

// currentSrc starts empty and changes when the assigned resource is selected.
{
  const subject = new AudioEngine();
  const el = Object.assign(new EventTarget(), { src: '/a.wav', currentSrc: '', currentTime: 0, duration: NaN });
  const deck = { el, pendingSeek: null };
  subject.applyStartPosition(deck, 5);
  el.currentSrc = '/a.wav';
  el.duration = 10;
  el.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(el.currentTime, 5, 'metadata must apply the requested offset after resource selection');
  el.duration = NaN;
  subject.applyStartPosition(deck, 7);
  el.src = '/b.wav';
  subject.applyStartPosition(deck, 0);
  el.currentSrc = '/b.wav';
  el.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(el.currentTime, 0, 'a zero-offset replacement must cancel the previous metadata seek');
  subject.dispose();
}

const a = { id: 1, path: '/a.flac', title: 'A', duration: 180 };
const b = { id: 2, path: '/b.flac', title: 'B', duration: 180 };
const plays = [];
const recorded = [];
const saves = [];
api.recordPlay = async (id) => { recorded.push(id); };
api.recordSkip = async () => {};
api.setSettings = async (patch) => { saves.push(patch); return { ...DEFAULT_SETTINGS, ...patch }; };
store.setState({ settings: { ...DEFAULT_SETTINGS }, autoDjEnabled: false });
engine.setExternalTransport(transport(async (id, at) => { plays.push([id, at]); return true; }));

try {
  await store.getState().playQueue([a, b]);
  engine.patchExternal({ currentTime: 37, playing: true });
  store.getState().clearQueue();
  assert.equal(engine.getState().src, null);
  assert.equal(store.getState().isPlaying, false);
  assert.deepEqual(store.getState().queue, []);
  const beforeToggle = plays.length;
  store.getState().togglePlay();
  await settle();
  assert.equal(plays.length, beforeToggle, 'Play on an empty queue cannot resume the cleared track');

  const undo = getToasts().find((toast) => toast.action?.label === 'Undo clear');
  assert.ok(undo, 'clearing a nonempty queue offers Undo');
  undo.action.onClick();
  assert.deepEqual(store.getState().queue, [a, b]);
  assert.equal(store.getState().currentTime, 37);
  assert.equal(store.getState().resumeAt, 37);
  assert.equal(store.getState().isPlaying, false, 'Undo restores paused, even if the track was playing');
  assert.equal(engine.getState().src, null, 'Undo itself cannot start playback');
  await settle();
  assert.equal(saves.at(-1).resumeState.currentTime, 37, 'Undo persists the restored position');
  store.getState().togglePlay();
  await settle();
  assert.deepEqual(plays.at(-1), [1, 37]);

  store.getState().loadQueue([b]);
  assert.equal(engine.getState().src, null, 'loading another queue releases the previous source');
  assert.equal(store.getState().index, -1);
  assert.equal(store.getState().isPlaying, false);
  store.getState().togglePlay();
  await settle();
  assert.deepEqual(plays.at(-1), [2, 0]);

  store.getState().clearQueue();
  const staleUndo = getToasts().at(-1).action;
  store.getState().loadQueue([a]);
  staleUndo.onClick();
  assert.deepEqual(store.getState().queue, [a], 'Undo cannot overwrite a subsequent queue edit');

  store.setState({ queue: [a], index: 0, current: a, currentTime: 10, resumeAt: 10, isPlaying: false });
  store.getState().seek(60);
  assert.equal(store.getState().resumeAt, 60);
  store.getState().togglePlay();
  await settle();
  assert.deepEqual(plays.at(-1), [1, 60], 'Play uses the latest paused seek, not the old restored position');
  assert.equal(store.getState().currentTime, 60);

  store.getState().loadQueue([a, b]);
  store.getState().moveQueuedTrack(0, 1);
  assert.equal(store.getState().index, -1);
  store.getState().togglePlay();
  await settle();
  assert.deepEqual(plays.at(-1), [2, 0], 'editing an idle queue leaves Play pointed at its first entry');

  for (const action of ['clearQueue', 'loadQueue']) {
    let finish;
    engine.setExternalTransport(transport(() => new Promise((r) => { finish = r; })));
    const count = recorded.length;
    const pending = store.getState().playQueue([a]);
    store.getState()[action]([b]);
    finish(true);
    await pending;
    assert.equal(engine.getState().playing, false);
    assert.equal(recorded.length, count, `${action} suppresses side effects from a canceled play`);
  }

  assert.equal(moveQueueItem([a, b], -1, 0, 1).index, -1);
  assert.equal(moveQueueItem([a, b], -1, 0, 0).index, -1);
  assert.equal(removeQueueItem([a, b], -1, 0).removedCurrent, false);
  assert.equal(removeQueueItem([a, b], -1, 0).index, -1);
  assert.equal(moveQueueItem([a, a, b], 1, 2, 0).index, 2, 'repeated songs keep their specific queue slot');
  assert.equal(removeQueueItem([a, a, b], 1, 2).index, 1);
  console.log('PASS playback lifecycle: cancellation, metadata, queue reset, paused seek, idle edits, Undo');
} finally {
  clearToasts();
  engine.dispose();
}
