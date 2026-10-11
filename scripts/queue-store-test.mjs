// Queue and session behaviour of the real player store, driven against a fake
// external transport: shuffle cycles that end, history kept across queue edits,
// handoff re-arming, failure caps, the starter queue, remembered view and mode,
// previews, buffering and navigation out of the deck.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Data-URL module names otherwise expand entire bundles in assertion stacks.
Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map(frame => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('Queue store test timed out'); process.exit(1); }, 90000);
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
// The skip-ahead after a playback error waits 350 ms; collapse it so a run of failures finishes quickly.
globalThis.window = {
  newamp: {},
  setTimeout: (fn, ms, ...args) => setTimeout(fn, ms === 350 ? 1 : ms, ...args),
  clearTimeout, setInterval, clearInterval,
  location: { search: '' },
  winctl: { notifyPlayback() {} },
};

function makeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const root = resolve('tmp/queue-store-test');
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
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(condition, ms = 4000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${condition}`);
    await pause(2);
  }
}

const track = (id, extra = {}) => ({
  id, path: `/music/${id}.flac`, artist: 'Artist', album: 'Album', albumArtist: 'Artist', duration: 180,
  title: `T${id}`, replayGainTrackDb: null, replayGainAlbumDb: null, missingSince: null, loved: 0,
  rating: 0, ratingScore: null, avoidAutoPlay: 0, lastPlayed: null, ...extra,
});
const tracks = (count, from = 1) => Array.from({ length: count }, (_, i) => track(from + i));
const idsOf = (list) => list.map((item) => item.id);
const seeded = (seed = 7) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

let instances = 0;
const loaded = [];

/** A fresh copy of the store module (its own engine, its own module state) over fresh localStorage. */
async function load(storageEntries = {}, settingsOverride = {}) {
  const storage = makeStorage(storageEntries);
  globalThis.localStorage = storage;
  const mod = await import(`${pathToFileURL(bundlePath).href}?instance=${instances++}`);
  await new Promise(queueMicrotask);
  const { api, engine, usePlayerStore: store, DEFAULT_SETTINGS } = mod;
  const rig = {
    mod, api, engine, store, storage,
    plays: [], prepares: [], recorded: [], skips: [], saves: [], nowPlaying: [], pauses: 0, stops: 0, onPlay: null,
    settings: { ...DEFAULT_SETTINGS, sampleAccurateGapless: false, ...settingsOverride },
  };
  api.setSettings = async (patch) => { rig.saves.push(patch); rig.settings = { ...rig.settings, ...patch }; return rig.settings; };
  api.getSettings = async () => rig.settings;
  api.recordPlay = async (id) => { rig.recorded.push(id); };
  api.recordSkip = async (id, at) => { rig.skips.push([id, at]); };
  api.lastfmUpdateNowPlaying = async (payload) => { rig.nowPlaying.push(payload.title); };
  api.lastfmScrobble = async () => {};
  api.onTracksRemoved = () => () => {};
  api.getTracks = async () => [];
  api.getTracksByIds = async () => [];
  api.buildHarmonicMix = async () => [];
  api.buildTasteMix = async () => [];
  api.getListeningHistory = async () => [];
  engine.setExternalTransport({
    play: async (id) => { rig.plays.push(id); rig.onPlay?.(id); return true; },
    pause() { rig.pauses += 1; },
    resume() {},
    stop() { rig.stops += 1; },
    seek() {},
    prepareNext(id) { rig.prepares.push(id); },
  });
  store.setState({ settings: rig.settings, autoDjEnabled: false });
  loaded.push(rig);
  return rig;
}

async function reset(rig, patch = {}) {
  rig.mod.clearToasts();
  rig.store.getState().clearQueue();
  await settle();
  rig.store.setState({
    mode: 'normal', shuffleHistory: [], autoDjEnabled: false, sleepTimerEndsAt: null,
    stopAfterCurrent: false, settings: rig.settings, ...patch,
  });
  for (const key of ['plays', 'prepares', 'recorded', 'skips', 'saves', 'nowPlaying']) rig[key].length = 0;
  rig.pauses = 0;
  rig.stops = 0;
  rig.onPlay = null;
  rig.mod.clearToasts();
}

const S = await load();
const { store, engine, api } = S;
const state = () => store.getState();

try {
  // ---- a queue edit keeps what the shuffle has already played ----
  {
    const q = tracks(6);
    const arrange = (mode = 'shuffle') => store.setState({ mode, queue: q, index: 2, current: q[2], shuffleHistory: mode === 'shuffle' ? [4, 0, 2] : [], isPlaying: false });
    arrange();
    state().addTrackToQueue(track(90));
    assert.deepEqual(state().shuffleHistory, [4, 0, 2], 'appending leaves played positions where they were');
    arrange();
    state().queueTrackNext(track(91));
    assert.deepEqual(state().shuffleHistory, [5, 0, 2], 'play next shifts whatever sits after the splice');
    assert.equal(state().index, 2);
    arrange();
    state().queueTracksNext([track(92), track(93)]);
    assert.deepEqual(state().shuffleHistory, [6, 0, 2]);
    arrange();
    state().moveQueuedTrack(0, 5);
    assert.deepEqual(state().shuffleHistory, [3, 5, 1], 'a move carries the history with the tracks');
    assert.equal(state().index, 1);
    arrange();
    await state().removeQueuedTrack(3);
    assert.deepEqual(state().shuffleHistory, [3, 0, 2]);
    arrange();
    await state().removeQueuedTrack(0);
    assert.deepEqual(state().shuffleHistory, [3, 1], 'a removed track leaves the history');
    arrange();
    await state().dropTracks([2]);
    assert.deepEqual(state().shuffleHistory, [3, 0, 1], 'tracks that left the library leave the history too');
    assert.equal(state().current.id, 3);
    arrange('normal');
    state().queueTrackNext(track(94));
    assert.deepEqual(state().shuffleHistory, [], 'outside shuffle there is no history to keep');

    // And in use: after a queue edit the shuffle still does not repeat what it played.
    await reset(S, { mode: 'shuffle' });
    const realRandom = Math.random;
    Math.random = seeded(11);
    try {
      await state().playQueue(tracks(6), 0);
      await state().next();
      await state().next();
      const played = new Set(S.plays);
      assert.equal(played.size, 3);
      state().addTrackToQueue(track(99));
      await state().next();
      await state().next();
      const later = S.plays.slice(3);
      assert.equal(later.length, 2);
      assert.ok(later.every((id) => !played.has(id)), `picked ${later} after playing ${[...played]}`);
      assert.notEqual(later[0], later[1]);
    } finally {
      Math.random = realRandom;
    }
  }

  // ---- a repeat-off shuffle ends after every track; repeat-all starts over; Auto DJ refills ----
  {
    await reset(S, { mode: 'shuffle' });
    await state().playQueue(tracks(3), 0);
    await state().next();
    await state().next();
    assert.equal(new Set(S.plays).size, 3, 'three advances cover three different tracks');
    const before = S.plays.length;
    await state().next();
    assert.equal(S.plays.length, before, 'the fourth advance does not start another track');
    assert.equal(state().isPlaying, false);
    assert.ok(S.pauses >= 1, 'it pauses at the end of the queue');

    await reset(S, { mode: 'shuffle-repeat-all' });
    await state().playQueue(tracks(3), 0);
    await state().next();
    await state().next();
    await state().next();
    assert.equal(S.plays.length, 4, 'repeat-all begins a new shuffle cycle');
    assert.notEqual(S.plays[3], S.plays[2], 'the new cycle does not open with the track that just played');

    // Auto DJ: the queue ends with nothing left to shuffle, the refill supplies more.
    await reset(S, { mode: 'shuffle' });
    store.setState({ autoDjEnabled: true, autoDjTarget: 6 });
    let armed = false;
    let mixCalls = 0;
    api.buildHarmonicMix = async () => { mixCalls += 1; return armed ? tracks(6, 10) : []; };
    await state().playQueue(tracks(3), 0);
    await state().next();
    await state().next();
    await settle();
    await settle();
    assert.equal(state().queue.length, 3, 'nothing to add yet');
    armed = true;
    await state().next();
    assert.equal(state().queue.length, 9, 'the refill ran at the end of the shuffled queue');
    assert.ok(S.plays.at(-1) >= 10, `the next track came from the refill, got ${S.plays.at(-1)}`);
    assert.equal(S.plays.length, 4, 'three tracks, then the first one the refill supplied');
    assert.ok(mixCalls >= 2);
    api.buildHarmonicMix = async () => [];

    // The last track of a repeat-off cycle has no successor to prepare; repeat-all gives it one.
    await reset(S, { mode: 'shuffle' });
    await state().playQueue(tracks(3), 0);
    engine.patchExternal({ currentTime: 175, duration: 180, playing: true });
    assert.equal(S.prepares.length, 1, 'mid-cycle there is a next track to prepare');
    await state().next();
    await state().next();
    S.prepares.length = 0;
    engine.patchExternal({ currentTime: 0, playing: true });
    engine.patchExternal({ currentTime: 175, duration: 180, playing: true });
    assert.deepEqual(S.prepares, [], 'nothing is prepared after the last track of the cycle');
    state().cycleRepeat();
    assert.equal(state().mode, 'shuffle-repeat-all');
    engine.patchExternal({ currentTime: 176 });
    assert.equal(S.prepares.length, 1, 'with repeat-all the opener of the next cycle is prepared');

    // Changing repeat mid-shuffle does not forget what already played.
    await reset(S, { mode: 'shuffle' });
    await state().playQueue(tracks(5), 0);
    await state().next();
    const history = state().shuffleHistory;
    assert.equal(history.length, 2);
    state().cycleRepeat();
    assert.deepEqual(state().shuffleHistory, history);
    assert.notEqual(state().shuffleHistory, history, 'a new array, so a cached handoff pick is dropped');
    state().toggleShuffle();
    assert.deepEqual(state().shuffleHistory, [], 'turning shuffle off clears it');
  }

  // ---- removing the playing track from a shuffle moves on to a track that has not played ----
  {
    const realRandom = Math.random;
    // Old positions 3, 0 and 2 have played and 2 is on air; once it goes, the
    // track that slides into its place (old position 3) has already played.
    const arrange = (mode, history = [3, 0, 2]) => {
      const q = tracks(6);
      store.setState({ mode, queue: q, index: 2, current: q[2], shuffleHistory: history, isPlaying: true });
    };
    try {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        Math.random = seeded(seed);
        for (const remove of ['removeQueuedTrack', 'dropTracks']) {
          await reset(S, { mode: 'shuffle' });
          arrange('shuffle');
          await state()[remove](remove === 'dropTracks' ? [3] : 2);
          assert.equal(S.plays.length, 1, `${remove} starts a track`);
          assert.ok([2, 5, 6].includes(S.plays[0]), `${remove} picked ${S.plays[0]}, which had already played`);
          assert.equal(state().current.id, S.plays[0]);
          const at = state().index;
          assert.deepEqual(state().shuffleHistory, [2, 0, at], `${remove} keeps what played and adds the pick`);
        }
      }
    } finally {
      Math.random = realRandom;
    }

    // Everything left has played: repeat off ends there, repeat-all opens a new cycle.
    const allPlayed = [0, 1, 3, 2];
    await reset(S, { mode: 'shuffle' });
    store.setState({ mode: 'shuffle', queue: tracks(4), index: 2, current: tracks(4)[2], shuffleHistory: allPlayed, isPlaying: true });
    await state().removeQueuedTrack(2);
    assert.equal(S.plays.length, 0, 'the end of the cycle starts nothing');
    assert.equal(state().isPlaying, false);
    assert.equal(state().current.id, 4);

    await reset(S, { mode: 'shuffle-repeat-all' });
    store.setState({ mode: 'shuffle-repeat-all', queue: tracks(4), index: 2, current: tracks(4)[2], shuffleHistory: allPlayed, isPlaying: true });
    await state().removeQueuedTrack(2);
    assert.equal(S.plays.length, 1, 'repeat-all begins a new cycle');
    assert.notEqual(S.plays[0], 4, 'which does not open with the track that played just before');
    assert.equal(state().shuffleHistory.length, 1);

    // Paused, the track that takes the place stays loaded as the current one.
    await reset(S, { mode: 'shuffle' });
    store.setState({ mode: 'shuffle', queue: tracks(6), index: 2, current: tracks(6)[2], shuffleHistory: [3, 0, 2], isPlaying: false });
    await state().removeQueuedTrack(2);
    assert.equal(S.plays.length, 0);
    assert.equal(state().current.id, 4);
  }

  // ---- playing a track again re-arms its gapless prepare ----
  {
    await reset(S);
    const q = tracks(2);
    await state().playQueue(q, 0);
    engine.patchExternal({ currentTime: 175, duration: 180, playing: true });
    assert.deepEqual(S.prepares, [2], 'the next track is prepared inside the last ten seconds');
    engine.patchExternal({ currentTime: 176 });
    assert.equal(S.prepares.length, 1, 'once per track');
    await state().next();
    engine.patchExternal({ currentTime: 0, playing: true });
    await state().prev();
    assert.equal(state().current.id, 1);
    engine.patchExternal({ currentTime: 175, duration: 180, playing: true });
    assert.deepEqual(S.prepares, [2, 2], 'Prev back onto the track prepares its successor again');
    await state().playQueue(q, 0);
    engine.patchExternal({ currentTime: 175, duration: 180, playing: true });
    assert.equal(S.prepares.length, 3, 'so does replaying it from the queue');
  }

  // ---- a crossfade hands off once per play of a track, including a replay of it ----
  {
    // The fake transport stands in for the exclusive path, which never crossfades;
    // report it inactive so the store treats the setting as live.
    const exclusiveInfo = engine.getExclusiveInfo;
    engine.getExclusiveInfo = () => ({ active: false, negotiated: null, fallbackReason: null });
    try {
      await reset(S, { settings: { ...S.settings, crossfadeMs: 4000 } });
      const q = tracks(3);
      await state().playQueue(q, 0);
      engine.patchExternal({ currentTime: 100, duration: 180, playing: true });
      assert.deepEqual(S.plays, [1], 'nothing happens before the fade window');
      engine.patchExternal({ currentTime: 178, duration: 180, playing: true });
      await until(() => S.plays.length === 2);
      assert.deepEqual(S.plays, [1, 2], 'the fade starts the next track');
      await state().prev();
      assert.deepEqual(S.plays, [1, 2, 1]);
      engine.patchExternal({ currentTime: 178.5, duration: 180, playing: true });
      await until(() => S.plays.length === 4);
      assert.deepEqual(S.plays, [1, 2, 1, 2], 'coming back to a track fades out of it again');

      await state().playQueue(q, 0);
      engine.patchExternal({ currentTime: 0, duration: 180, playing: true });
      engine.patchExternal({ currentTime: 178, duration: 180, playing: true });
      await until(() => S.plays.length === 6);
      assert.deepEqual(S.plays, [1, 2, 1, 2, 1, 2], 'so does replaying it from the queue');
      assert.equal(state().current.id, 2);
    } finally {
      engine.getExclusiveInfo = exclusiveInfo;
    }
  }

  // ---- Prev counts a play and wraps with repeat-all ----
  {
    await reset(S, { mode: 'repeat-all' });
    await state().playQueue(tracks(3), 0);
    S.recorded.length = 0;
    engine.patchExternal({ currentTime: 0, playing: true });
    await state().prev();
    assert.equal(state().current.id, 3, 'Prev from the first track wraps to the last with repeat-all');
    assert.deepEqual(S.recorded, [3], 'and counts as a play');
    engine.patchExternal({ currentTime: 0, playing: true });
    await state().prev();
    assert.equal(state().current.id, 2);
    assert.deepEqual(S.recorded, [3, 2]);

    await reset(S);
    await state().playQueue(tracks(3), 0);
    S.recorded.length = 0;
    engine.patchExternal({ currentTime: 0, playing: true });
    await state().prev();
    assert.equal(state().current.id, 1, 'without repeat Prev stays on the first track');
    assert.deepEqual(S.recorded, [], 'restarting the same track is not a new play');
  }

  // ---- a dead drive stops the skipping; missing tracks are passed over ----
  {
    for (const [queueLength, expected] of [[20, 8], [3, 3]]) {
      await reset(S, { mode: 'repeat-all' });
      S.onPlay = () => setImmediate(() => engine.patchExternal({ error: 'drive offline', playing: false }));
      await state().playQueue(tracks(queueLength), 0);
      await until(() => S.mod.getToasts().some((toast) => toast.title === 'Playback stopped'));
      await pause(40);
      assert.equal(S.plays.length, expected, `a ${queueLength}-track queue gives up after ${expected} failures`);
      S.onPlay = null;
    }
    await reset(S, { mode: 'shuffle-repeat-all' });
    S.onPlay = () => setImmediate(() => engine.patchExternal({ error: 'drive offline', playing: false }));
    await state().playQueue(tracks(20), 0);
    await until(() => S.mod.getToasts().some((toast) => toast.title === 'Playback stopped'));
    assert.equal(S.plays.length, 8, 'shuffle gives up too');
    S.onPlay = null;

    await reset(S);
    await state().playQueue([track(1), track(2, { missingSince: 5 }), track(3)], 0);
    await state().next();
    assert.equal(state().current.id, 3, 'Next passes over a track the library knows is missing');
    assert.deepEqual(S.plays, [1, 3]);
  }

  // ---- resolveQueueAdvance ----
  {
    const { resolveQueueAdvance } = S.mod;
    const queue = [{ missingSince: null }, { missingSince: 9 }, { missingSince: null }, { missingSince: 9 }];
    assert.deepEqual(resolveQueueAdvance({ queue, index: 0, mode: 'normal', history: [] }), { index: 2, history: [], atEnd: false });
    assert.equal(resolveQueueAdvance({ queue, index: 2, mode: 'normal', history: [] }).index, 3, 'with nothing playable left it takes the next entry anyway');
    assert.equal(resolveQueueAdvance({ queue: queue.slice(0, 3), index: 2, mode: 'normal', history: [] }).atEnd, true);
    assert.equal(resolveQueueAdvance({ queue: queue.slice(0, 3), index: 2, mode: 'repeat-all', history: [] }).index, 0, 'repeat-all wraps');
    assert.equal(resolveQueueAdvance({ queue: queue.slice(0, 3), index: 2, mode: 'repeat-one', history: [] }).atEnd, true, 'repeat-one does not wrap on a manual Next');
    assert.equal(resolveQueueAdvance({ queue: queue.slice(0, 3), index: 2, mode: 'repeat-one', history: [], afterError: true }).index, 0, 'after an error it moves on');
    assert.deepEqual(resolveQueueAdvance({ queue: [], index: -1, mode: 'normal', history: [] }), { index: -1, history: [], atEnd: true });

    const mixed = [{ missingSince: null }, { missingSince: 3 }, { missingSince: null }];
    const skipped = resolveQueueAdvance({ queue: mixed, index: 0, mode: 'shuffle', history: [0], random: () => 0 });
    assert.equal(skipped.index, 2, 'shuffle passes over the missing pick');
    assert.deepEqual(skipped.history, [1, 0, 2], 'the passed-over track counts as played but Prev will not step onto it');
    const allGone = [{ missingSince: null }, { missingSince: 3 }, { missingSince: 3 }];
    const stuck = resolveQueueAdvance({ queue: allGone, index: 0, mode: 'shuffle', history: [0], random: () => 0 });
    assert.equal(stuck.atEnd, false);
    assert.equal(stuck.index, 1, 'with no playable track left it falls back to the first pick');
    const ended = resolveQueueAdvance({ queue: mixed, index: 2, mode: 'shuffle', history: [0, 1, 2] });
    assert.equal(ended.atEnd, true, 'a finished shuffle cycle is the end of the queue');
    assert.equal(resolveQueueAdvance({ queue: mixed, index: 2, mode: 'shuffle-repeat-all', history: [0, 1, 2] }).atEnd, false);
  }

  // ---- buffering reaches the store ----
  {
    await reset(S);
    await state().playQueue(tracks(1), 0);
    assert.equal(state().isBuffering, false);
    engine.patchExternal({ buffering: true });
    assert.equal(state().isBuffering, false, 'the wait that opens a track is not announced');
    engine.patchExternal({ buffering: false });
    await pause(350);
    assert.equal(state().isBuffering, false, 'a short wait never shows');

    engine.patchExternal({ buffering: true });
    await pause(150);
    engine.patchExternal({ currentTime: 1 });
    assert.equal(state().isBuffering, false, 'other updates do not restart or finish the wait early');
    await until(() => state().isBuffering);
    engine.patchExternal({ currentTime: 2 });
    assert.equal(state().isBuffering, true, 'a wait that lasts is shown');
    engine.patchExternal({ buffering: false });
    assert.equal(state().isBuffering, false, 'and goes as soon as data lands');

    engine.patchExternal({ buffering: true });
    await pause(150);
    engine.patchExternal({ buffering: true, error: 'could not open' });
    await pause(350);
    assert.equal(state().isBuffering, false, 'an error ends the wait');
    engine.patchExternal({ buffering: false, error: null });
  }

  // ---- edited tags reach the queue and the current track ----
  {
    await reset(S);
    const q = tracks(3);
    await state().playQueue(q, 1);
    const queueBefore = state().queue;
    state().refreshTracks([{ ...q[1], title: 'Edited', artist: 'New Artist' }]);
    assert.equal(state().current.title, 'Edited');
    assert.equal(state().current.artist, 'New Artist');
    assert.equal(state().queue[1].title, 'Edited');
    assert.equal(state().queue[0], q[0], 'untouched entries keep their identity');
    state().refreshTracks([track(404, { title: 'Elsewhere' })]);
    assert.notEqual(state().queue, queueBefore);
    const settled = state().queue;
    state().refreshTracks([track(404, { title: 'Elsewhere' })]);
    assert.equal(state().queue, settled, 'a track that is not queued changes nothing');
    const palette = readFileSync(resolve('src/components/QuickPlayPalette.tsx'), 'utf8');
    assert.match(palette, /usePlayerStore\.getState\(\)\.toggleLove\(item\.track\.id\)/, 'palette love goes through the store');
    assert.doesNotMatch(palette, /await api\.toggleLove/, 'palette love no longer bypasses the store');
  }

  // ---- a deliberate jump leaves the deck and the fullscreen visualizer ----
  {
    await reset(S);
    state().setCompactMode(true);
    assert.equal(state().compactMode, true);
    state().navigateToPlaylist(1);
    assert.equal(state().compactMode, false);
    assert.equal(state().view, 'playlist');
    assert.deepEqual(state().pendingNavigation, { kind: 'playlist', playlistId: 1 });
    state().setFullscreenViz(true);
    state().navigateToArtist('Someone');
    assert.equal(state().fullscreenViz, false);
    assert.equal(state().view, 'artists');
    state().setCompactMode(true);
    state().navigateToAlbum('Album', 'Artist');
    assert.equal(state().compactMode, false);
    state().setCompactMode(true);
    state().navigateToTrack({ id: 5, album: 'Album', artist: 'Artist', title: 'T5' });
    assert.equal(state().compactMode, false);
    state().setCompactMode(true);
    state().openView('library');
    assert.equal(state().compactMode, false);
    assert.equal(state().view, 'library');
    state().setCompactMode(true);
    state().setView('home');
    assert.equal(state().compactMode, true, 'plain setView stays put, so opening files into a deck does not expand it');
    state().setCompactMode(false);
    await settle();
  }

  // ---- a preview borrows the player without counting, scrobbling or saving ----
  {
    await reset(S);
    const q = [track(1), track(2)];
    await state().playQueue(q, 1);
    engine.patchExternal({ playing: true, currentTime: 42 });
    S.recorded.length = 0;
    S.nowPlaying.length = 0;
    S.skips.length = 0;
    S.saves.length = 0;
    const queueRef = state().queue;
    await state().previewTrack(track(7));
    assert.equal(S.plays.at(-1), 7);
    assert.equal(state().current.id, 7);
    engine.patchExternal({ currentTime: 20 });
    await state().persistPlaybackSession();
    const saved = S.saves.at(-1).resumeState;
    assert.deepEqual(saved.queueTrackIds, [1, 2], 'the saved session is still the listener\'s queue');
    assert.equal(saved.currentTrackId, 2);
    assert.equal(saved.currentTime, 42);
    const playsDuringPreview = S.plays.length;
    await state().next();
    await state().prev();
    assert.equal(S.plays.length, playsDuringPreview, 'skip controls do nothing during a preview');
    S.saves.length = 0;
    state().endPreview();
    assert.ok(S.saves.length >= 1, 'putting the queue back saves the session');
    assert.ok(
      S.saves.every((save) => JSON.stringify(save.resumeState?.queueTrackIds) === '[1,2]'),
      `no save carried the preview track: ${JSON.stringify(S.saves.map((save) => save.resumeState?.queueTrackIds))}`,
    );
    assert.equal(state().queue, queueRef, 'the same queue comes back');
    assert.equal(state().index, 1);
    assert.equal(state().current.id, 2);
    assert.equal(state().currentTime, 42);
    assert.equal(state().resumeAt, 42);
    assert.equal(state().isPlaying, false);
    assert.equal(engine.getState().src, null);
    assert.deepEqual(S.recorded, [], 'no play was counted');
    assert.deepEqual(S.nowPlaying, [], 'nothing went to Last.fm');
    assert.deepEqual(S.skips, [], 'the interrupted track was not skipped');
    state().endPreview();
    assert.equal(state().current.id, 2, 'ending twice is harmless');

    await state().previewTrack(track(8));
    await state().playQueue([track(3)], 0);
    state().endPreview();
    assert.deepEqual(idsOf(state().queue), [3], 'a play started during the preview is not undone');

    S.api.getTrack = async () => track(7);
    await reset(S);
    await state().previewTrack(track(7));
    state().endPreview();
    assert.deepEqual(state().queue, [], 'previewing from an empty player leaves it empty');
    assert.equal(state().current, null);
  }

  // ---- Play with nothing loaded starts something from the library ----
  {
    await reset(S, { settings: { ...S.settings, libraryRoots: ['/music'] } });
    let mixCalls = 0;
    api.buildTasteMix = async () => {
      mixCalls += 1;
      return [track(1), track(2), track(3, { rating: 5, ratingScore: 95 }), track(4), track(5, { missingSince: 4 })];
    };
    state().togglePlay();
    state().togglePlay();
    await until(() => S.plays.length > 0);
    await settle();
    assert.equal(mixCalls, 1, 'a second press while the first is loading is ignored');
    assert.equal(S.plays.length, 1);
    assert.equal(state().current.id, 3, 'today\'s pick leads');
    assert.ok(!idsOf(state().queue).includes(5), 'missing tracks are left out');
    assert.equal(state().queue.length, 4);
    const toast = S.mod.getToasts().find((item) => item.title === 'Nothing was queued');
    assert.ok(toast, 'it says what it did');
    assert.match(toast.detail, /today's pick, T3/);

    // Nothing rated: the fallback pick is only a candidate. A random that keeps
    // the order puts it first, which must not read as "today's pick".
    await reset(S, { settings: { ...S.settings, libraryRoots: ['/music'] } });
    api.buildTasteMix = async () => [track(1), track(2), track(3)];
    const realRandom = Math.random;
    Math.random = () => 0.999;
    try {
      state().togglePlay();
      await until(() => S.plays.length > 0);
    } finally {
      Math.random = realRandom;
    }
    await settle();
    assert.equal(state().queue[0].id, 1, 'the fallback pick landed first');
    assert.equal(S.mod.getToasts().find((item) => item.title === 'Nothing was queued').detail, 'Playing a shuffle of your library.');

    await reset(S, { settings: { ...S.settings, libraryRoots: ['/music'] } });
    api.buildTasteMix = async () => [];
    api.getTracks = async () => tracks(4, 20);
    state().togglePlay();
    await until(() => S.plays.length > 0);
    assert.ok(S.plays[0] >= 20, 'a library with no taste signal still gets a queue');
    api.getTracks = async () => [];

    await reset(S, { settings: { ...S.settings, libraryRoots: [] } });
    api.buildTasteMix = async () => { throw new Error('should not be asked'); };
    state().togglePlay();
    await pause(30);
    assert.equal(S.plays.length, 0, 'with no library it stays silent');
    assert.deepEqual(S.mod.getToasts(), []);

    await reset(S, { settings: { ...S.settings, libraryRoots: ['/music'] } });
    let release;
    api.buildTasteMix = () => new Promise((done) => { release = done; });
    state().togglePlay();
    await settle();
    await state().playQueue([track(50)], 0);
    release([track(1), track(2)]);
    await pause(30);
    assert.deepEqual(idsOf(state().queue), [50], 'what the listener chose while it was loading wins');
    assert.equal(S.mod.getToasts().find((item) => item.title === 'Nothing was queued'), undefined);
    api.buildTasteMix = async () => [];
  }

  // ---- the newest volume write decides the settings snapshot ----
  {
    await reset(S);
    const writes = [];
    const realSet = api.setSettings;
    api.setSettings = (patch) => new Promise((done) => writes.push({ patch, done }));
    await state().setVolume(0.2);
    await pause(300);
    await state().setVolume(0.9);
    await pause(300);
    assert.equal(writes.length, 2);
    writes[1].done({ ...S.settings, volume: 0.9 });
    await settle();
    writes[0].done({ ...S.settings, volume: 0.2 });
    await settle();
    assert.equal(state().settings.volume, 0.9, 'an older reply arriving late cannot overwrite the newer one');
    api.setSettings = realSet;
  }

  // ---- the playback mode and the last view come back ----
  {
    const first = await load({}, { libraryRoots: ['/music'], firstLaunchTutorialSeen: true });
    first.store.getState().setMode('shuffle-repeat-all');
    assert.equal(first.storage.getItem('newamp:playback-mode'), 'shuffle-repeat-all');
    first.store.getState().clearQueue();
    first.store.getState().setView('albums');
    first.store.getState().setView('settings');
    assert.equal(first.storage.getItem('newamp:view'), 'albums', 'Settings is a detour, not a place to come back to');
    first.store.getState().navigateToArtist('Someone');
    assert.equal(first.storage.getItem('newamp:view'), 'artists', 'navigation is remembered too');

    const second = await load({ 'newamp:playback-mode': 'shuffle-repeat-all', 'newamp:view': 'library' }, { libraryRoots: ['/music'], firstLaunchTutorialSeen: true, resumeState: null });
    assert.equal(second.store.getState().view, 'library', 'the last view is up before init runs');
    await second.store.getState().init();
    assert.equal(second.store.getState().mode, 'shuffle-repeat-all', 'shuffle and repeat survive an empty queue');
    assert.equal(second.store.getState().view, 'library');

    const resumeState = { queueTrackIds: [1], currentTrackId: 1, index: 0, currentTime: 0, mode: 'normal', updatedAt: 1 };
    const third = await load({ 'newamp:playback-mode': 'repeat-one' }, { resumeState });
    third.api.getTracksByIds = async () => [track(1)];
    await third.store.getState().init();
    assert.equal(third.store.getState().queue.length, 1);
    assert.equal(third.store.getState().mode, 'repeat-one', 'the remembered mode wins over the one in the resume state');

    const fourth = await load({ 'newamp:playback-mode': 'sideways' }, { resumeState: { ...resumeState, mode: 'shuffle' } });
    fourth.api.getTracksByIds = async () => [track(1)];
    await fourth.store.getState().init();
    assert.equal(fourth.store.getState().mode, 'shuffle', 'a bad stored value falls back to the resume state');

    const fifth = await load({}, { resumeState: { ...resumeState, mode: 'repeat-all' } });
    fifth.api.getTracksByIds = async () => [track(1)];
    await fifth.store.getState().init();
    assert.equal(fifth.store.getState().mode, 'repeat-all', 'settings from before the mode was stored still restore');

    const { parseStoredView, parseStoredPlaybackMode } = S.mod;
    assert.equal(parseStoredView('library'), 'library');
    assert.equal(parseStoredView('settings'), null);
    assert.equal(parseStoredView('about'), null);
    assert.equal(parseStoredView('nonsense'), null);
    assert.equal(parseStoredView(null), null);
    assert.equal(parseStoredPlaybackMode('shuffle'), 'shuffle');
    assert.equal(parseStoredPlaybackMode('x'), null);

    assert.equal((await load({ 'newamp:view': 'settings' })).store.getState().view, 'home', 'a stored utility view opens Home');
    assert.equal((await load({ 'newamp:view': 'nonsense' })).store.getState().view, 'home');
    assert.equal((await load({})).store.getState().view, 'home', 'a first run opens Home');

    const noLibrary = await load({ 'newamp:view': 'library' }, { libraryRoots: [], firstLaunchTutorialSeen: true });
    await noLibrary.store.getState().init();
    assert.equal(noLibrary.store.getState().view, 'home', 'with no library there is nothing to reopen');
    const tour = await load({ 'newamp:view': 'library' }, { libraryRoots: ['/music'], firstLaunchTutorialSeen: false });
    await tour.store.getState().init();
    assert.equal(tour.store.getState().view, 'home', 'the first-launch tour starts from Home');
    const moved = await load({ 'newamp:view': 'library' }, { libraryRoots: [], firstLaunchTutorialSeen: true });
    moved.store.getState().setView('mixes');
    await moved.store.getState().init();
    assert.equal(moved.store.getState().view, 'mixes', 'a view chosen before init finished is left alone');
  }

  // ---- running init again replaces the removal listener ----
  {
    const rig = await load();
    const active = new Set();
    let subscribed = 0;
    rig.api.onTracksRemoved = (callback) => {
      subscribed += 1;
      active.add(callback);
      return () => { active.delete(callback); };
    };
    await rig.store.getState().init();
    await rig.store.getState().init();
    assert.equal(subscribed, 2);
    assert.equal(active.size, 1, 'only the latest listener is registered');
    const q = tracks(3);
    rig.store.setState({ queue: q, index: 0, current: q[0] });
    [...active][0]([2]);
    await settle();
    assert.deepEqual(idsOf(rig.store.getState().queue), [1, 3]);
  }

  console.log('PASS queue store: shuffle cycles, history, handoff, failures, starter queue, remembered view and mode, previews, navigation');
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  for (const rig of loaded) {
    rig.mod.clearToasts();
    rig.engine.dispose();
  }
  clearTimeout(deadline);
}
