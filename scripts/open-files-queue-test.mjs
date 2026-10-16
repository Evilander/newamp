// Files opened from outside the app (Open with, a double-click, a drop) go
// into the listener's queue right after the current track instead of replacing
// it: the real player store is driven against a fake external transport, and
// the renderer wiring is pinned in source.
// Run: node scripts/open-files-queue-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map(frame => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('Open files queue test timed out'); process.exit(1); }, 60000);
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
  setTimeout: (fn, ms, ...args) => setTimeout(fn, ms === 350 ? 1 : ms, ...args),
  clearTimeout, setInterval, clearInterval,
  location: { search: '' },
  winctl: { notifyPlayback() {} },
};
const map = new Map();
globalThis.localStorage = {
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => { map.set(key, String(value)); },
  removeItem: (key) => { map.delete(key); },
};

const root = resolve('tmp/open-files-queue-test');
mkdirSync(root, { recursive: true });
const bundlePath = resolve(root, 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './src/store/usePlayerStore';
      export * from './src/lib/toast';
      export { api, DEFAULT_SETTINGS } from './src/lib/api';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: bundlePath, define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent',
});

const settle = () => new Promise(setImmediate);
const track = (id) => ({
  id, path: `/music/${id}.flac`, artist: 'Artist', album: 'Album', albumArtist: 'Artist', duration: 180,
  title: `T${id}`, replayGainTrackDb: null, replayGainAlbumDb: null, missingSince: null, loved: 0,
  rating: 0, ratingScore: null, avoidAutoPlay: 0, lastPlayed: null,
});
const tracks = (count, from = 1) => Array.from({ length: count }, (_, i) => track(from + i));
const idsOf = (list) => list.map((item) => item.id);

const mod = await import(pathToFileURL(bundlePath).href);
await new Promise(queueMicrotask);
const { api, engine, usePlayerStore: store, DEFAULT_SETTINGS } = mod;
const plays = [];
const settings = { ...DEFAULT_SETTINGS, sampleAccurateGapless: false };
api.setSettings = async (patch) => Object.assign(settings, patch);
api.getSettings = async () => settings;
api.recordPlay = async () => {};
api.recordSkip = async () => {};
api.lastfmUpdateNowPlaying = async () => {};
api.lastfmScrobble = async () => {};
api.onTracksRemoved = () => () => {};
api.getTracks = async () => [];
api.getTracksByIds = async () => [];
api.buildHarmonicMix = async () => [];
api.buildTasteMix = async () => [];
api.getListeningHistory = async () => [];
engine.setExternalTransport({
  play: async (id) => { plays.push(id); return true; },
  pause() {},
  resume() {},
  stop() {},
  seek() {},
  prepareNext() {},
});
store.setState({ settings, autoDjEnabled: false });
const state = () => store.getState();

async function reset(patch = {}) {
  state().clearQueue();
  await settle();
  store.setState({ mode: 'normal', shuffleHistory: [], autoDjEnabled: false, stopAfterCurrent: false, activePodcastEpisode: null, settings, ...patch });
  plays.length = 0;
}

try {
  // ---- a long queue survives an opened file ----
  {
    await reset();
    const queue = tracks(196);
    await state().playQueue(queue, 10);
    plays.length = 0;
    const opened = [track(9001), track(9002), track(9003)];
    await state().playTracksNow(opened);
    assert.equal(state().queue.length, 199, 'the 196 queued tracks all stay');
    assert.deepEqual(idsOf(state().queue.slice(0, 11)), idsOf(queue.slice(0, 11)), 'everything up to the playing track is untouched');
    assert.deepEqual(idsOf(state().queue.slice(11, 14)), [9001, 9002, 9003], 'the opened tracks sit right after the one that was playing');
    assert.deepEqual(idsOf(state().queue.slice(14)), idsOf(queue.slice(11)), 'the rest of the queue follows them in order');
    assert.equal(state().index, 11);
    assert.equal(state().current.id, 9001, 'the first opened track is the one playing');
    assert.deepEqual(plays, [9001], 'and it was handed to the transport');

    // After the opened tracks the old queue carries on from where it was.
    await state().next();
    await state().next();
    await state().next();
    assert.equal(state().current.id, 12, 'the queue resumes with the track that followed the one that was playing');
  }

  // ---- nothing queued: the opened tracks are the queue, as before ----
  {
    await reset();
    const opened = tracks(3, 500);
    await state().playTracksNow(opened);
    assert.deepEqual(idsOf(state().queue), [500, 501, 502]);
    assert.equal(state().index, 0);
    assert.deepEqual(plays, [500]);
  }

  // ---- a queue with no current track (loaded, not started) takes them at the front ----
  {
    await reset();
    state().loadQueue(tracks(5));
    assert.equal(state().index, -1);
    await state().playTracksNow([track(700)]);
    assert.deepEqual(idsOf(state().queue), [700, 1, 2, 3, 4, 5]);
    assert.equal(state().index, 0);
    assert.equal(state().current.id, 700);
  }

  // ---- a podcast episode is not a queue to keep ----
  {
    await reset();
    await state().playQueue(tracks(1, 40), 0);
    store.setState({ activePodcastEpisode: { feedUrl: 'https://example.test/feed', episodeId: 'e1' } });
    await state().playTracksNow([track(800), track(801)]);
    assert.deepEqual(idsOf(state().queue), [800, 801], 'the episode gives way to the opened files');
    assert.equal(state().activePodcastEpisode, null);
  }

  // ---- shuffle: what already played stays played, and the opened track joins the history ----
  {
    await reset({ mode: 'shuffle' });
    const q = tracks(6);
    store.setState({ queue: q, index: 2, current: q[2], shuffleHistory: [4, 0, 2], isPlaying: false });
    await state().playTracksNow([track(900), track(901)]);
    assert.deepEqual(idsOf(state().queue), [1, 2, 3, 900, 901, 4, 5, 6]);
    assert.equal(state().index, 3);
    assert.deepEqual(state().shuffleHistory, [6, 0, 2, 3], 'positions after the splice shift by two; the new track is the latest played');
  }

  // ---- nothing opened changes nothing ----
  {
    await reset();
    await state().playQueue(tracks(4), 1);
    plays.length = 0;
    await state().playTracksNow([]);
    assert.deepEqual(idsOf(state().queue), [1, 2, 3, 4]);
    assert.equal(state().index, 1);
    assert.deepEqual(plays, []);
  }

  // ---- the renderer sends every open path through it ----
  {
    const app = readFileSync(resolve('src/App.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const open = app.match(/async function handleOpenFiles[\s\S]*?\n  }\n/)?.[0] ?? '';
    assert.ok(open, 'handleOpenFiles exists');
    assert.match(open, /playTracksNow\(result\.tracks\)/, 'opened files are inserted, not queued over');
    assert.doesNotMatch(open, /playQueue\(/, 'opened files must not replace the queue');
    const drop = app.match(/async function handleDroppedFiles[\s\S]*?\n  }\n/)?.[0] ?? '';
    assert.match(drop, /handleOpenFiles\(mediaPaths\)/, 'dropped files take the same path as Open with');
    assert.doesNotMatch(drop, /playQueue\(/, 'dropped files must not replace the queue');
    assert.match(app, /api\.onOpenFiles\(\(paths\) => \{\s*void handleOpenFiles\(paths\);/, 'files opened while running take that path');
    assert.match(app, /consumePendingOpenFiles\(\);\s*if \(!cancelled\) await handleOpenFiles\(pending\);/, 'files opened at launch take it too');
  }

  console.log('PASS open files queue: opened tracks play next in the existing queue, an empty queue takes them whole');
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  engine.dispose();
  clearTimeout(deadline);
}
