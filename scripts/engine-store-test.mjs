// Engine and store behaviour for a slow or failing source: a deck whose stream
// fails mid-track reloads in place instead of skipping the song, positions are
// not flashed back to 0:00 while a deck loads, a suspended context is asked to
// resume, bursts of device changes run once, and the store keeps a skip notice,
// a resumable queue window, and stale engine events away from the new track.
// Run: node scripts/engine-store-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';

Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map((frame) => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('a4 engine/store test timed out'); process.exit(1); }, 40000);
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
  constructor() {
    this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = new Node();
    this.listeners = {}; this.resumes = 0;
    Context.all.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  setState(state) { this.state = state; for (const fn of this.listeners.statechange ?? []) fn(); }
  createGain() { return new Node(); }
  createBiquadFilter() { return Object.assign(new Node(), { gain: new Param(), frequency: new Param(), Q: new Param() }); }
  createDynamicsCompressor() { return Object.assign(new Node(), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map((k) => [k, new Param()]))); }
  createAnalyser() { return new Node(); }
  createChannelSplitter() { return new Node(); }
  createMediaElementSource() { return new Node(); }
  resume() { this.resumes++; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
Context.all = [];

class Audio {
  constructor() {
    this.src = ''; this.currentSrc = ''; this.currentTime = 0; this.duration = Number.NaN; this.readyState = 0;
    this.paused = true; this.error = null; this.listeners = {}; this.loads = 0; this.plays = 0; this.failPlay = false;
    this.holdPlay = false; this.settlePlay = null;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  emit(type) { for (const fn of [...(this.listeners[type] ?? [])]) fn(); }
  play() {
    this.plays++;
    if (this.failPlay) return Promise.reject(new Error('The element has no supported sources.'));
    this.paused = false;
    this.currentSrc = this.src;
    this.emit('play');
    if (this.holdPlay) return new Promise((resolve, reject) => { this.settlePlay = { resolve, reject }; });
    return Promise.resolve();
  }
  pause() { if (!this.paused) { this.paused = true; this.emit('pause'); } }
  load() { this.loads++; this.error = null; this.readyState = 0; this.duration = Number.NaN; this.currentTime = 0; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  /** The element has its metadata: duration known, pending seeks land. */
  gotMetadata(duration = 200) { this.duration = duration; this.readyState = 4; this.emit('loadedmetadata'); }
  fail(code) { this.error = { code }; this.emit('error'); }
}

// Timers the engine reaches through `window`: fake ones for the engine sections,
// real ones for the store sections that wait on the store's own 350 ms skip timer.
const fake = { now: 0, nextId: 1, pending: new Map(), intervals: new Map() };
const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
const fakeTimers = {
  setTimeout: (fn, ms) => { const id = fake.nextId++; fake.pending.set(id, { fn, at: fake.now + ms }); return id; },
  clearTimeout: (id) => { fake.pending.delete(id); },
  setInterval: (fn) => { const id = fake.nextId++; fake.intervals.set(id, fn); return id; },
  clearInterval: (id) => { fake.intervals.delete(id); },
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
const tickEngine = () => { for (const fn of [...fake.intervals.values()]) fn(); };
const useFakeTimers = () => Object.assign(globalThis.window, fakeTimers);
const useRealTimers = () => Object.assign(globalThis.window, realTimers);

globalThis.Audio = Audio;
globalThis.AudioContext = Context;
globalThis.document = { documentElement: { dataset: {}, style: { removeProperty() {}, setProperty() {} } } };
globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, location: { search: '' }, winctl: { notifyPlayback() {} } };

const bundled = await build({
  stdin: {
    contents: `export * from './src/store/usePlayerStore';
      export { AudioEngine } from './src/audio/engine';
      export { api, DEFAULT_SETTINGS } from './src/lib/api';
      export { clearToasts, getToasts } from './src/lib/toast';
      export { coalesceDeviceChanges } from './src/audio/device-change';
      export { syncMediaSessionIdentity, windowTitleFor } from './src/lib/mediaSession';
      export { openedItemsStatus, partialFolderNotice } from './src/lib/open-files-status';
      export { exclusiveBridge } from './src/audio/exclusive-bridge';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const {
  AudioEngine, engine, usePlayerStore: store, api, DEFAULT_SETTINGS, clearToasts, getToasts, coalesceDeviceChanges,
  syncMediaSessionIdentity, windowTitleFor, exclusiveBridge, transportAvailability, playbackResumeStateForQueueSnapshot,
  openedItemsStatus, partialFolderNotice,
} = mod;
await new Promise(queueMicrotask);
const settle = () => new Promise(setImmediate);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const track = (id, extra = {}) => ({
  id, path: `/music/${id}.flac`, title: `Song ${id}`, artist: 'Artist', album: 'Album', albumArtist: 'Artist',
  duration: 180, replayGainTrackDb: null, replayGainAlbumDb: null, ...extra,
});

try {
  // ---- a deck whose stream fails mid-track reloads in place ------------------------------------
  {
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 90;
      tickEngine();
      assert.equal(subject.getState().currentTime, 90);
      assert.equal(subject.getState().playing, true);

      el.fail(2);
      assert.equal(subject.getState().error, null, 'a network error mid-track is not reported yet');
      assert.equal(subject.getState().playing, true, 'it is not a pause');
      assert.equal(subject.getState().buffering, true);
      assert.equal(el.loads, 0, 'the reload waits out its delay first');
      advance(1499);
      assert.equal(el.loads, 0);
      advance(1);
      assert.equal(el.loads, 1, 'the deck loads the track again');
      assert.equal(el.plays, 2);
      // Metadata has not arrived: the clock holds the resume position, not 0:00.
      tickEngine();
      assert.equal(subject.getState().currentTime, 90, 'a reloading deck does not report a restart');
      assert.equal(subject.getPlaybackPosition(), 90);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 90, 'the reload lands at the position the stream failed at');

      // The budget: four reloads, then the error is reported like any other.
      for (let attempt = 2; attempt <= 4; attempt++) {
        el.fail(2);
        assert.equal(subject.getState().error, null, `attempt ${attempt} is still a retry`);
        advance(16000);
        assert.equal(el.loads, attempt);
        el.gotMetadata(200);
      }
      el.fail(2);
      assert.equal(subject.getState().error, 'Audio error (code 2)', 'the budget is spent');
      assert.equal(subject.getState().playing, false);
      assert.equal(subject.getState().buffering, false);
    } finally { subject.dispose(); }
  }
  {
    // A decode error before anything played means the file is bad: no retry.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.fail(3);
      assert.equal(subject.getState().error, 'Audio error (code 3)');
      assert.equal(fake.pending.size, 0);
    } finally { subject.dispose(); }
  }
  {
    // The same error after audio has played is retried, and playing on clears the budget.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 60;
      el.fail(3);
      assert.equal(subject.getState().error, null);
      advance(1500);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 60);
      el.currentTime = 66;
      tickEngine();
      el.fail(2);
      advance(1500);
      assert.equal(el.loads, 2, 'after the stream recovered, the next failure starts a new budget at the first delay');
    } finally { subject.dispose(); }
  }
  {
    // Pausing while the deck waits to reload cancels it; resuming reloads from where it stopped.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 30;
      el.fail(2);
      subject.pause();
      assert.equal(subject.getState().playing, false);
      assert.equal(subject.getState().buffering, false);
      assert.equal(fake.pending.size, 0, 'the reload timer is gone');
      advance(60000);
      assert.equal(el.loads, 0);
      subject.togglePlayPause();
      await settle();
      assert.equal(el.loads, 1, 'Play loads the failed stream again');
      el.gotMetadata(200);
      assert.equal(el.currentTime, 30, 'from where it stopped');
      assert.equal(subject.getState().playing, true);
    } finally { subject.dispose(); }
  }
  {
    // A seek while the deck waits moves the resume position, and a new play() drops the retry.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 30;
      el.fail(2);
      subject.seek(120);
      assert.equal(subject.getState().currentTime, 120);
      advance(1500);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 120);
      el.fail(2);
      await subject.play('newamp://track/10', 10, 0);
      assert.equal(fake.pending.size, 0, 'starting another track cancels the reload');
    } finally { subject.dispose(); }
  }

  {
    // A deck that fails while the user has it paused is not a broken track: nothing is reported
    // and nothing skips, and Play loads the stream again at the paused position.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 45;
      tickEngine();
      subject.pause();
      el.fail(2);
      assert.equal(subject.getState().error, null, 'a paused deck failing is not published as an error');
      assert.equal(subject.getState().playing, false);
      assert.equal(subject.getState().currentTime, 45, 'the position is kept');
      assert.equal(fake.pending.size, 0, 'nothing is scheduled while paused');
      advance(60000);
      assert.equal(el.loads, 0);
      subject.togglePlayPause();
      await settle();
      assert.equal(el.loads, 1, 'Play loads the failed stream again');
      el.gotMetadata(200);
      assert.equal(el.currentTime, 45, 'at the paused position');
      assert.equal(subject.getState().playing, true);
    } finally { subject.dispose(); }
  }
  {
    // After a reload, a seek back must not be undone by a later failure: the next reload starts
    // from the element's own position, not the position the first failure left in the retry.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 90;
      el.fail(2);
      advance(1500);
      el.gotMetadata(200);
      el.currentTime = 92;
      tickEngine();
      subject.seek(10);
      assert.equal(el.currentTime, 10);
      el.fail(2);
      assert.equal(subject.getState().currentTime, 10, 'the failure reports where the stream was, not the older resume point');
      advance(4000);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 10);
    } finally { subject.dispose(); }
  }
  {
    // A seek while a reload is loading replaces the resume position the metadata seek would land on.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 30;
      el.fail(2);
      advance(1500);
      assert.equal(el.loads, 1);
      subject.seek(120);
      assert.equal(subject.getState().currentTime, 120);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 120, 'the seek issued during the reload wins');
      el.currentTime = 125;
      tickEngine();
      el.fail(2);
      advance(4000);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 125);
    } finally { subject.dispose(); }
  }

  // ---- which failures are worth waiting out -----------------------------------------------------
  {
    // An open that fails at a resume position (a restored session, a hand-off) is a failed open, not
    // a stream that dropped: it is reported at once instead of after the reloads.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 42);
      const el = subject.graph.decks[0].el;
      el.fail(4);
      assert.equal(subject.getState().error, 'Audio error (code 4)', 'a start position does not turn a failed open into a mid-song failure');
      assert.equal(subject.getState().playing, false);
      assert.equal(fake.pending.size, 0, 'nothing is waiting to reload it');
    } finally { subject.dispose(); }
  }
  {
    // A reload that fails to open is still the stream that was playing: it keeps its budget.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 90;
      el.fail(2);
      advance(1500);
      assert.equal(el.loads, 1);
      el.fail(4);
      assert.equal(subject.getState().error, null, 'the share is still down: another try is queued');
      advance(3999);
      assert.equal(el.loads, 1);
      advance(1);
      assert.equal(el.loads, 2, 'and it waits the next delay of the budget');
    } finally { subject.dispose(); }
  }
  {
    // A decode error is the same bad frame again after a reload: one more try, not the whole budget.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 100;
      el.fail(3);
      assert.equal(subject.getState().error, null, 'the first decode error is retried');
      advance(1500);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 100);
      el.fail(3);
      assert.equal(subject.getState().error, 'Audio error (code 3)', 'the same error at the same place is reported at once');
      assert.equal(fake.pending.size, 0);
    } finally { subject.dispose(); }
  }
  {
    // Seeking forward on a reloaded stream is not audio played: it does not earn the budget back.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 90;
      el.fail(2);
      advance(1500);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 90);
      tickEngine();
      subject.seek(150);
      assert.equal(el.currentTime, 150);
      tickEngine();
      el.fail(2);
      advance(1500);
      assert.equal(el.loads, 1, 'the second failure waits for the second delay, not the first');
      advance(2500);
      assert.equal(el.loads, 2);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 150);
      // Five seconds of audio past the seek target is what forgives the earlier failures.
      el.currentTime = 156;
      tickEngine();
      el.fail(2);
      advance(1500);
      assert.equal(el.loads, 3, 'after real playback the next failure starts over at the first delay');
    } finally { subject.dispose(); }
  }
  {
    // A seek on a stream that failed while paused is kept, and Play loads the track at it.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const el = subject.graph.decks[0].el;
      el.gotMetadata(200);
      el.currentTime = 45;
      tickEngine();
      subject.pause();
      el.fail(2);
      subject.seek(120);
      assert.equal(subject.getState().currentTime, 120, 'the scrub bar stays where it was dropped');
      tickEngine();
      assert.equal(subject.getState().currentTime, 120);
      subject.togglePlayPause();
      await settle();
      assert.equal(el.loads, 1);
      el.gotMetadata(200);
      assert.equal(el.currentTime, 120, 'Play resumes at the seek, not at the old position');
    } finally { subject.dispose(); }
  }
  {
    // A preload that failed while the deck was idle is not the deck the next track starts on.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      subject.prepareNext('newamp://track/10', 10, 0);
      const idle = subject.graph.decks[1].el;
      assert.equal(idle.src, 'newamp://track/10');
      idle.fail(2);
      assert.equal(subject.getState().error, null, 'an idle deck failing is not the playing track failing');
      await subject.play('newamp://track/10', 10, 0);
      assert.equal(idle.plays, 0, 'the failed preload is not played');
      const playing = subject.graph.decks[subject.activeDeckIndex].el;
      assert.equal(playing.src, 'newamp://track/10', 'the track is loaded afresh');
      assert.equal(subject.getState().error, null);
    } finally { subject.dispose(); }
  }
  for (const order of ['the error event first', 'the rejected play() first']) {
    // One failed start is one error to the store, whichever of the two reports it first.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/8', 8, 0);
      const el = subject.graph.decks[0].el;
      el.holdPlay = true;
      const started = subject.play('newamp://track/9', 9, 0).then(() => 'started', (err) => err.message);
      await settle();
      const published = new Set();
      subject.subscribe((s) => { if (s.error) published.add(s.error); });
      const reject = () => el.settlePlay.reject(new Error('Failed to load because no supported source was found.'));
      const raise = () => { el.error = { code: 4 }; el.emit('error'); };
      if (order === 'the error event first') { raise(); reject(); } else { reject(); await settle(); raise(); }
      assert.match(await started, /no supported source/);
      assert.equal(published.size, 1, `${order}: ${[...published].join(' / ')}`);
      assert.equal(subject.getState().playing, false);
    } finally { subject.dispose(); }
  }

  // ---- the exclusive backend gives up on a track whose file stopped answering --------------------
  {
    useFakeTimers();
    const subject = new AudioEngine();
    const calls = [];
    subject.setExternalTransport({
      play: async (id, at) => { calls.push(['play', id, at]); return true; },
      pause() {}, resume() {}, stop() { calls.push(['stop']); }, seek() {}, prepareNext() {},
    });
    try {
      await subject.play('newamp://track/9', 9, 0);
      subject.patchExternal({ currentTime: 77, playing: true });
      subject.handleExternalFailure(77, 'The drive stopped answering partway through the track.');
      await settle();
      assert.deepEqual(calls, [['play', 9, 0], ['stop']], 'the backend is released and not asked for the track again');
      const el = subject.graph.decks[0].el;
      assert.equal(el.src, 'newamp://track/9', 'the decks have the track');
      assert.equal(el.plays, 1);
      assert.equal(subject.getState().currentTime, 77);
      assert.equal(subject.getState().error, null, 'it is not reported as a failure');
      el.gotMetadata(200);
      assert.equal(el.currentTime, 77, 'from where the backend stopped');
      assert.match(subject.getExclusiveInfo().fallbackReason, /stopped answering/);
      // Only that track: the next one is offered to the backend as usual.
      await subject.play('newamp://track/10', 10, 0);
      assert.deepEqual(calls.at(-1), ['play', 10, 0]);
    } finally { subject.dispose(); }
  }

  {
    // The report is for the track the backend has now, and only while nothing newer is waiting on it.
    useFakeTimers();
    const subject = new AudioEngine();
    const calls = [];
    let accept = null;
    subject.setExternalTransport({
      play: (id, at) => { calls.push(['play', id, at]); return accept ? accept() : Promise.resolve(true); },
      pause() {}, resume() {}, stop() { calls.push(['stop']); }, seek() {}, prepareNext() {},
    });
    try {
      await subject.play('newamp://track/9', 9, 0);
      subject.handleExternalFailure(40, 'a late report', 77);
      await settle();
      assert.deepEqual(calls, [['play', 9, 0]], 'a report for another track changes nothing');
      assert.equal(subject.getExclusiveInfo().active, true);

      let release;
      accept = () => new Promise((resolve) => { release = () => resolve(true); });
      const next = subject.play('newamp://track/10', 10, 0);
      await settle();
      subject.handleExternalFailure(40, 'the track that is leaving', 9);
      subject.handleExternalFailure(40, 'the same, with no track named');
      await settle();
      assert.deepEqual(calls, [['play', 9, 0], ['play', 10, 0]], 'nor does one while a newer start is waiting');
      release();
      await next;
      assert.equal(subject.getState().trackId, 10);
      assert.equal(subject.getExclusiveInfo().active, true);

      subject.handleExternalFailure(12, 'the drive went away', 10);
      await settle();
      const el = subject.graph.decks[subject.activeDeckIndex].el;
      assert.equal(el.src, 'newamp://track/10');
      assert.equal(el.plays, 1);
      // The backend no longer has the track, so a second report is nothing to act on.
      subject.handleExternalFailure(13, 'again', 10);
      await settle();
      assert.equal(el.plays, 1);
      assert.deepEqual(calls.filter((call) => call[0] === 'stop'), [['stop']]);
    } finally { subject.dispose(); }
  }
  {
    // A track that cannot be read anywhere does not bounce between the exclusive backend and the
    // gapless player: it is handed over once, and the backend is offered it again only after another track.
    useFakeTimers();
    const subject = new AudioEngine();
    const offered = [];
    subject.setExternalTransport({
      play: async (id) => { offered.push(id); return true; },
      pause() {}, resume() {}, stop() {}, seek() {}, prepareNext() {},
    });
    let report = null;
    const gapless = {
      live: false, starts: 0, lastResult: null, unavailableReason: null, underruns: 0,
      setListener(fn) { report = fn; }, detach() {}, attach: async () => true,
      start() { this.starts += 1; this.live = true; return Promise.resolve({ ok: true, durationSec: 200 }); },
      stop() { this.live = false; },
      hasStream() { return this.live; }, isPlaying: () => true, position: () => ({ currentTime: 31, duration: 200 }),
      isUnackedChain: () => false, ack() {}, setAudibleGain() {}, prepareNext() {}, audibleSignal: () => null,
    };
    subject.setSampleTransport(gapless);
    try {
      await subject.play('newamp://track/9', 9, 0);
      subject.handleExternalFailure(30, 'The drive stopped answering.', 9);
      await settle();
      assert.equal(gapless.starts, 1, 'the gapless player took the track');
      report({ type: 'failed', segment: { src: 'newamp://track/9', trackId: 9 }, positionSec: 31, message: 'Decode failed.' });
      await settle();
      assert.deepEqual(offered, [9], 'the backend is not offered the track again');
      const el = subject.graph.decks[subject.activeDeckIndex].el;
      assert.equal(el.src, 'newamp://track/9', 'the decks have it');
      assert.equal(el.plays, 1);

      await subject.play('newamp://track/10', 10, 0);
      assert.deepEqual(offered, [9, 10], 'the next track goes to the backend as usual');
      await subject.play('newamp://track/9', 9, 0);
      assert.deepEqual(offered, [9, 10, 9], 'and the first is offered again once another track has played');
    } finally { subject.dispose(); }
  }

  // ---- a gapless start that never answers hands the track to the decks ----------------------------
  {
    useFakeTimers();
    const subject = new AudioEngine();
    const transport = {
      live: false, stops: 0, starts: [], lastResult: null, unavailableReason: null, underruns: 0,
      setListener() {}, detach() {}, attach: async () => true,
      start(request) { this.starts.push(request); this.live = true; return new Promise(() => {}); },
      stop() { this.stops += 1; this.live = false; },
      hasStream() { return this.live; }, isPlaying: () => true, position: () => ({ currentTime: 0, duration: null }),
      isUnackedChain: () => false, ack() {}, setAudibleGain() {}, prepareNext() {}, audibleSignal: () => null,
    };
    subject.setSampleTransport(transport);
    try {
      let outcome = null;
      const started = subject.play('newamp://track/9', 9, 5).then((value) => { outcome = value; });
      await settle();
      assert.equal(transport.starts.length, 1, 'the transport was asked first');
      advance(24999);
      await settle();
      assert.equal(outcome, null, 'it is given 25 s');
      assert.equal(subject.getState().buffering, true);
      advance(1);
      await started;
      assert.equal(outcome, 'started');
      assert.equal(transport.stops, 1, 'its stream is stopped so it cannot start behind the decks');
      const el = subject.graph.decks[0].el;
      assert.equal(el.src, 'newamp://track/9', 'the decks have the track');
      assert.equal(el.plays, 1);
      assert.equal(subject.isSampleTransportActive(), false);
      assert.equal(subject.getSampleTransportInfo().fallbackReason, 'The gapless producer did not answer.');
    } finally { subject.dispose(); }
  }

  // ---- hand-offs keep their position ------------------------------------------------------------
  {
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 42);
      assert.equal(subject.getState().currentTime, 42, 'the start position is the position from the first moment');
      const el = subject.graph.decks[0].el;
      tickEngine();
      assert.equal(subject.getState().currentTime, 42, 'the clock does not read the unloaded element as 0:00');
      el.gotMetadata(200);
      assert.equal(el.currentTime, 42);
    } finally { subject.dispose(); }
  }
  {
    // A deck play() that hits a start-up failure with no retry still rejects, as before.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0).catch(() => undefined);
      subject.graph.decks[0].el.failPlay = true;
      await assert.rejects(subject.play('newamp://track/10', 10, 0));
      assert.match(subject.getState().error, /no supported sources/);
    } finally { subject.dispose(); }
  }

  // ---- a context that stops while playing -------------------------------------------------------
  {
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      const ctx = Context.all.at(-1);
      const before = ctx.resumes;
      ctx.setState('suspended');
      assert.equal(ctx.resumes, before + 1, 'a suspended context is asked to resume');
      ctx.setState('running');
      advance(5000);
      assert.equal(subject.getState().playing, true, 'a context that came back keeps playing');

      ctx.setState('interrupted');
      assert.equal(ctx.resumes, before + 2);
      advance(1999);
      assert.equal(subject.getState().playing, true);
      advance(1);
      assert.equal(subject.getState().playing, false, 'a context that stays down is reported as not playing');
      subject.togglePlayPause();
      assert.ok(ctx.resumes >= before + 3, 'Play asks the context to resume');
    } finally { subject.dispose(); }
  }
  {
    // A context that was never playing is left alone.
    useFakeTimers();
    const subject = new AudioEngine();
    try {
      await subject.play('newamp://track/9', 9, 0);
      subject.pause();
      const ctx = Context.all.at(-1);
      const before = ctx.resumes;
      ctx.setState('suspended');
      assert.equal(ctx.resumes, before);
      assert.equal(fake.pending.size, 0);
    } finally { subject.dispose(); }
  }

  // ---- device changes -----------------------------------------------------------------------------
  {
    useRealTimers();
    let runs = 0;
    let release;
    const runner = coalesceDeviceChanges(() => { runs++; return new Promise((resolve) => { release = resolve; }); }, 15);
    runner.trigger(); runner.trigger(); runner.trigger();
    await wait(40);
    assert.equal(runs, 1, 'a burst runs once');
    runner.trigger();
    await wait(40);
    assert.equal(runs, 1, 'never two at a time');
    release();
    await wait(40);
    assert.equal(runs, 2, 'a burst that landed during a run earns one more');
    release();
    await wait(40);
    assert.equal(runs, 2);
    runner.trigger();
    runner.cancel();
    await wait(40);
    assert.equal(runs, 2, 'cancel drops a pending run');
  }

  // ---- the exclusive bridge keeps playing across a boundary ---------------------------------------
  {
    useRealTimers();
    let onEvent = null;
    api.exclusiveSupported = async () => true;
    api.onExclusiveEvent = (fn) => { onEvent = fn; return () => {}; };
    api.onExclusiveTap = () => () => {};
    api.exclusivePlay = async () => ({ ok: true, chained: false });
    api.exclusiveStop = async () => {};
    api.exclusivePause = async () => {};
    const subject = new AudioEngine();
    try {
      assert.equal(await exclusiveBridge.setEnabled(subject, true), true);
      await subject.play('newamp://track/9', 9, 0);
      assert.equal(subject.getState().playing, true);
      onEvent({ type: 'boundary' });
      assert.equal(subject.getState().ended, true);
      assert.equal(subject.getState().playing, true, 'the stream chained on, so nothing paused');
      onEvent({ type: 'ended' });
      assert.equal(subject.getState().playing, false, 'a stream that ended stopped');
    } finally {
      await exclusiveBridge.setEnabled(subject, false);
      subject.dispose();
    }
  }

  // ---- store -----------------------------------------------------------------------------------
  useRealTimers();
  let saved = { ...DEFAULT_SETTINGS, sampleAccurateGapless: false };
  api.setSettings = async (patch) => (saved = { ...saved, ...patch });
  api.getSettings = async () => saved;
  for (const name of ['recordPlay', 'recordSkip', 'lastfmUpdateNowPlaying', 'lastfmScrobble']) api[name] = async () => {};
  api.onTracksRemoved = () => () => {};
  api.getTracks = async () => [];
  const plays = [];
  let hold = null;
  engine.setExternalTransport({
    play: (id) => { plays.push(id); return hold ? hold() : Promise.resolve(true); },
    pause() {}, resume() {}, stop() {}, seek() {}, prepareNext() {},
  });
  store.setState({ settings: saved, autoDjEnabled: false, mode: 'normal' });
  const [a, b, c] = [track(1), track(2), track(3)];

  {
    // A failure skips ahead, and says so in a toast that nothing overwrites.
    clearToasts();
    await store.getState().playQueue([a, b, c], 0);
    engine.patchExternal({ playing: true, currentTime: 30 });
    engine.patchExternal({ playing: false, error: 'Audio error (code 3)' });
    await wait(450);
    assert.equal(store.getState().current.id, 2, 'the failed track is skipped');
    const toast = getToasts().find((t) => t.title.startsWith('Skipped'));
    assert.ok(toast, 'the skip is announced');
    assert.equal(toast.title, 'Skipped Artist - Song 1');
    assert.equal(toast.detail, 'Audio error (code 3)');
    assert.equal(store.getState().playbackError, null, 'the engine owns the error field');
  }
  {
    // The old track's end, arriving while the new one is still being accepted, does not skip the new one.
    await store.getState().playQueue([a, b, c], 0);
    engine.patchExternal({ playing: true, currentTime: 100 });
    let accept;
    hold = () => new Promise((resolve) => { accept = resolve; });
    const before = plays.length;
    const advancing = store.getState().next();
    await settle();
    assert.equal(store.getState().current.id, 2);
    assert.equal(engine.getState().trackId, 1, 'the engine is still on the first track');
    engine.patchExternal({ playing: false, ended: true });
    await settle();
    await wait(20);
    assert.equal(plays.length, before + 1, 'the first track ending starts nothing');
    assert.equal(store.getState().current.id, 2, 'the second track is not skipped');
    hold = null;
    accept(true);
    await advancing;
    assert.equal(engine.getState().trackId, 2);
  }
  {
    // A queue edit while the end-of-queue lookup runs does not strand a track that already ended.
    await store.getState().playQueue([a], 0);
    engine.patchExternal({ playing: true, currentTime: 100 });
    let finish;
    api.getTracks = () => new Promise((resolve) => { finish = resolve; });
    engine.patchExternal({ playing: false, ended: true });
    await wait(20);
    assert.equal(typeof finish, 'function', 'the end of the queue went looking for more tracks');
    const before = plays.length;
    store.getState().addTrackToQueue(b);
    api.getTracks = async () => [];
    finish([]);
    await wait(40);
    assert.equal(plays.length, before + 1, 'the advance was worked out again');
    assert.equal(store.getState().current.id, 2, 'and found the track that was just added');
  }
  {
    // The playing track sits far into a long queue: the saved session still has it.
    const long = Array.from({ length: 12000 }, (_, i) => track(i + 1));
    const saved5 = playbackResumeStateForQueueSnapshot({ queue: long, index: 7000, current: long[7000], currentTime: 61, mode: 'normal' });
    assert.equal(saved5.queue.length, 5000);
    assert.equal(saved5.queueTrackIds.length, 5000);
    assert.equal(saved5.currentTrackId, 7001);
    assert.equal(saved5.queueTrackIds[saved5.index], 7001, 'the index points at the playing track inside the window');
    assert.equal(saved5.currentTime, 61);
    const again = playbackResumeStateForQueueSnapshot({ queue: long, index: 7000, current: long[7000], currentTime: 64, mode: 'normal' });
    assert.equal(again.queue, saved5.queue, 'an unchanged queue is not mapped again');
    const head = playbackResumeStateForQueueSnapshot({ queue: long, index: 10, current: long[10], currentTime: 0, mode: 'normal' });
    assert.equal(head.index, 10);
    assert.equal(head.queueTrackIds[0], 1);
    const tail = playbackResumeStateForQueueSnapshot({ queue: long, index: 11999, current: long[11999], currentTime: 0, mode: 'normal' });
    assert.equal(tail.queueTrackIds[tail.index], 12000);
    const short = [a, b, c];
    const small = playbackResumeStateForQueueSnapshot({ queue: short, index: 1, current: b, currentTime: 5, mode: 'normal' });
    assert.deepEqual(small.queueTrackIds, [1, 2, 3]);
    assert.equal(small.index, 1);
    assert.equal(playbackResumeStateForQueueSnapshot({ queue: [], index: -1, current: null, currentTime: 0, mode: 'normal' }), null);
  }
  {
    // A deck that read a longer file than the library row says is trusted; a CUE slice is not.
    await store.getState().playQueue([track(20, { duration: 100 })], 0);
    engine.patchExternal({ playing: true, currentTime: 10, duration: 300 });
    assert.equal(store.getState().duration, 300, 'the engine knows better than a stale row');
    await store.getState().playQueue([track(21, { duration: 100, cueStart: 50, cueEnd: 150 })], 0);
    engine.patchExternal({ playing: true, currentTime: 60, duration: 600 });
    assert.equal(store.getState().duration, 100, 'a slice keeps its own length');
  }
  {
    // Previous and Next are offered only where they go somewhere.
    const at = (index, mode = 'normal', over = {}) => transportAvailability({ queue: [a, b, c], index, mode, shuffleHistory: [], autoDjEnabled: false, ...over });
    assert.deepEqual(at(0), { hasPrevious: false, hasNext: true });
    assert.deepEqual(at(1), { hasPrevious: true, hasNext: true });
    assert.deepEqual(at(2), { hasPrevious: true, hasNext: false });
    assert.deepEqual(at(2, 'repeat-all'), { hasPrevious: true, hasNext: true });
    assert.deepEqual(at(0, 'repeat-all'), { hasPrevious: true, hasNext: true });
    assert.deepEqual(at(2, 'normal', { autoDjEnabled: true }), { hasPrevious: true, hasNext: true });
    // Previous restarts a track that is past 3 s, and Next at the end can extend a library track's album.
    assert.deepEqual(at(0, 'normal', { currentTime: 3 }), { hasPrevious: false, hasNext: true });
    assert.deepEqual(at(0, 'normal', { currentTime: 3.5 }), { hasPrevious: true, hasNext: true });
    assert.deepEqual(at(2, 'normal', { current: { id: 5 } }), { hasPrevious: true, hasNext: true });
    assert.deepEqual(at(2, 'normal', { current: { id: -1 } }), { hasPrevious: true, hasNext: false });
    assert.deepEqual(at(2, 'normal', { current: null }), { hasPrevious: true, hasNext: false });
    assert.deepEqual(at(-1), { hasPrevious: false, hasNext: false });
    assert.deepEqual(transportAvailability({ queue: [], index: -1, mode: 'normal', shuffleHistory: [], autoDjEnabled: false }), { hasPrevious: false, hasNext: false });
  }
  {
    // A track that fails to start rejects nothing for the fire-and-forget callers.
    engine.setExternalTransport(null);
    await store.getState().playQueue([a, b], 0).catch(() => undefined);
    const subject = engine;
    subject.graph.decks[subject.activeDeckIndex].el.failPlay = true;
    subject.graph.decks[1 - subject.activeDeckIndex].el.failPlay = true;
    const before = unhandled.length;
    await store.getState().next();
    store.getState().prev().catch((err) => { throw err; });
    await wait(30);
    assert.equal(unhandled.length, before, 'no unhandled rejection from a failed start');
    assert.ok(engine.getState().error, 'the failure is still published');
    // The store's skip timer would otherwise keep playing failing tracks after the engine is disposed.
    store.getState().clearQueue();
    engine.unload();
  }

  // ---- media session and window title ---------------------------------------------------------------
  {
    const handlers = new Map();
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaSession: { metadata: undefined, playbackState: 'none', setActionHandler: (action, fn) => handlers.set(action, fn) } },
      configurable: true,
    });
    const metadataBuilt = [];
    globalThis.MediaMetadata = class { constructor(init) { metadataBuilt.push(init); Object.assign(this, init); } };
    const seeks = [];
    const actions = { play() {}, pause() {}, previous() {}, next() {}, stop() {}, seek() {}, seekBy: (s) => seeks.push(s) };
    syncMediaSessionIdentity({ current: track(1, { hasArt: 0 }), isPlaying: true, actions, hasPrevious: false, hasNext: true });
    assert.equal(handlers.get('previoustrack'), null, 'Previous is not offered on the first track');
    assert.equal(typeof handlers.get('nexttrack'), 'function');
    handlers.get('seekbackward')({});
    handlers.get('seekforward')({ seekOffset: 15 });
    assert.deepEqual(seeks, [-10, 15], 'seek buttons skip ten seconds unless the OS names a distance');
    syncMediaSessionIdentity({ current: track(1, { hasArt: 0 }), isPlaying: true, actions });
    assert.equal(typeof handlers.get('previoustrack'), 'function', 'both default to available');

    // The OS reloads the cover whenever metadata is assigned. Previous becoming available three
    // seconds in, or a pause, changes the buttons and nothing about the track.
    const playing = track(1, { hasArt: 0 });
    syncMediaSessionIdentity({ current: null, isPlaying: false, actions });
    metadataBuilt.length = 0;
    syncMediaSessionIdentity({ current: playing, isPlaying: true, actions, hasPrevious: false, hasNext: true });
    syncMediaSessionIdentity({ current: playing, isPlaying: true, actions, hasPrevious: true, hasNext: true });
    syncMediaSessionIdentity({ current: playing, isPlaying: false, actions, hasPrevious: true, hasNext: true });
    assert.equal(metadataBuilt.length, 1, 'the same track is published once');
    assert.equal(typeof handlers.get('previoustrack'), 'function', 'while the buttons follow the change');
    assert.equal(navigator.mediaSession.playbackState, 'paused');
    syncMediaSessionIdentity({ current: { ...playing, title: 'Renamed' }, isPlaying: true, actions });
    assert.equal(metadataBuilt.length, 2, 'a track that changed is published again');
    assert.equal(metadataBuilt[1].title, 'Renamed');
    syncMediaSessionIdentity({ current: null, isPlaying: false, actions });
    assert.equal(navigator.mediaSession.metadata, null);
    syncMediaSessionIdentity({ current: playing, isPlaying: true, actions });
    assert.equal(metadataBuilt.length, 3, 'and so is a track that comes back after nothing was loaded');

    assert.equal(windowTitleFor(null), 'NewAmp');
    assert.equal(windowTitleFor(track(1, { title: ' Blue ', artist: 'Joni ' })), 'Blue - Joni');
    assert.equal(windowTitleFor(track(1, { title: '', artist: '' })), 'Unknown Track');
  }

  // ---- what opening files and folders says ---------------------------------------------------------
  {
    const some = (count, extra = {}) => ({ tracks: Array.from({ length: count }, (_, i) => track(i + 1)), importedPlaylists: [], skipped: [], ...extra });
    const plain = { queueKept: false, skinName: null };
    assert.equal(openedItemsStatus(some(2), plain), 'Playing 2 tracks.');
    assert.equal(openedItemsStatus(some(1), plain), 'Playing 1 track.');
    assert.equal(openedItemsStatus(some(2), { queueKept: true, skinName: null }), 'Playing 2 tracks, queue kept.');
    assert.equal(openedItemsStatus(some(2), { queueKept: false, skinName: 'Neon' }), 'Playing 2 tracks. Applied skin Neon.');
    assert.equal(openedItemsStatus(null, plain), 'Could not open the dropped items.');
    assert.equal(openedItemsStatus(some(0), plain), 'No playable audio was found in the dropped items.');
    assert.equal(openedItemsStatus(some(0), { queueKept: false, skinName: 'Neon' }), 'Applied skin Neon.');
    assert.equal(openedItemsStatus(some(0, { importedPlaylists: [{}] }), plain), 'Imported 1 playlist.');
    assert.equal(openedItemsStatus(some(0, { importedPlaylists: [{}, {}] }), plain), 'Imported 2 playlists.');

    // A folder past the queueing cap plays the first part and leaves the rest to the scanner.
    const cut = some(300, { leftToScanner: 4200 });
    assert.equal(openedItemsStatus(cut, plain), 'Playing the first 300 tracks. The rest of the folder is being added to the library.');
    assert.equal(openedItemsStatus(cut, { queueKept: true, skinName: null }), 'Playing the first 300 tracks, queue kept. The rest of the folder is being added to the library.');
    assert.equal(openedItemsStatus(some(120, { leftToScanner: 9 }), plain), 'Playing the first 120 tracks. The rest of the folder is being added to the library.', 'the number is what was queued');
    for (const left of [0, -3, Number.NaN, undefined, '40']) {
      assert.equal(openedItemsStatus(some(300, { leftToScanner: left }), plain), 'Playing 300 tracks.', `a count of ${String(left)} left to the scanner changes nothing`);
    }
    assert.equal(openedItemsStatus(some(0, { leftToScanner: 50 }), plain), 'No playable audio was found in the dropped items.', 'nothing queued keeps its message');

    assert.deepEqual(partialFolderNotice(cut), { title: 'Playing the first 300 tracks', detail: 'The rest of the folder is being added to the library.' });
    assert.equal(partialFolderNotice(some(300)), null, 'files opened from the menu say nothing unless a folder was cut short');
    assert.equal(partialFolderNotice(some(0, { leftToScanner: 50 })), null);
    assert.equal(partialFolderNotice(null), null);
  }

  assert.deepEqual(unhandled, [], 'nothing rejected without a handler');
  console.log('PASS a4 engine/store: deck stream retry, position holds, context resume, device-change bursts, exclusive boundary, skip notice, stale events, queue edits, resume window, durations, transport availability, media session');
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  useRealTimers();
  clearToasts();
  engine.dispose();
  clearTimeout(deadline);
}
