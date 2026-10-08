import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Data-URL module names otherwise expand entire bundles in assertion stacks.
Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map(frame => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('Audio/state regressions timed out'); process.exit(1); }, 20000);
deadline.unref();

class Param {
  constructor(value = 0) { this.value = value; this.ramps = []; }
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value, at) { this.ramps.push({ value, at }); }
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
  emit(type) { for (const fn of this.listeners[type] ?? []) fn(); }
  play() { this.paused = false; this.currentSrc = this.src; this.emit('play'); return Promise.resolve(); }
  pause() { this.paused = true; this.emit('pause'); }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
globalThis.Audio = Audio;
globalThis.AudioContext = Context;
globalThis.document = { documentElement: { dataset: {}, style: { removeProperty() {}, setProperty() {} } } };
globalThis.window = { newamp: {}, setTimeout, clearTimeout, setInterval, clearInterval, location: { search: '' }, winctl: { notifyPlayback() {} } };
const bundled = await build({
  stdin: { contents: `export * from './src/store/usePlayerStore'; export { AudioEngine } from './src/audio/engine'; export { api, DEFAULT_SETTINGS } from './src/lib/api'; export { clearToasts } from './src/lib/toast'; export { classifyAudioQuality } from './shared/audio-quality';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent',
});
const { engine, AudioEngine, usePlayerStore: store, api, DEFAULT_SETTINGS, clearToasts, classifyAudioQuality } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
await new Promise(queueMicrotask);
const settle = () => new Promise(setImmediate);
const base = { path: '/music/a.flac', artist: 'Artist', album: 'Album', albumArtist: 'Artist', duration: 180, title: 'A', replayGainTrackDb: null, replayGainAlbumDb: null };
const a = { ...base, id: 1 }, b = { ...base, id: 2, title: 'B' }, c = { ...base, id: 3, title: 'C' };
let saved = { ...DEFAULT_SETTINGS, sampleAccurateGapless: false };
api.setSettings = async patch => (saved = { ...saved, ...patch });
api.getSettings = async () => saved;
api.recordPlay = async () => {};
api.recordSkip = async () => {};
api.lastfmUpdateNowPlaying = async () => {};
api.lastfmScrobble = async () => {};
const plays = [];
engine.setExternalTransport({ play: async id => { plays.push(id); return true; }, pause() {}, resume() {}, stop() {}, seek() {}, prepareNext() {} });
store.setState({ settings: saved, autoDjEnabled: false });

try {
  for (const replacement of ['play', 'clear', 'append']) {
    for (const result of ['tracks', 'empty']) {
      await store.getState().playQueue([a]);
      let finish;
      api.getTracks = () => new Promise(resolve => { finish = resolve; });
      const pending = store.getState().next();
      await settle();
      if (replacement === 'play') await store.getState().playQueue([b]);
      else if (replacement === 'clear') store.getState().clearQueue();
      else store.getState().addTrackToQueue(b);
      const expected = store.getState().queue;
      const before = plays.length;
      // The empty branch searches several contexts; remaining lookups resolve immediately.
      api.getTracks = async () => [];
      finish(result === 'tracks' ? [a, c] : []);
      await pending;
      assert.equal(store.getState().queue, expected, `stale Next after ${replacement}/${result} leaves the queue alone`);
      assert.equal(plays.length, before);
    }
  }
  {
    await store.getState().playQueue([a]);
    api.getTracks = async () => [a, c];
    await store.getState().next();
    assert.equal(store.getState().current.id, 3, 'a current context expansion still advances');
  }
  {
    await store.getState().playQueue([a]);
    store.setState({ autoDjEnabled: true });
    let finish;
    api.buildHarmonicMix = () => new Promise(resolve => { finish = resolve; });
    const pending = store.getState().refillAutoDjQueue(true);
    store.getState().clearQueue();
    finish([a, c]);
    assert.deepEqual(await pending, []);
    assert.deepEqual(store.getState().queue, [], 'Auto DJ cannot refill a queue the user cleared');
    store.getState().loadQueue([a]);
    api.buildHarmonicMix = async () => [a, c];
    await store.getState().refillAutoDjQueue(true);
    assert.deepEqual(store.getState().queue.map(track => track.id), [1, 3], 'a current refill still appends its candidates');
    store.setState({ autoDjEnabled: false });
  }
  {
    const resumeState = { queueTrackIds: [1], currentTrackId: 1, index: 0, currentTime: 33, mode: 'normal', updatedAt: 1 };
    saved = { ...DEFAULT_SETTINGS, sampleAccurateGapless: false, resumeState };
    let finish;
    api.getTracksByIds = () => new Promise(resolve => { finish = resolve; });
    const pending = store.getState().init();
    await settle();
    assert.equal(typeof finish, 'function');
    await store.getState().playQueue([b]);
    finish([a]);
    await pending;
    assert.equal(store.getState().current.id, 2, 'startup restore cannot overwrite a new play');
  }
  {
    store.setState({ settings: { ...saved, equalizer: Array(10).fill(0) } });
    const requests = [];
    api.setSettings = patch => new Promise(resolve => requests.push({ patch, resolve }));
    const first = store.getState().setEqBand(0, 4);
    const second = store.getState().setEqBand(1, -3);
    assert.deepEqual(requests[1].patch.equalizer.slice(0, 2), [4, -3], 'second band edit includes the first pending edit');
    requests[1].resolve({ ...saved, ...requests[1].patch });
    await second;
    requests[0].resolve({ ...saved, ...requests[0].patch });
    await first;
    assert.deepEqual(store.getState().settings.equalizer.slice(0, 2), [4, -3], 'late acknowledgement cannot restore an older EQ curve');
    api.setSettings = async patch => (saved = { ...saved, ...patch });
  }
  {
    const subject = new AudioEngine();
    try {
      subject.setCrossfadeMs(1000);
      subject.setReplayGainDb(-12);
      await subject.play('/first.wav', 1);
      const outgoing = subject.activeDeck;
      const gainA = Math.pow(10, -12 / 20);
      assert.equal(outgoing.replayGain.gain.value, gainA);
      subject.setReplayGainDb(6);
      await subject.play('/next.wav', 2);
      await settle();
      assert.equal(outgoing.replayGain.gain.value, gainA, 'outgoing crossfade keeps its own ReplayGain');
      assert.equal(subject.activeDeck.replayGain.gain.value, Math.pow(10, 6 / 20));
      assert.equal(subject.graph.replayGain.gain.value, 1, 'mixed signal is not normalized a second time');
      subject.setReplayGainDb(-3);
      await settle();
      assert.equal(subject.activeDeck.replayGain.gain.value, Math.pow(10, -3 / 20), 'mid-track gain changes still apply');
      assert.equal(outgoing.replayGain.gain.value, gainA);
    } finally { subject.dispose(); }
  }
  assert.equal(classifyAudioQuality({ path: '/alac.m4a', bitrate: 900000, sampleRate: 96000 }).family, 'container', 'M4A alone cannot identify a lossy codec');
  assert.equal(classifyAudioQuality({ path: '/track.flac', bitrate: 900000, sampleRate: 96000 }).family, 'lossless');
  console.log('PASS current-source audio/state regressions: stale Next, Auto DJ, restore, EQ, ReplayGain, container classification');
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  clearToasts();
  engine.dispose();
  clearTimeout(deadline);
}
