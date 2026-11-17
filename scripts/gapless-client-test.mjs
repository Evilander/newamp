// The renderer side of the sample-accurate gapless transport — the real
// store, AudioEngine and SampleTransport — against a scripted worklet and a
// scripted main process. Covers what only shows up between those three: the
// queue following a chained boundary (re-point, Stop after current, one play
// count, no stale clock), a chained track too short to be acknowledged, scrub
// coalescing, releasing the stream on a long pause, the starvation fallback,
// the PCM port handshake, routing (DSD, missing files, CUE segments, a
// practice loop), a decline that keeps the preloaded deck, repeat-one
// chaining the track to itself, a chained track that fails before it is
// heard, durations corrected by the decoder, and the silent element that
// keeps the OS media session while the transport plays. A transport of its own
// on a fake clock covers what the 4 s fallback does around a producer's
// 'wait' (a file being read again), and the worklet's real process() covers
// what it does once the stream has drained.
// Run: node scripts/gapless-client-test.mjs

import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- fakes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeParam {
  constructor(value = 0) {
    this.value = value;
  }
  cancelScheduledValues() {}
  setValueAtTime(value) {
    this.value = value;
  }
  linearRampToValueAtTime(value) {
    this.value = value;
  }
  setTargetAtTime(value) {
    this.value = value;
  }
}
class FakeNode {
  constructor() {
    this.gain = new FakeParam(1);
  }
  connect() {}
  disconnect() {}
}
// Every element the engine makes, and those it routes into the graph.
const audios = [];
const graphSources = new Set();
class FakeAudio {
  constructor() {
    audios.push(this);
    this.listeners = {};
    this.rawSrc = '';
    this.currentSrc = '';
    this.srcSets = 0;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = NaN;
    this.playbackRate = 1;
  }
  get src() {
    return this.rawSrc;
  }
  set src(value) {
    this.rawSrc = value;
    this.srcSets++;
  }
  removeAttribute(name) {
    if (name === 'src') this.rawSrc = '';
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  load() {
    if (this.rawSrc) this.currentSrc = this.rawSrc;
  }
  play() {
    if (!this.rawSrc) return Promise.reject(new Error('no src'));
    this.paused = false;
    this.currentSrc = this.rawSrc;
    this.fire('play');
    this.fire('playing');
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }
}
const timing = { addModuleMs: 0 };
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = new FakeNode();
    this.audioWorklet = { addModule: () => sleep(timing.addModuleMs) };
  }
  createGain() {
    return new FakeNode();
  }
  createBiquadFilter() {
    const node = new FakeNode();
    node.frequency = new FakeParam(0);
    node.Q = new FakeParam(1);
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeNode();
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[k] = new FakeParam(0);
    return node;
  }
  createAnalyser() {
    return new FakeNode();
  }
  createChannelSplitter() {
    return new FakeNode();
  }
  createMediaElementSource(el) {
    graphSources.add(el);
    return new FakeNode();
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
// The worklet: records what the transport tells it; the test speaks for it
// through port.onmessage.
const nodes = [];
class FakeAudioWorkletNode {
  constructor() {
    this.connected = false;
    this.port = {
      onmessage: null,
      sent: [],
      transfers: [],
      postMessage(message, transfer) {
        this.sent.push(message);
        if (transfer) this.transfers.push(...transfer);
      },
      addEventListener() {},
      removeEventListener() {},
    };
    nodes.push(this);
  }
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

const storage = new Map();
const win = new EventTarget();
Object.assign(win, {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  location: { search: '' },
  winctl: { notifyPlayback() {} },
  toAudioUrl: (path) => `newamp://track/${encodeURIComponent(path)}`,
  localStorage: {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
});
globalThis.window = win;
globalThis.localStorage = win.localStorage;
// The play counter measures listening against performance.now(); listenUpTo
// moves it along with the audio it plays.
let clockSkew = 0;
const realPerformanceNow = performance.now.bind(performance);
performance.now = () => realPerformanceNow() + clockSkew;
globalThis.AudioContext = FakeAudioContext;
globalThis.Audio = FakeAudio;
globalThis.AudioWorkletNode = FakeAudioWorkletNode;

// ---------------------------------------------------------------- bundle

// Per process, so concurrent runs don't overwrite each other's bundle.
const root = resolve('tmp', 'gapless-client-test', String(process.pid));
mkdirSync(root, { recursive: true });
await build({
  stdin: {
    contents: `export { usePlayerStore, engine } from './src/store/usePlayerStore';
      export { SampleTransport } from './src/audio/sample-transport';
      export { api, DEFAULT_SETTINGS } from './src/lib/api';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: resolve(root, 'bundle.mjs'),
  define: { 'import.meta.env.DEV': 'false' },
  logLevel: 'silent',
});
const { usePlayerStore: store, engine, SampleTransport, api, DEFAULT_SETTINGS } = await import(pathToFileURL(resolve(root, 'bundle.mjs')));

// ---------------------------------------------------------------- scripted main

// The producer answers a start with the library's duration for the track
// (or a better one from its decoder); the scripted main does the same.
const libraryDurations = new Map();
const main = {
  opens: 0,
  portDelayMs: [],
  starts: [],
  prepares: [],
  stops: [],
  plays: [],
  scrobbles: [],
  startResult: (request) => ({ ok: true, durationSec: libraryDurations.get(request.trackId) ?? null, sourceSampleRate: 48000, resampler: 'none', resamplerKind: 'swr', request }),
};
api.setSettings = async (patch) => ({ ...store.getState().settings, ...patch });
api.gaplessOpen = async () => {
  const id = ++main.opens;
  const { port1 } = new MessageChannel();
  const deliver = () => win.dispatchEvent(new MessageEvent('newamp:gapless-port', { data: { id }, ports: [port1] }));
  const delay = main.portDelayMs.shift() ?? 0;
  if (delay > 0) setTimeout(deliver, delay);
  else deliver();
  main.lastPort = port1;
  return id;
};
api.gaplessStart = async (request) => {
  main.starts.push(request);
  await sleep(5);
  return main.startResult(request);
};
api.gaplessPrepareNext = async (gen, after, next) => {
  main.prepares.push({ gen, after, next });
};
api.gaplessStop = async (gen) => {
  main.stops.push(gen);
};
api.recordPlay = async (id) => {
  main.plays.push(id);
};
api.lastfmScrobble = async (track) => {
  main.scrobbles.push(track.track ?? track.title);
};
api.lastfmUpdateNowPlaying = async () => undefined;

// ---------------------------------------------------------------- helpers

const failures = [];
const report = {};
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
async function scenario(name, run) {
  try {
    report[name] = (await run()) ?? {};
  } catch (err) {
    failures.push(`${name}: ${err?.message ?? err}`);
  }
}

let nextTrackId = 1;
function track(title, duration, extra = {}) {
  const id = nextTrackId++;
  libraryDurations.set(id, duration);
  return {
    id,
    path: `/music/${title}.flac`,
    title,
    artist: 'Artist',
    album: 'Album',
    albumArtist: 'Artist',
    trackNo: id,
    discNo: 1,
    year: 2026,
    genre: null,
    duration,
    bitrate: null,
    sampleRate: 48000,
    size: null,
    mtime: 0,
    hasArt: 0,
    loved: 0,
    rating: 0,
    ratingScore: null,
    avoidAutoPlay: 0,
    playCount: 0,
    lastPlayed: null,
    skipCount: 0,
    lastSkipped: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    ...extra,
  };
}

let transport = null;
async function fresh(settings = {}) {
  store.getState().loadQueue([]);
  engine.setSampleTransport(null);
  engine.setPracticeLoopActive?.(false);
  transport = new SampleTransport();
  engine.setSampleTransport(transport);
  for (const key of ['starts', 'prepares', 'stops', 'plays', 'scrobbles']) main[key] = [];
  main.portDelayMs = [];
  main.startResult = (request) => ({ ok: true, durationSec: libraryDurations.get(request.trackId) ?? null, sourceSampleRate: 48000, resampler: 'none', resamplerKind: 'swr', request });
  store.setState({
    settings: { ...DEFAULT_SETTINGS, lastfmEnabled: true, replayGain: 'track', crossfadeMs: 0, sampleAccurateGapless: true, ...settings },
    stopAfterCurrent: false,
    mode: 'normal',
  });
  await sleep(20);
}

/** The worklet reports, in the transport's current generation. */
const worklet = {
  emit: (message) => transport.node.port.onmessage({ data: { gen: transport.gen, ...message } }),
  segment(token, extra = {}) {
    this.emit({ t: 'segment', token, first: false, frame: 0, failed: null, durationSec: null, sourceRate: 48000, resampler: 'none', ...extra });
  },
  pos(token, seconds, extra = {}) {
    this.emit({ t: 'pos', token, segmentFrames: Math.round(seconds * 48000), frame: 0, playing: true, starving: false, underruns: 0, queued: 0, ...extra });
  },
};
const tick = () => sleep(160);
const lastPrepare = () => main.prepares.at(-1);
const decks = () => engine.graph.decks;

async function until(test, timeoutMs, what) {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}

// A library play is counted once half the track has been heard, not when it
// starts, and heard time is bounded by the clock: a position that moves further
// than the clock did is a seek. Walk the position forward the way playback
// does, one engine tick apart, with the clock moving as far as the audio.
async function listenUpTo(seconds, move) {
  let at = store.getState().currentTime;
  while (at < seconds) {
    const next = Math.min(seconds, at + 4.9);
    clockSkew += (next - at) * 1000;
    at = next;
    move(at);
    await until(() => store.getState().currentTime >= at - 0.01, 2000, `the clock reaches ${at.toFixed(1)} s`);
  }
}

// ---------------------------------------------------------------- scenarios

await scenario('chained queue', async () => {
  await fresh();
  const A = track('a', 300);
  const B = track('b', 300);
  const C = track('c', 300);
  const D = track('d', 300);
  await store.getState().playQueue([A, B, C], 0);
  const tA = main.starts[0]?.token;
  worklet.segment(tA, { first: true });
  // Half of A (300 s) is heard, which is what scrobbles it; a jump to 200 s would not.
  await listenUpTo(200, (at) => worklet.pos(tA, at));
  await tick();
  // Inside the prepare window B is spliced in.
  worklet.pos(tA, 295);
  await tick();
  const preparedB = lastPrepare()?.next?.trackId === B.id;
  // A queue edit inside the window re-points the splice.
  store.getState().queueTrackNext(D);
  worklet.pos(tA, 295.2);
  await tick();
  const repointed = lastPrepare()?.next?.trackId === D.id;
  // Stop after current un-chains it; turning it off chains D again.
  store.getState().setStopAfterCurrent(true);
  worklet.pos(tA, 295.4);
  await tick();
  const unchained = lastPrepare()?.next === null;
  store.getState().setStopAfterCurrent(false);
  worklet.pos(tA, 295.6);
  await tick();
  const tD = lastPrepare()?.next?.trackId === D.id ? lastPrepare().next.token : null;
  // D becomes audible on its first frame; the store follows.
  let maxClockOnD = 0;
  const off = store.subscribe((s) => {
    if (s.current?.id === D.id) maxClockOnD = Math.max(maxClockOnD, s.currentTime);
  });
  const startsBefore = main.starts.length;
  const preparesBefore = main.prepares.length;
  worklet.segment(tD);
  await until(() => store.getState().current?.id === D.id && engine.getState().trackId === D.id, 2000, 'store follows the chained boundary');
  worklet.pos(tD, 0.3);
  await tick();
  off();
  const playsOfDAtBoundary = main.plays.filter((id) => id === D.id).length;
  const scrobbledAtBoundary = [...main.scrobbles];
  // Half of D (300 s) is a play and a scrobble, each once however the boundary got there.
  await listenUpTo(155, (at) => worklet.pos(tD, at));
  const out = {
    preparedB,
    repointed,
    unchained,
    rechained: tD != null,
    restartedStream: main.starts.length !== startsBefore,
    playsOfDAtBoundary,
    playsOfD: main.plays.filter((id) => id === D.id).length,
    scrobbledAtBoundary,
    scrobbled: main.scrobbles,
    maxStoreClockOnD: Number(maxClockOnD.toFixed(3)),
    // A prepare for what follows D issued at the boundary means the store
    // read A's end time as D's.
    earlyPrepareAfterD: main.prepares.slice(preparesBefore).some((p) => p.after === tD),
    playing: store.getState().isPlaying,
  };
  check(preparedB && repointed && unchained && out.rechained, `chained queue: splice edits ${JSON.stringify(out)}`);
  check(!out.restartedStream && out.playing, 'chained queue: the boundary restarted the stream');
  check(out.playsOfDAtBoundary === 0, `chained queue: D counted ${out.playsOfDAtBoundary} plays on arrival`);
  check(out.playsOfD === 1, `chained queue: D counted ${out.playsOfD} plays`);
  check(out.scrobbledAtBoundary.length === 1 && out.scrobbledAtBoundary[0] === 'a', `chained queue: scrobbles at the boundary ${JSON.stringify(out.scrobbledAtBoundary)}`);
  check(out.scrobbled.length === 2 && out.scrobbled[1] === 'd', `chained queue: scrobbles after half of D ${JSON.stringify(out.scrobbled)}`);
  check(out.maxStoreClockOnD < 1 && !out.earlyPrepareAfterD, `chained queue: A's end time leaked into D (${out.maxStoreClockOnD} s)`);
  return out;
});

await scenario('short chained track', async () => {
  await fresh();
  const A = track('a2', 60);
  const B = track('b2', 0.05);
  const C = track('c2', 60);
  await store.getState().playQueue([A, B, C], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true });
  worklet.pos(tA, 55);
  await tick();
  const tB = lastPrepare()?.next?.token;
  // B becomes audible and plays out before the store's advance gets to it.
  worklet.segment(tB);
  worklet.emit({ t: 'drained', token: tB, segmentFrames: 2400, frame: 0 });
  let advanced = true;
  try {
    await until(() => main.starts.some((s) => s.trackId === C.id), 2000, 'queue moves past the short track');
  } catch {
    advanced = false;
  }
  const out = { advancedToC: advanced, current: store.getState().current?.title ?? null, playsOfB: main.plays.filter((id) => id === B.id).length };
  check(advanced && out.current === 'c2', `short chained track: queue stalled on ${out.current}`);
  check(out.playsOfB === 1, `short chained track: B counted ${out.playsOfB} plays`);
  return out;
});

await scenario('single seek', async () => {
  const out = [];
  for (const extension of ['flac', 'mp3']) {
    await fresh();
    const A = track(`click-${extension}`, 300, { path: `/music/click.${extension}` });
    await store.getState().playQueue([A], 0);
    worklet.segment(main.starts[0].token, { first: true });
    worklet.pos(main.starts[0].token, 20);
    const before = main.starts.length;
    const sentBefore = transport.node.port.sent.length;
    store.getState().seek(120);
    await sleep(30);
    const restart = main.starts.at(-1);
    worklet.segment(restart.token, { first: true });
    worklet.pos(restart.token, 0.1);
    // Past both seek coalescing and the scrubber's release-resync window:
    // position feedback must not echo a second decoder start or flush.
    await sleep(350);
    const starts = main.starts.length - before;
    const flushes = transport.node.port.sent.slice(sentBefore).filter((m) => m.t === 'flush').length;
    check(starts === 1 && flushes === 1, `single ${extension} seek: ${starts} starts, ${flushes} flushes`);
    check(restart.startAt === 120 && store.getState().isPlaying && !store.getState().isBuffering,
      `single ${extension} seek: target or resumed playback was lost`);
    check(engine.getPlaybackPosition() >= 120, `single ${extension} seek: playback clock did not resume at the target`);
    out.push({ extension, starts, flushes, target: restart.startAt });
  }
  return out;
});

await scenario('scrub', async () => {
  await fresh();
  const A = track('scrub', 300);
  await store.getState().playQueue([A], 0);
  worklet.segment(main.starts[0].token, { first: true });
  const before = main.starts.length;
  // A drag: ~60 input events a second for 3 s.
  const started = Date.now();
  let events = 0;
  let clockFollows = true;
  while (Date.now() - started < 3000) {
    const target = 10 + events * 0.5;
    store.getState().seek(target);
    events++;
    await sleep(16);
    if (Math.abs(engine.getPlaybackPosition() - target) > 0.01) clockFollows = false;
  }
  const during = main.starts.length - before;
  await sleep(300);
  const total = main.starts.length - before;
  const last = main.starts.at(-1);
  const out = { inputEvents: events, restartsDuringDrag: during, restartsTotal: total, finalTarget: last?.startAt, clockFollowsDrag: clockFollows };
  check(total <= 3 && Math.abs(last.startAt - (10 + (events - 1) * 0.5)) < 1e-6, `scrub: ${JSON.stringify(out)}`);
  check(clockFollows, 'scrub: the reported position jumped back to the playing point during the drag');
  return out;
});

await scenario('long pause', async () => {
  await fresh();
  const A = track('pause', 300);
  const B = track('pause-next', 300);
  await store.getState().playQueue([A, B], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true });
  worklet.pos(tA, 292);
  await tick();
  const chained = lastPrepare()?.next?.trackId === B.id;
  store.getState().togglePlay();
  worklet.pos(tA, 292.5, { playing: false });
  await sleep(5400);
  const released = main.stops.length > 0;
  const positionWhileReleased = engine.getPlaybackPosition();
  store.getState().togglePlay();
  await sleep(50);
  const restart = main.starts.at(-1);
  const out = {
    stoppedAfterMs: released ? '<= 5400' : null,
    positionWhileReleased,
    restartAt: restart?.startAt,
    restartChains: restart?.next?.trackId === B.id,
    restartPlaying: store.getState().isPlaying,
  };
  check(chained && released, `long pause: stream not released (${JSON.stringify(out)})`);
  check(Math.abs(positionWhileReleased - 292.5) < 1e-6 && Math.abs((restart?.startAt ?? 0) - 292.5) < 1e-6, `long pause: position ${JSON.stringify(out)}`);
  check(out.restartChains && out.restartPlaying, `long pause: resume ${JSON.stringify(out)}`);
  return out;
});

await scenario('starvation', async () => {
  await fresh();
  const A = track('starve', 300);
  await store.getState().playQueue([A], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true });
  worklet.pos(tA, 20);
  await tick();
  const reportStarving = () => worklet.pos(tA, 20.5, { starving: true });
  reportStarving();
  await sleep(50);
  const buffering = engine.getState().buffering;
  const timer = setInterval(reportStarving, 43);
  await sleep(4300);
  clearInterval(timer);
  const deck = decks().find((d) => d.el.src.includes('starve'));
  const out = {
    buffering,
    transportActive: engine.isSampleTransportActive(),
    stopped: main.stops.length > 0,
    deckTookOver: !!deck && !deck.el.paused,
    fallbackReason: engine.getSampleTransportInfo().fallbackReason,
  };
  check(out.buffering, 'starvation: a dry worklet was not reported as buffering');
  check(!out.transportActive && out.stopped && out.deckTookOver, `starvation: no fallback to the decks ${JSON.stringify(out)}`);
  return out;
});

await scenario('port handshake', async () => {
  await fresh();
  // The first open's port is still in flight when the transport is torn down
  // and attached again (the setting flipped off and on).
  main.portDelayMs = [40, 80];
  const ctx = engine.ctx;
  const first = transport.attach(ctx, engine.masterGain);
  await sleep(10);
  transport.detach();
  const second = transport.attach(ctx, engine.masterGain);
  const results = await Promise.all([first, second]);
  const secondPort = main.lastPort;
  const live = nodes.filter((n) => n.connected);
  const bound = live.at(-1)?.port.transfers.at(-1);
  const out = { attachResults: results, connectedNodes: live.length, boundToLatestPort: bound === secondPort };
  check(results[1] === true && out.connectedNodes === 1 && out.boundToLatestPort, `port handshake: ${JSON.stringify(out)}`);
  return out;
});

await scenario('detach during connect', async () => {
  await fresh();
  for (const n of nodes) n.connected = false;
  const created = nodes.length;
  timing.addModuleMs = 40;
  const attaching = transport.attach(engine.ctx, engine.masterGain);
  await sleep(5);
  transport.detach();
  const result = await attaching;
  await sleep(60);
  timing.addModuleMs = 0;
  const orphans = nodes.slice(created).filter((n) => n.connected);
  const out = { attachResult: result, orphanedNodes: orphans.length };
  check(orphans.length === 0, `detach during connect: ${orphans.length} worklet node(s) still wired into the graph`);
  return out;
});

await scenario('segment log', async () => {
  await fresh();
  const tracks = Array.from({ length: 52 }, (_, i) => track(`seg${i}`, 300));
  await store.getState().playQueue(tracks, 0);
  let token = main.starts[0].token;
  worklet.segment(token, { first: true });
  for (let i = 1; i < 50; i++) {
    transport.prepareNext({ trackId: tracks[i].id, src: window.toAudioUrl(tracks[i].path), gain: 1 });
    token = lastPrepare().next.token;
    worklet.segment(token);
    transport.ack();
  }
  const out = { boundaries: 49, segmentsKept: transport.segments.size };
  check(out.segmentsKept <= 3, `segment log: ${out.segmentsKept} segments kept after 49 boundaries`);
  return out;
});

await scenario('replaygain mode', async () => {
  await fresh();
  const A = track('rg-a', 300, { replayGainTrackDb: -3, replayGainAlbumDb: -3 });
  const B = track('rg-b', 300, { replayGainTrackDb: -2, replayGainAlbumDb: -8 });
  await store.getState().playQueue([A, B], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true });
  worklet.pos(tA, 295);
  await tick();
  const tB = lastPrepare()?.next?.token;
  await store.getState().setReplayGainMode('album');
  await sleep(20);
  const sent = transport.node.port.sent.filter((m) => m.t === 'gain' && m.token === tB).at(-1);
  const expected = 10 ** (-8 / 20);
  const out = { chainedGain: sent?.gain ?? null, expected: Number(expected.toFixed(6)) };
  check(sent && Math.abs(sent.gain - expected) < 1e-6, `replaygain mode: the chained track kept its old gain ${JSON.stringify(out)}`);
  return out;
});

await scenario('signal path', async () => {
  await fresh();
  main.startResult = (request) => ({ ok: true, durationSec: libraryDurations.get(request.trackId) ?? null, sourceSampleRate: 44100, resampler: 'swr', resamplerKind: 'swr', request });
  const A = track('sig-a', 300, { sampleRate: 44100 });
  const B = track('sig-b', 300);
  await store.getState().playQueue([A, B], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true, sourceRate: 44100, resampler: 'swr' });
  const onA = engine.getSampleTransportInfo();
  worklet.pos(tA, 295);
  await tick();
  const tB = lastPrepare()?.next?.token;
  worklet.segment(tB, { sourceRate: 48000, resampler: 'none' });
  await until(() => engine.getState().trackId === B.id, 2000, 'B acknowledged');
  const onB = engine.getSampleTransportInfo();
  const out = { onA: { rate: onA.sourceSampleRate, resampler: onA.resampler }, onB: { rate: onB.sourceSampleRate, resampler: onB.resampler } };
  check(onA.resampler === 'swr' && onA.sourceSampleRate === 44100, `signal path during A: ${JSON.stringify(out.onA)}`);
  check(onB.resampler === 'none' && onB.sourceSampleRate === 48000, `signal path during B: ${JSON.stringify(out.onB)}`);
  return out;
});

await scenario('routing', async () => {
  const route = async (t) => {
    await fresh();
    await store.getState().playQueue([t], 0);
    await sleep(20);
    return { transport: main.starts.some((s) => s.trackId === t.id), deck: decks().some((d) => d.el.src.includes(encodeURIComponent(t.path))) };
  };
  const dsd = await route({ ...track('dsd', 300), path: '/music/dsd.dsf' });
  const missing = await route(track('missing', 300, { missingSince: Date.now() }));
  // A CUE segment keeps the decks by its cue fields, whatever its id.
  const cue = await route(track('cue', 120, { cuePath: '/music/album.cue', cueStart: 0, cueEnd: 120 }));
  const plain = await route(track('plain', 300));
  const out = { dsd, missing, cue, plain };
  for (const [name, r] of Object.entries({ dsd, missing, cue })) {
    check(!r.transport && r.deck, `routing: ${name} went to ${r.transport ? 'the transport' : 'nowhere'}`);
  }
  check(plain.transport, 'routing: a plain local track did not use the transport');
  return out;
});

await scenario('practice loop', async () => {
  await fresh();
  const A = track('loop', 300);
  await store.getState().playQueue([A], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true });
  worklet.pos(tA, 30);
  await tick();
  engine.setPracticeLoopActive(true);
  await sleep(30);
  const deck = decks().find((d) => d.el.src.includes('loop'));
  const out = { transportActive: engine.isSampleTransportActive(), deckPlaying: !!deck && !deck.el.paused, stopped: main.stops.length > 0 };
  engine.setPracticeLoopActive(false);
  check(!out.transportActive && out.deckPlaying && out.stopped, `practice loop: ${JSON.stringify(out)}`);
  return out;
});

await scenario('declined start keeps the preload', async () => {
  await fresh();
  // A stream on the decks with a local track preloaded behind it; the
  // transport then declines that local track.
  const stream = { ...track('stream', 300), id: -900, path: 'https://radio.example/stream.mp3' };
  const B = track('declined', 300);
  await engine.play(stream.path, stream.id, 0);
  engine.prepareNext(window.toAudioUrl(B.path), B.id, 0, null);
  const preloaded = decks().find((d) => d.el.src.includes('declined'));
  const setsBefore = preloaded?.el.srcSets;
  main.startResult = () => ({ ok: false, error: 'declined by the test' });
  await engine.play(window.toAudioUrl(B.path), B.id, 0);
  const playing = decks().find((d) => !d.el.paused && d.el.src.includes('declined'));
  const out = {
    triedTransport: main.starts.some((s) => s.trackId === B.id),
    playedPreloadedDeck: !!preloaded && playing === preloaded,
    reloaded: !!preloaded && preloaded.el.srcSets !== setsBefore,
  };
  check(out.triedTransport && out.playedPreloadedDeck && !out.reloaded, `declined start: ${JSON.stringify(out)}`);
  return out;
});

await scenario('repeat one', async () => {
  await fresh();
  const A = track('loop-a', 300);
  const B = track('loop-b', 300);
  await store.getState().playQueue([A, B], 0);
  store.getState().setMode('repeat-one');
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true });
  worklet.pos(tA, 200);
  await tick();
  // Inside the prepare window the track is chained to itself.
  worklet.pos(tA, 295);
  await tick();
  const first = lastPrepare();
  const startsBefore = main.starts.length;
  const loop = first?.next?.token;
  // The loop is audible from its first frame; the store plays it again,
  // which the engine acknowledges without touching the stream.
  worklet.segment(loop);
  await until(() => engine.getState().trackId === A.id && !engine.getState().ended && !transport.isUnackedChain(A.id, window.toAudioUrl(A.path)), 2000, 'the loop is acknowledged');
  worklet.pos(loop, 0.3);
  await tick();
  // The first pass was only jumped through; half of the loop is a play of its own.
  const playsAtLoopStart = main.plays.filter((id) => id === A.id).length;
  await listenUpTo(155, (at) => worklet.pos(loop, at));
  const playsOfLoop = main.plays.filter((id) => id === A.id).length;
  // Each loop chains the next one.
  worklet.pos(loop, 296);
  await tick();
  const second = lastPrepare();
  // Repeat off inside the window: the splice moves to what follows.
  store.getState().setMode('normal');
  worklet.pos(loop, 296.2);
  await tick();
  const out = {
    chainedItself: first?.next?.trackId === A.id && first.after === tA,
    restartedStream: main.starts.length !== startsBefore,
    secondLoopChained: second?.next?.trackId === A.id && second.after === loop,
    repointedWhenRepeatOff: lastPrepare()?.next?.trackId === B.id,
    current: store.getState().current?.title ?? null,
    playing: store.getState().isPlaying,
    playsAtLoopStart,
    playsOfLoop,
  };
  check(playsAtLoopStart === 0 && playsOfLoop === 1, `repeat one: the loop was not counted as a play of its own ${JSON.stringify(out)}`);
  check(out.chainedItself && out.secondLoopChained, `repeat one: the track was not chained to itself ${JSON.stringify(out)}`);
  check(!out.restartedStream && out.playing && out.current === 'loop-a', `repeat one: the loop restarted the stream ${JSON.stringify(out)}`);
  check(out.repointedWhenRepeatOff, `repeat one: turning repeat off did not re-point the splice ${JSON.stringify(out)}`);
  return out;
});

await scenario('chained failure before audible', async () => {
  await fresh();
  const A = track('qf-a', 300);
  const B = track('qf-b', 300);
  const C = track('qf-c', 300);
  await store.getState().playQueue([A, B, C], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true });
  worklet.pos(tA, 295);
  await tick();
  const tB = lastPrepare()?.next?.token;
  // B's resampler dies while B is still queued behind A: the worklet passes
  // the failure on before B is audible, then reaches B's marker.
  worklet.emit({ t: 'fail', token: tB, message: 'Resampling failed.', audible: false });
  const stopsBefore = main.stops.length;
  worklet.segment(tB);
  let onDecks = true;
  try {
    await until(() => store.getState().current?.id === B.id && decks().some((d) => !d.el.paused && d.el.src.includes('qf-b')), 2000, 'B moves to the decks');
  } catch {
    onDecks = false;
  }
  const playsOfBOnArrival = main.plays.filter((id) => id === B.id).length;
  // B plays on from its start on the decks; half of it (300 s) is the one play.
  const deck = decks().find((d) => !d.el.paused && d.el.src.includes('qf-b'));
  if (deck) await listenUpTo(155, (at) => { deck.el.currentTime = at; });
  const out = {
    onDecks,
    transportActive: engine.isSampleTransportActive(),
    streamStopped: main.stops.length > stopsBefore,
    fallbackReason: engine.getSampleTransportInfo().fallbackReason,
    playsOfBOnArrival,
    playsOfB: main.plays.filter((id) => id === B.id).length,
  };
  check(out.onDecks && !out.transportActive && out.streamStopped, `chained failure: B stayed on the failed stream ${JSON.stringify(out)}`);
  check(out.fallbackReason === 'Resampling failed.' && out.playsOfBOnArrival === 0 && out.playsOfB === 1, `chained failure: ${JSON.stringify(out)}`);
  return out;
});

await scenario('chained failure at the boundary', async () => {
  await fresh();
  const A = track('bf-a', 300);
  const B = track('bf-b', 300);
  const C = track('bf-c', 300);
  await store.getState().playQueue([A, B, C], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true });
  worklet.pos(tA, 295);
  await tick();
  const tB = lastPrepare()?.next?.token;
  // B could not be opened. The producer sends its marker, the failure and the
  // end of the stream together, so the worklet reports the failed boundary and
  // that the stream drained in the same quantum.
  const gen = transport.gen;
  worklet.segment(tB, { failed: 'Decode failed.' });
  transport.node.port.onmessage({ data: { gen, t: 'drained', token: tB, segmentFrames: 0, frame: 0 } });
  const state = engine.getState();
  const out = { playing: state.playing, ended: state.ended, trackId: state.trackId, streamStopped: !transport.hasStream() };
  let onDecks = true;
  try {
    await until(() => store.getState().current?.id === B.id && decks().some((d) => !d.el.paused && d.el.src.includes('bf-b')), 2000, 'B moves to the decks');
  } catch {
    onDecks = false;
  }
  out.onDecks = onDecks;
  check(out.playing && out.trackId === A.id && out.streamStopped, `chained failure at the boundary: the stream's end paused the track before the decks had it ${JSON.stringify(out)}`);
  check(out.onDecks, `chained failure at the boundary: B did not reach the decks ${JSON.stringify(out)}`);
  return out;
});

await scenario('seek shows buffering until audio flows', async () => {
  await fresh();
  const A = track('sb-a', 300);
  await store.getState().playQueue([A], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true });
  worklet.pos(tA, 40);
  await tick();
  const before = engine.getState().buffering;
  store.getState().seek(120);
  const during = engine.getState().buffering;
  const restart = main.starts.at(-1);
  // The new stream's first frames arrive: the worklet's first position report is the end of the wait.
  worklet.segment(restart.token, { first: true });
  const stillWaiting = engine.getState().buffering;
  worklet.pos(restart.token, 0.2);
  const after = engine.getState().buffering;
  // A seek while paused has nothing to wait for on screen.
  engine.pause();
  store.getState().seek(200);
  const pausedSeek = engine.getState().buffering;
  const out = { before, during, restartAt: restart.startAt, stillWaiting, after, pausedSeek };
  check(before === false && during === true, `seek: a seek into a stream that has not started is not buffering ${JSON.stringify(out)}`);
  check(restart.startAt === 120 && stillWaiting === true && after === false, `seek: buffering did not end with the first position report ${JSON.stringify(out)}`);
  check(pausedSeek === false, `seek: a seek while paused shows buffering ${JSON.stringify(out)}`);
  return out;
});

await scenario('decoder duration', async () => {
  await fresh();
  // No library duration and none from the start: the scrubber has nothing
  // and the prepare window can't open until the decoder's length arrives.
  main.startResult = (request) => ({ ok: true, durationSec: null, sourceSampleRate: 48000, resampler: 'none', resamplerKind: 'swr', request });
  const A = track('nodur', null);
  // The library has B at 300 s; its decoder finds 123.5.
  const B = track('nodur-next', 300);
  const C = track('nodur-last', 300);
  await store.getState().playQueue([A, B, C], 0);
  const tA = main.starts[0].token;
  worklet.segment(tA, { first: true, durationSec: null });
  worklet.pos(tA, 20);
  await tick();
  const before = store.getState().duration;
  worklet.emit({ t: 'dur', token: tA, durationSec: 240 });
  worklet.pos(tA, 20.5);
  await tick();
  const after = store.getState().duration;
  worklet.pos(tA, 235);
  await tick();
  const prepared = lastPrepare()?.next?.trackId === B.id;
  // A chained track's correction lands before it is audible and holds after.
  const tB = lastPrepare()?.next?.token;
  worklet.emit({ t: 'dur', token: tB, durationSec: 123.5 });
  worklet.segment(tB, { durationSec: null });
  await until(() => engine.getState().trackId === B.id, 2000, 'B acknowledged');
  worklet.pos(tB, 1);
  await tick();
  const chainedDuration = store.getState().duration;
  // B's prepare window opens off the decoder's length, not the library's.
  worklet.pos(tB, 118);
  await tick();
  const out = { before, after, prepared, chainedDuration, preparedAfterB: lastPrepare()?.next?.trackId === C.id };
  check(before === 0 && after === 240, `decoder duration: the scrubber did not take the decoder's length ${JSON.stringify(out)}`);
  check(prepared, `decoder duration: the next track was never prepared ${JSON.stringify(out)}`);
  check(out.chainedDuration === 123.5, `decoder duration: the chained track kept the library's length ${JSON.stringify(out)}`);
  check(out.preparedAfterB, `decoder duration: the prepare window followed the library's length ${JSON.stringify(out)}`);
  return out;
});

await scenario('session anchor', async () => {
  await fresh();
  // Web Audio output alone puts no session in the OS media controls; a
  // looping silent element has to play alongside the transport.
  const anchor = () => audios.find((a) => a.src.startsWith('blob:')) ?? null;
  const A = track('anchor-a', 300);
  const B = track('anchor-b', 300);
  const stream = { ...track('anchor-stream', 300), id: -901, path: 'https://radio.example/anchor.mp3' };
  await store.getState().playQueue([A, B], 0);
  worklet.segment(main.starts[0].token, { first: true });
  await tick();
  const el = anchor();
  const playingWithTransport = !!el && !el.paused;
  store.getState().togglePlay();
  await sleep(20);
  const pausedWithTransport = !!el && el.paused;
  store.getState().togglePlay();
  await sleep(20);
  const resumed = !!el && !el.paused;
  engine.stop();
  await sleep(20);
  const pausedOnStop = !!el && el.paused;
  await store.getState().playQueue([A, B], 0);
  worklet.segment(main.starts.at(-1).token, { first: true });
  await tick();
  const replayed = !!el && !el.paused && anchor() === el;
  // A practice loop moves the track to the decks, which hold the session.
  engine.setPracticeLoopActive(true);
  await sleep(30);
  const deckPlaying = decks().some((d) => !d.el.paused && d.el.src.includes('anchor-a'));
  const pausedOnHandoff = !!el && el.paused;
  engine.setPracticeLoopActive(false);
  // A stream never touches the transport: the anchor stays paused.
  await engine.play(stream.path, stream.id, 0);
  const pausedForStream = !!el && el.paused;
  const out = {
    created: !!el,
    volume: el?.volume ?? null,
    muted: el?.muted ?? null,
    loop: el?.loop ?? null,
    inGraph: !!el && graphSources.has(el),
    playingWithTransport,
    pausedWithTransport,
    resumed,
    pausedOnStop,
    replayed,
    deckPlaying,
    pausedOnHandoff,
    pausedForStream,
  };
  check(out.created && out.volume === 0 && out.muted === false && out.loop === true && !out.inGraph, `session anchor: element ${JSON.stringify(out)}`);
  check(out.playingWithTransport && out.pausedWithTransport && out.resumed && out.pausedOnStop && out.replayed, `session anchor: does not follow the transport ${JSON.stringify(out)}`);
  check(out.deckPlaying && out.pausedOnHandoff && out.pausedForStream, `session anchor: kept playing off the transport ${JSON.stringify(out)}`);
  return out;
});

// ---------------------------------------------------------------- the producer's 'wait'

/** A clock the page's timers run on, moved by hand. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const real = { setTimeout: win.setTimeout, clearTimeout: win.clearTimeout };
  win.setTimeout = (fn, ms = 0) => {
    const id = ++seq;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  win.clearTimeout = (id) => {
    timers.delete(id);
  };
  return {
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = target;
    },
    restore() {
      win.setTimeout = real.setTimeout;
      win.clearTimeout = real.clearTimeout;
    },
  };
}

/** A transport of its own, with its worklet and the events it raised. */
async function standalone() {
  const t = new SampleTransport();
  const events = [];
  t.setListener((event) => events.push(event));
  await t.attach(new FakeAudioContext(), new FakeNode());
  const node = nodes.at(-1);
  const startRequest = (trackId = 1) => ({ trackId, src: `/music/${trackId}.flac`, startAt: 0, gain: 1, playing: true });
  const emit = (message, gen = t.gen) => node.port.onmessage({ data: { gen, ...message } });
  const begin = async (durationSec = 300, trackId = 1) => {
    libraryDurations.set(trackId, durationSec);
    await t.start(startRequest(trackId));
    const token = main.starts.at(-1).token;
    emit({ t: 'segment', token, first: true, frame: 0, durationSec, sourceRate: 48000, resampler: 'none' });
    return token;
  };
  const dry = (token, seconds) => emit({ t: 'pos', token, segmentFrames: Math.round(seconds * 48000), frame: 0, playing: true, starving: true, underruns: 1, queued: 0 });
  const failed = () => events.filter((e) => e.type === 'failed');
  const buffering = () => events.filter((e) => e.type === 'buffering').map((e) => e.on);
  return { t, events, emit, begin, dry, failed, buffering };
}

await scenario('producer wait', async () => {
  await fresh();
  const clock = fakeClock();
  try {
    // Waiting on a read keeps the track for the long fallback, not 4 s.
    let h = await standalone();
    let token = await h.begin();
    h.dry(token, 20);
    h.emit({ t: 'wait', on: true });
    clock.advance(89_000);
    check(h.failed().length === 0, 'producer wait: the track was handed over while the producer was reading the file again');
    clock.advance(1_500);
    check(h.failed().length === 1 && /90 s/.test(h.failed()[0].message), `producer wait: the long fallback never came ${JSON.stringify(h.failed())}`);

    // The wait ending while the worklet is still dry puts the 4 s rule back.
    h = await standalone();
    token = await h.begin();
    h.dry(token, 20);
    h.emit({ t: 'wait', on: true });
    clock.advance(10_000);
    h.emit({ t: 'wait', on: false });
    clock.advance(3_900);
    check(h.failed().length === 0, 'producer wait: handed over before 4 s after the wait ended');
    clock.advance(200);
    check(h.failed().length === 1 && /4 s/.test(h.failed()[0].message), `producer wait: the 4 s fallback did not come back ${JSON.stringify(h.failed())}`);

    // A new start forgets the wait.
    h = await standalone();
    token = await h.begin();
    h.emit({ t: 'wait', on: true });
    token = await h.begin(300, 2);
    h.dry(token, 5);
    clock.advance(4_100);
    check(h.failed().length === 1, 'producer wait: a new start kept the old stream wait');

    // So does a seek.
    h = await standalone();
    token = await h.begin();
    h.emit({ t: 'wait', on: true });
    h.t.seek(100);
    await sleep(20);
    const seekedToken = main.starts.at(-1).token;
    h.emit({ t: 'segment', token: seekedToken, first: true, frame: 0, durationSec: 300, sourceRate: 48000, resampler: 'none' });
    h.dry(seekedToken, 1);
    clock.advance(4_100);
    check(h.failed().length === 1, 'producer wait: a seek kept the old stream wait');

    // A wait from a stream that has been replaced is ignored.
    h = await standalone();
    token = await h.begin();
    const oldGen = h.t.gen;
    token = await h.begin(300, 2);
    h.emit({ t: 'wait', on: true }, oldGen);
    h.dry(token, 5);
    clock.advance(4_100);
    check(h.failed().length === 1, 'producer wait: a wait from a replaced stream was taken');

    // Pausing while dry cancels the fallback.
    h = await standalone();
    token = await h.begin();
    h.dry(token, 20);
    h.emit({ t: 'wait', on: true });
    h.t.pause();
    clock.advance(200_000);
    check(h.failed().length === 0, 'producer wait: a paused stream was handed over');
    check(h.buffering().at(-1) === false, 'producer wait: pausing left the spinner on');

    // Dry at the end of a track that has played out is waiting for the next one.
    h = await standalone();
    token = await h.begin(60);
    h.dry(token, 60);
    clock.advance(4_100);
    check(h.failed().length === 0, 'producer wait: a track that played out was handed to the decks while the next opened');
    clock.advance(90_000);
    check(h.failed().length === 1, 'producer wait: nothing ever took over for a next track that never came');

    // A start while the last stream was dry doesn't turn the spinner off before audio flows.
    h = await standalone();
    token = await h.begin();
    h.dry(token, 20);
    const before = h.buffering().length;
    token = await h.begin(300, 2);
    check(h.buffering().length === before, `producer wait: a new start turned the spinner off ${JSON.stringify(h.buffering())}`);
    h.emit({ t: 'pos', token, segmentFrames: 4800, frame: 0, playing: true, starving: false, underruns: 1, queued: 100000 });
    check(h.buffering().at(-1) === false, 'producer wait: the spinner stayed on once audio flowed');
  } finally {
    clock.restore();
  }
});

await scenario('worklet drained', async () => {
  // The real process(), once the stream has ended, stops reporting.
  let frame = 0;
  Object.defineProperty(globalThis, 'currentFrame', { get: () => frame, configurable: true });
  globalThis.sampleRate = 48000;
  let Processor = null;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { onmessage: null, posted: [], postMessage(m) { this.posted.push(m); } };
    }
  };
  globalThis.registerProcessor = (_name, cls) => {
    Processor = cls;
  };
  new Function(readFileSync(resolve('src/audio/gapless-processor.js'), 'utf8'))();
  const processor = new Processor();
  const dataPort = { postMessage() {}, close() {} };
  processor.control({ t: 'data-port' }, [dataPort]);
  processor.control({ t: 'flush', gen: 1, playing: true });
  processor.receive({ t: 'seg', gen: 1, token: 1, durationSec: 1, gain: 1, sourceRate: 48000, resampler: 'none' });
  processor.receive({ t: 'pcm', gen: 1, pcm: new Float32Array(2 * 8192) });
  processor.receive({ t: 'end', gen: 1 });
  const quantum = () => {
    const out = [new Float32Array(128), new Float32Array(128)];
    processor.process([], [out]);
    frame += 128;
  };
  for (let i = 0; i < 80; i++) quantum();
  const drained = processor.port.posted.filter((m) => m.t === 'drained').length;
  const posted = processor.port.posted.length;
  for (let i = 0; i < 200; i++) quantum();
  const out = { drained, postedAfterDrain: processor.port.posted.length - posted };
  check(out.drained === 1, `worklet drained: told the engine ${out.drained} times`);
  check(out.postedAfterDrain === 0, `worklet drained: ${out.postedAfterDrain} messages after the end of the stream`);
  return out;
});

console.log(JSON.stringify(report, null, 2));
rmSync(root, { recursive: true, force: true });
if (failures.length) {
  console.error(`[gapless-client] FAIL\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.error('[gapless-client] PASS');
process.exit(0);
