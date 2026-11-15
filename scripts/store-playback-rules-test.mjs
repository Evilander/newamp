// Player store and deck behaviour added for a slow network share: a library play
// is counted after half the track (not at start), a track flagged missing gets a
// real attempt before Next passes over it, the saved session is not rewritten
// for position alone, Previous in shuffle can be undone by Next, a failed play
// does not leave an unhandled rejection, a route restart retries once, and deck
// seeks during a scrub collapse into one per window.
// Run: node scripts/store-playback-rules-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map((frame) => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('w2 store test timed out'); process.exit(1); }, 60000);
deadline.unref();
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

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
  addEventListener() {}
  removeEventListener() {}
  createGain() { return new Node(); }
  createBiquadFilter() { return Object.assign(new Node(), { gain: new Param(), frequency: new Param(), Q: new Param() }); }
  createDynamicsCompressor() { return Object.assign(new Node(), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map((k) => [k, new Param()]))); }
  createAnalyser() { return new Node(); }
  createChannelSplitter() { return new Node(); }
  createMediaElementSource() { return new Node(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
class Audio {
  constructor() {
    this.src = ''; this.currentSrc = ''; this.duration = Number.NaN; this.readyState = 0; this.paused = true;
    this.error = null; this.listeners = {}; this.writes = []; this.position = 0;
  }
  get currentTime() { return this.position; }
  set currentTime(value) { this.position = value; this.writes.push(value); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  emit(type) { for (const fn of [...(this.listeners[type] ?? [])]) fn(); }
  play() { this.paused = false; this.currentSrc = this.src; this.emit('play'); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.emit('pause'); } }
  load() { this.readyState = 0; this.duration = Number.NaN; this.position = 0; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  gotMetadata(duration = 200) { this.duration = duration; this.readyState = 4; this.emit('loadedmetadata'); }
}

const fake = { now: 0, nextId: 1, pending: new Map() };
const fakeTimers = {
  setTimeout: (fn, ms) => { const id = fake.nextId++; fake.pending.set(id, { fn, at: fake.now + ms }); return id; },
  clearTimeout: (id) => { fake.pending.delete(id); },
  setInterval: () => fake.nextId++,
  clearInterval: () => {},
};
const advance = (ms) => {
  const target = fake.now + ms;
  for (;;) {
    const due = [...fake.pending].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    fake.now = due[1].at;
    fake.pending.delete(due[0]);
    due[1].fn();
  }
  fake.now = target;
};

globalThis.Audio = Audio;
globalThis.AudioContext = Context;
globalThis.document = { documentElement: { dataset: {}, style: { removeProperty() {}, setProperty() {} } } };
// The skip-ahead after a playback error waits 350 ms; collapse it so a failure finishes quickly.
const realTimers = {
  setTimeout: (fn, ms, ...args) => setTimeout(fn, ms === 350 ? 1 : ms, ...args),
  clearTimeout, setInterval, clearInterval,
};
globalThis.window = { ...realTimers, newamp: {}, location: { search: '' }, winctl: { notifyPlayback() {} } };

const root = resolve('tmp/store-playback-rules-test');
mkdirSync(root, { recursive: true });
const bundlePath = resolve(root, 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './src/store/usePlayerStore';
      export * from './src/lib/toast';
      export { AudioEngine } from './src/audio/engine';
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
const seeded = (seed = 7) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

let instances = 0;
const loaded = [];
async function load() {
  const mod = await import(`${pathToFileURL(bundlePath).href}?instance=${instances++}`);
  await new Promise(queueMicrotask);
  const { api, engine, usePlayerStore: store, DEFAULT_SETTINGS } = mod;
  const rig = {
    mod, api, engine, store,
    plays: [], recorded: [], skips: [], saves: [], scrobbles: [], onPlay: null, gate: null,
    settings: { ...DEFAULT_SETTINGS, sampleAccurateGapless: false },
  };
  api.setSettings = async (patch) => { rig.saves.push(patch); rig.settings = { ...rig.settings, ...patch }; return rig.settings; };
  api.getSettings = async () => rig.settings;
  api.recordPlay = async (id) => { rig.recorded.push(id); };
  api.recordSkip = async (id, at) => { rig.skips.push([id, at]); };
  api.lastfmUpdateNowPlaying = async () => {};
  api.lastfmScrobble = async (played) => { rig.scrobbles.push(played.title); };
  api.onTracksRemoved = () => () => {};
  api.getTracks = async () => [];
  api.getTracksByIds = async () => [];
  api.buildTasteMix = async () => [];
  api.getListeningHistory = async () => [];
  engine.setExternalTransport({
    play: async (id) => { rig.plays.push(id); rig.onPlay?.(id); await rig.gate?.(); return true; },
    pause() {}, resume() {}, stop() {}, seek() {}, prepareNext() {},
  });
  store.setState({ settings: rig.settings, autoDjEnabled: false });
  loaded.push(rig);
  return rig;
}
async function reset(rig, patch = {}) {
  rig.mod.clearToasts();
  rig.store.getState().clearQueue();
  await settle();
  rig.store.setState({ mode: 'normal', shuffleHistory: [], shuffleForward: [], autoDjEnabled: false, settings: rig.settings, ...patch });
  for (const key of ['plays', 'recorded', 'skips', 'saves', 'scrobbles']) rig[key].length = 0;
  rig.onPlay = null;
  rig.gate = null;
  rig.mod.clearToasts();
}

const S = await load();
const { store, engine } = S;
const state = () => store.getState();
const realNow = Date.now;
const realRandom = Math.random;
const realPerformanceNow = performance.now.bind(performance);

// What was heard is measured against the clock, so the clock is the test's: it
// moves with the audio when a listener hears it, and stands still across a jump.
let clock = 1000;
performance.now = () => clock;
/** Listen up to `to`: the position moves `step` seconds per notification, and the clock with it. */
function listen(to, step = 3) {
  let at = engine.getState().currentTime;
  while (at < to - 1e-9) {
    const next = Math.min(to, at + step);
    clock += (next - at) * 1000;
    at = next;
    engine.patchExternal({ currentTime: at });
  }
}
/** The position jumps (a scrub), `after` ms after the last notification. */
function jump(to, after = 0) {
  clock += after;
  engine.patchExternal({ currentTime: to });
}

try {
  // ---- a play is counted after half the track, not at start ----
  {
    await reset(S);
    await state().playQueue(tracks(2), 0);
    assert.deepEqual(S.recorded, [], 'nothing is counted when the track starts');
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(87);
    assert.deepEqual(S.recorded, [], 'a little under half is not a play');
    listen(90);
    assert.deepEqual(S.recorded, [1], 'half the track is');
    listen(117);
    assert.deepEqual(S.recorded, [1], 'and it is counted once');

    // A long track counts at four minutes.
    await reset(S);
    await state().playQueue([track(7, { duration: 1000 })], 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 1000 });
    listen(237);
    assert.deepEqual(S.recorded, [], 'four minutes short of it');
    listen(240);
    assert.deepEqual(S.recorded, [7]);

    // A seek is not listening.
    await reset(S);
    await state().playQueue(tracks(1), 0);
    engine.patchExternal({ playing: true, currentTime: 1, duration: 180 });
    jump(150, 100);
    listen(168);
    assert.deepEqual(S.recorded, [], 'jumping to the end does not make it a play');

    // Skipped early: no play, and a skip.
    await reset(S);
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(21);
    await state().next();
    assert.deepEqual(S.recorded, [], 'a track skipped at 0:21 is not a play');
    assert.equal(S.skips.length, 1, 'it is a skip');

    // A track that plays out is counted, and not as a skip.
    await reset(S);
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(177);
    clock += 2900;
    engine.patchExternal({ currentTime: 179.9, playing: false, ended: true });
    await until(() => state().current?.id === 2);
    assert.deepEqual(S.recorded, [1], 'played out');
    assert.deepEqual(S.skips, []);

    // A read that stopped early is neither a play nor a skip.
    await reset(S);
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(39);
    clock += 1000;
    engine.patchExternal({ currentTime: 40, playing: true, ended: true });
    await until(() => state().current?.id === 2);
    assert.deepEqual(S.recorded, [], 'ending at 0:40 of 3:00 is not a play');
    assert.deepEqual(S.skips, [], 'and the automatic advance is not a skip');

    // Picking a restored session up part-way is not a new play.
    await reset(S);
    await state().playQueue(tracks(1), 0, 30);
    engine.patchExternal({ playing: true, currentTime: 30, duration: 180 });
    listen(170);
    assert.deepEqual(S.recorded, [], 'resuming at 0:30 counts nothing');
  }

  // ---- seeks are not listening, however small and however they are made ----
  {
    // Right arrow and the wheel both move five seconds a time. The step is the
    // size of the seek whether or not the clock moved a hair either way, so none
    // of these taps may add up to a play.
    for (const [name, tapEvery] of [['arrow keys', 100], ['wheel notches', 250], ['a held key', 33]]) {
      await reset(S);
      await state().playQueue([track(1, { duration: 400 })], 0);
      engine.patchExternal({ playing: true, currentTime: 10, duration: 400 });
      let at = 10;
      for (let tap = 0; tap < 40; tap += 1) {
        at += 5;
        jump(at, tapEvery);
      }
      assert.deepEqual(S.recorded, [], `40 five-second seeks by ${name} are not a play`);
      // Listening on from there is still counted.
      listen(at + 189, 1);
      assert.deepEqual(S.recorded, [1], `${name}: the 189 s heard afterwards add up`);
    }

    // A seek back and forth over the same stretch adds nothing either.
    await reset(S);
    await state().playQueue(tracks(1), 0);
    engine.patchExternal({ playing: true, currentTime: 50, duration: 180 });
    for (let pass = 0; pass < 30; pass += 1) {
      jump(50, 120);
      jump(55, 120);
    }
    assert.deepEqual(S.recorded, [], 'looping over five seconds with the seek keys is not listening');

    // Scrubbing to the last seconds and letting it end records nothing, and moving on is no skip.
    await reset(S);
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(6);
    jump(170, 200);
    listen(177);
    clock += 2900;
    engine.patchExternal({ currentTime: 179.9, playing: false, ended: true });
    await until(() => state().current?.id === 2);
    assert.deepEqual(S.recorded, [], 'a scrub to the end is not a play');
    assert.deepEqual(S.skips, [], 'and the automatic advance is not a skip');
  }

  // ---- a scrobble is a track that was heard, not a position that was passed ----
  {
    const lastfm = { settings: { ...S.settings, lastfmEnabled: true } };
    const listenTo = async (list, to, track = list[0]) => {
      await state().playQueue(list, 0);
      engine.patchExternal({ playing: true, currentTime: 0, duration: track.duration });
      listen(to);
    };

    // Half the track, heard, scrobbles it, once.
    await reset(S, lastfm);
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(87);
    assert.deepEqual(S.scrobbles, [], 'a little under half is not a scrobble yet');
    listen(90);
    assert.deepEqual(S.scrobbles, ['T1'], 'half the track is');
    listen(150);
    assert.deepEqual(S.scrobbles, ['T1'], 'and only once');

    // A long track scrobbles at four minutes.
    await reset(S, lastfm);
    await listenTo([track(7, { duration: 1000 })], 237);
    assert.deepEqual(S.scrobbles, []);
    listen(240);
    assert.deepEqual(S.scrobbles, ['T7']);

    // Jumping past the middle is not listening to it.
    await reset(S, lastfm);
    await state().playQueue(tracks(1), 0);
    engine.patchExternal({ playing: true, currentTime: 1, duration: 180 });
    jump(100, 100);
    listen(130);
    assert.deepEqual(S.scrobbles, [], 'a scrub to the middle scrobbles nothing');

    // Nor is a run of five-second seeks.
    await reset(S, lastfm);
    await state().playQueue([track(1, { duration: 400 })], 0);
    engine.patchExternal({ playing: true, currentTime: 10, duration: 400 });
    for (let tap = 0; tap < 40; tap += 1) jump(10 + (tap + 1) * 5, 100);
    assert.deepEqual(S.scrobbles, [], 'seeking by the arrow keys scrobbles nothing');
    assert.deepEqual(S.recorded, [], 'any more than it records a play');

    // Last.fm wants more than 30 seconds of track.
    await reset(S, lastfm);
    await listenTo([track(8, { duration: 30 })], 30);
    assert.deepEqual(S.recorded, [8], 'a track of 30 s is still a play here');
    assert.deepEqual(S.scrobbles, [], 'but is not scrobbled');
    await reset(S, lastfm);
    await listenTo([track(9, { duration: 31 })], 16);
    assert.deepEqual(S.scrobbles, ['T9'], 'one second more is, at half');

    // A saved session picked up part-way is not scrobbled, and the setting has to be on.
    await reset(S, lastfm);
    await state().playQueue(tracks(1), 0, 30);
    engine.patchExternal({ playing: true, currentTime: 30, duration: 180 });
    listen(170);
    assert.deepEqual(S.scrobbles, [], 'resuming at 0:30 scrobbles nothing');
    await reset(S);
    await listenTo(tracks(1), 100);
    assert.deepEqual(S.scrobbles, [], 'with Last.fm off nothing is sent');

    // Each time the track is played it is scrobbled again; a restart is not another play.
    await reset(S, lastfm);
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(100);
    assert.deepEqual(S.scrobbles, ['T1']);
    await state().next();
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(100);
    assert.deepEqual(S.scrobbles, ['T1', 'T2']);
    engine.patchExternal({ currentTime: 0 });
    await state().prev();
    assert.equal(state().current.id, 1);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(100);
    assert.deepEqual(S.scrobbles, ['T1', 'T2', 'T1'], 'coming back to a track is a new play');
  }

  // ---- repeat-one: every pass is counted on its own ----
  {
    await reset(S, { mode: 'repeat-one' });
    await state().playQueue(tracks(1), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(100);
    assert.deepEqual(S.recorded, [1], 'the first pass is counted at half');
    clock += 1000;
    listen(177);
    engine.patchExternal({ currentTime: 179.9, playing: false, ended: true });
    await until(() => S.plays.length === 2);
    assert.deepEqual(S.recorded, [1], 'the end of a pass that was already counted adds nothing');
    engine.patchExternal({ playing: true, ended: false, currentTime: 0 });
    listen(60);
    assert.deepEqual(S.recorded, [1], 'the next pass starts over');
    listen(95);
    assert.deepEqual(S.recorded, [1, 1], 'and is counted when it is half heard');
    // A pass that is scrubbed through is not.
    jump(175, 100);
    clock += 1000;
    engine.patchExternal({ currentTime: 179.9, playing: false, ended: true });
    await until(() => S.plays.length === 3);
    engine.patchExternal({ playing: true, ended: false, currentTime: 0 });
    listen(10);
    jump(175, 100);
    clock += 1000;
    engine.patchExternal({ currentTime: 179.9, playing: false, ended: true });
    await until(() => S.plays.length === 4);
    assert.deepEqual(S.recorded, [1, 1], 'a pass that is scrubbed to its end is not');
  }

  // ---- the length a file really has decides what half of it is ----
  {
    // The library row says ten minutes, the file is 3:20: playing it through is a play.
    await reset(S);
    await state().playQueue([track(9, { duration: 600 }), track(10)], 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 200 });
    listen(199);
    assert.deepEqual(S.recorded, [], 'nothing counts before the end while the row says 10:00');
    clock += 900;
    engine.patchExternal({ currentTime: 199.9, playing: false, ended: true });
    await until(() => state().current?.id === 10);
    assert.deepEqual(S.recorded, [9], 'a file far shorter than its row counts when it plays out');
    assert.deepEqual(S.skips, []);

    // The same file scrubbed to its end does not.
    await reset(S);
    await state().playQueue([track(9, { duration: 600 }), track(10)], 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 200 });
    listen(3);
    jump(190, 100);
    listen(195);
    clock += 900;
    engine.patchExternal({ currentTime: 199.9, playing: false, ended: true });
    await until(() => state().current?.id === 10);
    assert.deepEqual(S.recorded, [], 'a short file that was scrubbed through is not a play either');

    // The row says 1:40, the file is five minutes: half is 2:30, not 0:50.
    await reset(S);
    await state().playQueue([track(11, { duration: 100 })], 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 300 });
    listen(148);
    assert.deepEqual(S.recorded, [], 'a file far longer than its row is not counted at half of the row');
    listen(150);
    assert.deepEqual(S.recorded, [11], 'it is counted at half of the file');

    // A slice of a larger file is as long as the slice, not the file.
    await reset(S);
    await state().playQueue([track(12, { duration: 60, cueStart: 100, cueEnd: 160 })], 0);
    engine.patchExternal({ playing: true, currentTime: 100, duration: 600 });
    listen(128);
    assert.deepEqual(S.recorded, [], 'half of the slice is 0:30');
    listen(131);
    assert.deepEqual(S.recorded, [12]);
  }

  // ---- moving on from a track that already counted as a play is not a skip ----
  {
    await reset(S);
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(100);
    assert.deepEqual(S.recorded, [1]);
    await state().prev();
    assert.equal(state().current.id, 1, 'Previous past three seconds restarts the track');
    listen(20);
    await state().next();
    assert.equal(state().current.id, 2);
    assert.deepEqual(S.skips, [], 'the restart cut short at 0:20 is not a skip of a track that was a play');

    // Without the play, the same move is a skip.
    await reset(S);
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(40);
    await state().prev();
    listen(20);
    await state().next();
    assert.equal(S.skips.length, 1, 'a track that never counted is skipped as before');

    // A new pass starts a new listen: skipping the repeat is a skip again.
    await reset(S);
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(100);
    await state().next();
    assert.deepEqual(S.recorded, [1]);
    await state().prev();
    engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
    listen(20);
    await state().next();
    assert.equal(S.skips.length, 1, 'coming back to a track starts it over');
  }

  // ---- a track flagged missing is attempted before Next passes over it ----
  {
    await reset(S);
    const missing = track(2, { missingSince: 5 });
    await state().playQueue([track(1), missing, track(3)], 0);
    await state().next();
    assert.equal(state().current.id, 2, 'the flag alone does not skip the track');
    assert.deepEqual(S.plays, [1, 2]);
    engine.patchExternal({ error: 'share timed out', playing: false });
    await until(() => state().current?.id === 3);
    assert.deepEqual(S.plays, [1, 2, 3], 'once its open fails the queue moves on');
    await state().playQueue([track(1), missing, track(3)], 0);
    await state().next();
    assert.equal(state().current.id, 3, 'and Next passes over it afterwards');

    // The failure is forgotten after a while: the share may be back.
    const clock = realNow();
    Date.now = () => clock + 11 * 60 * 1000;
    try {
      await state().playQueue([track(1), missing, track(3)], 0);
      await state().next();
      assert.equal(state().current.id, 2, 'ten minutes on it is attempted again');
    } finally {
      Date.now = realNow;
    }
  }

  // ---- a run of flagged tracks is not cut off by the limit for ordinary failures ----
  {
    await reset(S);
    // The rig's transport keeps the last error until told otherwise; a real open clears it.
    S.onPlay = () => engine.patchExternal({ error: null });
    await state().playQueue(tracks(14, 500).map((entry) => ({ ...entry, missingSince: 5 })), 0);
    for (let id = 500; id < 511; id += 1) {
      engine.patchExternal({ error: 'share timed out', playing: false });
      await until(() => state().current?.id === id + 1);
    }
    assert.equal(S.mod.getToasts().filter((toast) => /Playback stopped/.test(toast.title)).length, 0, 'eleven flagged failures in a row do not stop playback');
    const skipToasts = S.mod.getToasts().filter((toast) => /^Skipped/.test(toast.title));
    assert.equal(skipToasts.length, 1, 'the skips share one toast');
    assert.match(skipToasts[0].title, /11 tracks/);

    // Ids start at 500 and 600 because earlier blocks leave failed ids behind.
    // A repeating queue that is all flagged still stops once every track has failed.
    await reset(S, { mode: 'repeat-all' });
    S.onPlay = () => engine.patchExternal({ error: null });
    await state().playQueue(tracks(3, 600).map((entry) => ({ ...entry, missingSince: 5 })), 0);
    engine.patchExternal({ error: 'share timed out', playing: false });
    await until(() => state().current?.id === 601);
    engine.patchExternal({ error: 'share timed out', playing: false });
    await until(() => state().current?.id === 602);
    engine.patchExternal({ error: 'share timed out', playing: false });
    await until(() => S.mod.getToasts().some((toast) => /Playback stopped/.test(toast.title)));
  }

  // ---- the saved session is not rewritten for position alone ----
  {
    await reset(S);
    await state().playQueue(tracks(3), 0);
    S.saves.length = 0;
    let clock = realNow();
    Date.now = () => clock;
    try {
      engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
      clock += 4000;
      engine.patchExternal({ currentTime: 4 });
      clock += 8000;
      engine.patchExternal({ currentTime: 12 });
      clock += 7000;
      engine.patchExternal({ currentTime: 19 });
      assert.equal(S.saves.filter((save) => save.resumeState).length, 0, 'position alone is not saved every few seconds');
      clock += 3000;
      engine.patchExternal({ currentTime: 22 });
      const saved = S.saves.filter((save) => save.resumeState);
      assert.equal(saved.length, 1, 'but it is saved every 20 seconds');
      assert.equal(saved[0].resumeState.currentTime, 22);
      clock += 1000;
      engine.patchExternal({ playing: false });
      assert.equal(S.saves.filter((save) => save.resumeState).length, 2, 'pausing saves the position at once');
    } finally {
      Date.now = realNow;
    }
  }

  // ---- Previous in shuffle is undone by Next ----
  {
    await reset(S, { mode: 'shuffle' });
    Math.random = seeded(5);
    try {
      await state().playQueue(tracks(8), 0);
      engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
      await state().next();
      const second = state().current.id;
      engine.patchExternal({ currentTime: 0 });
      await state().next();
      const third = state().current.id;
      engine.patchExternal({ currentTime: 0 });
      await state().prev();
      assert.equal(state().current.id, second, 'Previous steps back');
      assert.equal(state().shuffleForward.length, 1, 'the track it left is kept');
      engine.patchExternal({ currentTime: 0 });
      await state().next();
      assert.equal(state().current.id, third, 'Next returns to it instead of drawing a new one');
      assert.deepEqual(state().shuffleForward, []);

      engine.patchExternal({ currentTime: 0 });
      await state().prev();
      assert.equal(state().shuffleForward.length, 1);
      state().addTrackToQueue(track(99));
      assert.deepEqual(state().shuffleForward, [], 'a queue edit drops it');
    } finally {
      Math.random = realRandom;
    }
  }

  // ---- a failed play that the engine published does not reject ----
  {
    await reset(S);
    const realPlay = engine.play;
    try {
      engine.play = async () => {
        engine.patch({ error: 'Audio error (code 3)', playing: false });
        throw new Error('Audio error (code 3)');
      };
      await state().playQueue(tracks(1), 0);
      await state().playTrack(track(9));
      engine.patch({ error: null });
      engine.play = async () => { throw new Error('not published'); };
      await assert.rejects(state().playQueue(tracks(1), 0), /not published/, 'a fault the engine did not publish still surfaces');
    } finally {
      engine.play = realPlay;
    }
  }

  // ---- a start nobody awaits still says so when it fails without the engine publishing it ----
  {
    await reset(S);
    const realPlay = engine.play;
    try {
      store.setState({ queue: tracks(2), index: 0, current: tracks(2)[0], currentTime: 0 });
      engine.play = async () => { throw new Error('No audio output device'); };
      state().togglePlay();
      await until(() => S.mod.getToasts().some((toast) => toast.title === 'Playback failed'));
      assert.equal(S.mod.getToasts().find((toast) => toast.title === 'Playback failed').detail, 'No audio output device');

      // A failure the engine published has its own notice and skip: no second toast.
      S.mod.clearToasts();
      store.getState().clearQueue();
      store.setState({ queue: tracks(2), index: 0, current: tracks(2)[0], currentTime: 0 });
      engine.play = async () => {
        engine.patch({ error: 'Audio error (code 3)', playing: false });
        throw new Error('Audio error (code 3)');
      };
      state().togglePlay();
      await settle();
      await pause(20);
      assert.equal(S.mod.getToasts().filter((toast) => toast.title === 'Playback failed').length, 0);
    } finally {
      engine.play = realPlay;
      engine.patch({ error: null });
    }
  }

  // ---- the previous track's position and errors are not shown against the next one ----
  {
    await reset(S);
    await state().playQueue(tracks(3), 0);
    engine.patchExternal({ playing: true, currentTime: 100, duration: 180 });
    let accept;
    S.gate = () => new Promise((resolve) => { accept = resolve; });
    const advancing = state().next();
    await settle();
    assert.equal(state().current.id, 2, 'the store is on the second track');
    assert.equal(engine.getState().trackId, 1, 'the engine has not got there yet');
    assert.equal(state().currentTime, 0, 'the second track starts at 0:00');
    engine.patchExternal({ currentTime: 171 });
    assert.equal(state().currentTime, 0, 'the first track\'s position is not shown against the second');
    engine.patchExternal({ playing: false, error: 'Audio error (code 3)' });
    await pause(20);
    assert.equal(state().playbackError, null, 'nor is its error');
    assert.equal(state().current.id, 2, 'and the second track is not skipped for it');
    S.gate = null;
    engine.patchExternal({ error: null });
    accept();
    await advancing;
    assert.equal(engine.getState().trackId, 2);
    engine.patchExternal({ playing: true, currentTime: 12 });
    assert.equal(state().currentTime, 12, 'once the engine is on the second track its position is');
  }

  // ---- an error that reaches a paused player is held for the track, not skipped past ----
  {
    await reset(S);
    await state().playQueue(tracks(3), 0);
    engine.patchExternal({ playing: true, currentTime: 30, duration: 180 });
    engine.pause();
    assert.equal(state().isPlaying, false);
    S.plays.length = 0;
    engine.patchExternal({ playing: false, error: 'The drive stopped answering.' });
    await pause(40);
    assert.equal(state().current.id, 1, 'the paused track stays the current one');
    assert.equal(state().isPlaying, false, 'and stays paused');
    assert.deepEqual(S.plays, [], 'nothing starts');
    assert.equal(state().playbackError, 'The drive stopped answering.', 'the error is kept for the track');
    assert.equal(S.mod.getToasts().filter((toast) => /^Skipped/.test(toast.title)).length, 0, 'and nothing is announced as skipped');

    // Play starts the track again where it stopped, and clears the error.
    state().togglePlay();
    await until(() => S.plays.length === 1);
    await until(() => state().isPlaying);
    assert.deepEqual(S.plays, [1]);
    assert.equal(state().current.id, 1);
    assert.equal(state().playbackError, null);
    assert.equal(engine.getState().currentTime, 30, 'at the place it stopped');
    assert.equal(state().isPlaying, true);

    // A track that is playing when its error arrives is still skipped, as before.
    engine.patchExternal({ playing: false, error: 'Audio error (code 3)' });
    await until(() => state().current?.id === 2);
  }

  // ---- a route restart tries again, then says so ----
  {
    await reset(S);
    S.settings = { ...S.settings, bitPerfectExclusive: true };
    store.setState({ settings: S.settings });
    await state().playQueue(tracks(2), 0);
    engine.patchExternal({ playing: true, currentTime: 30, duration: 180 });
    await settle();
    const realPlay = engine.play.bind(engine);
    let calls = 0;
    engine.play = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('device busy');
      return realPlay(...args);
    };
    try {
      await state().setBitPerfectExclusiveDevice('dev-a');
      assert.equal(calls, 2, 'the restart is tried a second time');
      assert.equal(S.mod.getToasts().length, 0, `and no one is told when it works: ${JSON.stringify(S.mod.getToasts())}`);

      calls = -10;
      engine.play = async () => { calls += 1; throw new Error('device gone'); };
      await state().setBitPerfectExclusiveDevice('dev-b');
      assert.equal(calls, -8, 'two attempts, not more');
      assert.ok(S.mod.getToasts().some((toast) => /new output/.test(toast.title) && /device gone/.test(toast.detail ?? '')), 'the second failure is announced');
    } finally {
      engine.play = realPlay;
    }
  }

  // ---- deck seeks during a scrub collapse into one per window ----
  {
    Object.assign(globalThis.window, fakeTimers);
    fake.pending.clear();
    const subject = new S.mod.AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.writes.length = 0;
      subject.seek(10);
      assert.deepEqual(el.writes, [10], 'the first seek lands at once');
      subject.seek(20);
      subject.seek(30);
      assert.deepEqual(el.writes, [10], 'the ones after it wait');
      assert.equal(subject.getState().currentTime, 30, 'the clock shows where the scrub is');
      assert.equal(subject.getPlaybackPosition(), 30);
      advance(124);
      assert.deepEqual(el.writes, [10]);
      advance(1);
      assert.deepEqual(el.writes, [10, 30], 'the window closes on the last one');
      subject.seek(40);
      assert.deepEqual(el.writes, [10, 30], 'a drag that goes on is still inside a window');
      advance(125);
      assert.deepEqual(el.writes, [10, 30, 40]);
      advance(125);
      subject.seek(50);
      assert.deepEqual(el.writes, [10, 30, 40, 50], 'a seek after a quiet window lands at once');
      // A new track on the deck drops a waiting seek.
      subject.seek(60);
      await subject.play('newamp://track/10', 10, 0);
      advance(500);
      assert.ok(!el.writes.includes(60), 'a seek waiting for the old track does not move the new one');
    } finally {
      subject.dispose();
      Object.assign(globalThis.window, realTimers);
    }
  }

  // ---- a coalesced seek does not trip the VBR check of the seek before it ----
  {
    Object.assign(globalThis.window, fakeTimers);
    fake.pending.clear();
    const subject = new S.mod.AudioEngine();
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnings.push(args); };
    try {
      await subject.play('newamp://track/11', 11, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.position = 5;
      subject.seek(10);
      subject.seek(60);
      advance(125);
      assert.equal(el.position, 60);
      advance(300);
      assert.deepEqual(warnings.filter((args) => /seek failed/.test(String(args[0]))), [], 'the check of the first seek is superseded');
    } finally {
      console.warn = realWarn;
      subject.dispose();
      Object.assign(globalThis.window, realTimers);
    }
  }

  // ---- Quick Play selects the Ask only when the search has nothing that fits ----
  {
    const palette = await build({
      entryPoints: ['src/components/QuickPlayPalette.tsx'],
      bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
      plugins: [{
        name: 'w2',
        setup(b) {
          b.onResolve({ filter: /^(\.\.\/store\/usePlayerStore|\.\.\/lib\/api)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
            contents: args.path.endsWith('api')
              ? "export const api = { platform: 'darwin' };"
              : 'export const usePlayerStore = Object.assign(() => ({}), { getState: () => ({}) });',
            loader: 'js',
          }));
          b.onLoad({ filter: /QuickPlayPalette\.tsx$/ }, async (args) => ({
            contents: `${await (await import('node:fs/promises')).readFile(args.path, 'utf8')}\nexport { initialSelection };`,
            loader: 'tsx',
          }));
        },
      }],
    });
    const { initialSelection } = await import(`data:text/javascript;base64,${Buffer.from(palette.outputFiles[0].text).toString('base64')}`);
    const item = (title) => ({ kind: 'track', title });
    assert.equal(initialSelection('warm slow stuff', 0, [], 12), 0, 'nothing found: the only rows are the Ask, which is row 0');
    assert.equal(initialSelection('warm slow stuff', 2, [item('Slow Burn'), item('Other')], 12), 4, 'a top hit that is not a title match hands the selection to the Ask');
    assert.equal(initialSelection('slow burn', 0, [item('Slow Burn (Live)'), item('Other')], 12), 0, 'a title that starts with the query keeps it');
    assert.equal(initialSelection('slow burn', 0, [item('slow burn')], 12), 0, 'so does an exact one');
    assert.equal(initialSelection('anything', 0, [item('Nope')], 0), 0, 'without an Ask the first row is selected');
  }

  // ---- views follow the library and the store ----
  {
    const source = (path) => readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n');
    const artists = source('src/components/views/ArtistsView.tsx');
    assert.match(artists, /api\.onScanProgress\(/, 'Artists reloads after a scan');
    assert.match(artists, /api\.onTracksRemoved\(reload\)/, 'and when tracks leave the library');
    const loved = source('src/components/views/LovedView.tsx');
    assert.match(loved, /usePlayerStore\(\(s\) => s\.lastLoveChange\)/, 'Loved follows the store\'s love changes');
    const tags = source('src/components/views/TagsView.tsx');
    assert.match(tags, /sampled \$\{sampledCount\.toLocaleString\(\)\} of \$\{totalCount\.toLocaleString\(\)\}/, 'the tag preview says how much it sampled');
    assert.match(source('shared/types.ts'), /sampledCount\?: number;\s*totalCount\?: number;/, 'the preview result carries both counts');
    assert.doesNotMatch(source('src/components/Sidebar.tsx'), /regenerated from your library/, 'the Mixes hint says what the view does');
  }

  // ---- after a backup restore this page writes no session ----
  // Last of the store cases: the stop is one way for the rest of the page.
  {
    await reset(S);
    await S.store.getState().playQueue(tracks(3), 0);
    const writes = () => S.saves.filter((save) => save.resumeState !== undefined).length;
    let wall = realNow();
    Date.now = () => wall;
    try {
      S.engine.patchExternal({ playing: true, currentTime: 0, duration: 180 });
      let at = 0;
      const periodicSave = () => {
        wall += 25000;
        at += 25;
        const before = writes();
        S.engine.patchExternal({ currentTime: at });
        return writes() - before;
      };
      assert.equal(periodicSave(), 1, 'the periodic save writes');
      const beforeExit = writes();
      await S.store.getState().persistPlaybackSession();
      assert.equal(writes() - beforeExit, 1, 'the save on exit writes');
      const beforeNext = writes();
      await S.store.getState().next();
      assert.ok(writes() > beforeNext, 'a change of track writes');

      S.mod.stopPersistingSession();
      const frozen = writes();
      assert.equal(periodicSave(), 0, 'the periodic save no longer writes');
      await S.store.getState().persistPlaybackSession();
      await S.store.getState().next();
      S.engine.pause();
      await S.store.getState().playQueue(tracks(2, 40), 0);
      S.store.getState().clearQueue();
      await settle();
      assert.equal(writes(), frozen, 'neither does the exit save, a track change, a pause or a new queue');
    } finally {
      Date.now = realNow;
    }
  }

  assert.deepEqual(unhandled, [], 'no unhandled rejections');
  console.log('PASS w2 store: play counting, missing tracks, session saves, shuffle replay, published errors, route restart, Quick Play Ask, deck seeks');
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  Date.now = realNow;
  performance.now = realPerformanceNow;
  Math.random = realRandom;
  for (const rig of loaded) {
    rig.mod.clearToasts();
    rig.engine.dispose();
  }
  clearTimeout(deadline);
}
