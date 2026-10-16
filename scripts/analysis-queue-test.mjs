// The library-wide analysis queue (electron/analysis-queue.ts) against stand-ins
// for the library, the analyzer, playback and the machine:
//  - order: the store's order, and a track the listener just started goes first
//  - restart: a second queue on the same store does only what the first left
//  - playback: nothing starts while playback is short of audio, a decode in
//    flight is stopped when it gets short, and the track is done once it is fed
//  - scans: nothing starts during a scan or in the cooldown after it
//  - battery, a busy machine, and the setting each hold or release it
//  - only fields a track lacks are asked for: tags stay, analysis written by an
//    older analyzer is redone, and a file that will not decode is not retried
// Run: node scripts/analysis-queue-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const entry = resolve('tmp/analysis-queue-test-entry.ts');
writeFileSync(entry, `export * from '../electron/analysis-queue';\nexport * from '../shared/analysis';\n`);
const outfile = resolve('tmp/analysis-queue-test-bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent' });
const {
  AnalysisQueue,
  AnalysisAbortedError,
  AnalysisUnavailableError,
  analysisWork,
  anyWork,
  mergeAnalysisRecord,
  parseAnalysisRecord,
} = await import(pathToFileURL(outfile).href);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await wait(2);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const FAST = { startDelayMs: 0, gapMs: 1, pollMs: 4, scanCooldownMs: 40, recheckMs: 60, flushEvery: 100, flushAfterMs: 10_000, countsMaxAgeMs: 0 };

// A library of tracks that owe everything, kept the way the real one keeps it.
class FakeStore {
  constructor(ids, order = ids) {
    this.order = order;
    this.rows = new Map(ids.map((id) => [id, { id, path: `/music/${id}.mp3`, bpm: null, key: null, rg: null, dnaVersion: null, analysisJson: null }]));
    this.saved = [];
  }
  rowState(row) {
    return { bpm: row.bpm, key: row.key, replayGainTrackDb: row.rg, dnaVersion: row.dnaVersion, analysisJson: row.analysisJson };
  }
  pendingAnalysisIds() {
    return this.order.filter((id) => anyWork(analysisWork(this.rowState(this.rows.get(id)))));
  }
  analysisTarget(id) {
    const row = this.rows.get(id);
    if (!row) return null;
    const work = analysisWork(this.rowState(row));
    return anyWork(work) ? { id, path: row.path, work } : null;
  }
  saveAnalysis(saves) {
    for (const save of saves) {
      const row = this.rows.get(save.id);
      row.analysisJson = mergeAnalysisRecord(row.analysisJson, save.touched, save.integratedLufs);
      if (save.bpm != null) row.bpm = save.bpm;
      if (save.key) row.key = save.key;
      if (save.replayGainTrackDb != null) row.rg = save.replayGainTrackDb;
      if (save.dna) row.dnaVersion = save.dna.v;
      this.saved.push(save);
    }
  }
  analysisCounts() {
    const rows = [...this.rows.values()];
    return {
      total: rows.length,
      owed: this.pendingAnalysisIds().length,
      coverage: {
        tempo: rows.filter((r) => r.bpm > 0).length,
        key: rows.filter((r) => r.key).length,
        loudness: rows.filter((r) => r.rg != null).length,
        dna: rows.filter((r) => r.dnaVersion != null).length,
      },
    };
  }
}

const DNA = { v: 1, framesAnalyzed: 10, secondsAnalyzed: 1, rms: 0.3, dynamicRange: 0.1, brightness: 0.4, flatness: 0.2, bands: [0.2, 0.2, 0.2, 0.2, 0.2], onsetDensity: 0.3, rolloff: 0.5 };

function okResult(request) {
  const { want } = request;
  return {
    seconds: 200,
    loudness: want.loud ? { integratedLufs: -12, replayGainTrackDb: -6 } : null,
    tempo: want.tempo ? { bpm: 120, key: 'Am' } : null,
    dna: want.dna ? DNA : null,
    peaksStored: false,
  };
}

function rig(store, overrides = {}) {
  const hunger = new Set();
  const state = { hungry: false, battery: false, load: { cpu: 0.1, lagMs: 0 }, enabled: true };
  const calls = [];
  const queue = new AnalysisQueue({
    store: () => store,
    analyze: overrides.analyze ?? (async (request) => {
      calls.push({ path: request.path, want: request.want });
      return okResult(request);
    }),
    isEnabled: () => state.enabled,
    playbackHungry: () => state.hungry,
    onPlaybackHunger: (listener) => {
      hunger.add(listener);
      return () => hunger.delete(listener);
    },
    load: () => state.load,
    onBattery: () => state.battery,
    peaksWanted: async () => false,
    timing: { ...FAST, ...overrides.timing },
    log: () => undefined,
  });
  const setHungry = (hungry) => {
    state.hungry = hungry;
    for (const listener of hunger) listener(hungry);
  };
  return { queue, state, calls, setHungry, hunger };
}

const idOf = (path) => Number(/(\d+)\.mp3$/.exec(path)[1]);

// 1. Order: the store's order, then the listener's pick goes to the front.
{
  const store = new FakeStore([10, 20, 30, 40, 50], [30, 10, 50, 20, 40]);
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = rig(store, {
    analyze: async (request) => {
      order.push(idOf(request.path));
      if (order.length === 1) await gate;
      return okResult(request);
    },
  });
  r.queue.start();
  await until(() => order.length === 1, 'the first track to start');
  assert.equal(order[0], 30, 'the store picks the first track');
  r.queue.prioritize([40, 30]);
  release();
  await until(() => order.length === 5, 'every track');
  assert.deepEqual(order, [30, 40, 10, 50, 20], 'the track just played jumps the line; the one running is not queued again');
  await r.queue.stop();
}

// 2. Restart: the second queue does only what the first left, and stop() writes what was finished.
{
  const store = new FakeStore([1, 2, 3, 4, 5, 6]);
  const first = [];
  let blockedOn = null;
  const r1 = rig(store, {
    analyze: async (request) => {
      const id = idOf(request.path);
      if (id === 4) {
        blockedOn = id;
        await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new AnalysisAbortedError())));
      }
      first.push(id);
      return okResult(request);
    },
  });
  r1.queue.start();
  await until(() => blockedOn === 4, 'the fourth track to be in flight');
  assert.equal(store.saved.length, 0, 'finished tracks wait for a batch (one library write per track would rewrite the file each time)');
  const stopping = r1.queue.stop();
  // Synchronously: the quit path closes the library right after calling stop() and does not wait for it.
  assert.deepEqual(store.saved.map((s) => s.id), [1, 2, 3], 'stop() writes the finished tracks before the library closes');
  await stopping;
  assert.deepEqual(first, [1, 2, 3]);
  assert.deepEqual(store.pendingAnalysisIds(), [4, 5, 6], 'the track cut off is still owed');

  const r2 = rig(store);
  r2.queue.start();
  await until(() => r2.calls.length === 3, 'the rest');
  assert.deepEqual(r2.calls.map((c) => idOf(c.path)), [4, 5, 6], 'a restart picks up where the last run stopped');
  await r2.queue.stop();
  assert.deepEqual(store.pendingAnalysisIds(), []);
  const done = store.rows.get(1);
  assert.deepEqual(parseAnalysisRecord(done.analysisJson), { loud: 1, bpm: 1, key: 1, dna: 1 }, 'each track records what was run, and at which version');
}

// 3. Playback first.
{
  const store = new FakeStore([1, 2, 3]);
  const r = rig(store);
  r.state.hungry = true;
  r.queue.start();
  await wait(60);
  assert.equal(r.calls.length, 0, 'nothing starts while playback is short of audio');
  assert.equal(r.queue.progress().waitingFor, 'playback');
  r.setHungry(false);
  await until(() => r.calls.length === 3, 'work to resume when playback is fed');
  await r.queue.stop();
}
{
  const store = new FakeStore([1, 2]);
  const started = [];
  let aborted = false;
  const r = rig(store, {
    analyze: async (request) => {
      started.push(idOf(request.path));
      if (started.length === 1) {
        await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new AnalysisAbortedError());
        }));
      }
      return okResult(request);
    },
  });
  r.queue.start();
  await until(() => started.length === 1, 'a decode to be running');
  r.state.hungry = true;
  r.setHungry(true);
  await until(() => aborted, 'the decode to be stopped when playback ran short');
  await wait(60);
  assert.deepEqual(started, [1], 'no new decode while playback is short of audio');
  assert.equal(store.saved.length, 0, 'the stopped track was not recorded as done or as failed');
  r.state.hungry = false;
  r.setHungry(false);
  await until(() => store.pendingAnalysisIds().length === 0, 'the stopped track to be done once playback is fed');
  assert.deepEqual(started, [1, 1, 2], 'the track that was cut off is tried again first');
  await r.queue.stop();
}

// 4. A scan comes first.
{
  const store = new FakeStore([1, 2]);
  const r = rig(store);
  r.queue.noteScan({ done: false });
  r.queue.start();
  await wait(60);
  assert.equal(r.calls.length, 0, 'nothing starts during a scan');
  assert.equal(r.queue.progress().waitingFor, 'scan');
  const endedAt = Date.now();
  r.queue.noteScan({ done: true });
  await wait(15);
  assert.equal(r.calls.length, 0, 'nor straight after it');
  await until(() => r.calls.length === 2, 'work to resume after the cooldown');
  assert.ok(Date.now() - endedAt >= FAST.scanCooldownMs - 5, 'it waited out the cooldown');
  await r.queue.stop();
}
{
  // A scan can add tracks: the queue looks at the library again when it ends.
  const store = new FakeStore([1]);
  const r = rig(store);
  r.queue.start();
  await until(() => r.calls.length === 1, 'the first track');
  r.queue.noteScan({ done: false });
  store.rows.set(2, { id: 2, path: '/music/2.mp3', bpm: null, key: null, rg: null, dnaVersion: null, analysisJson: null });
  store.order.push(2);
  r.queue.noteScan({ done: true });
  await until(() => r.calls.length === 2, 'the track the scan added');
  assert.equal(idOf(r.calls[1].path), 2);
  await r.queue.stop();
}

// 5. Battery, a busy machine, the setting.
{
  const store = new FakeStore([1]);
  const r = rig(store);
  r.state.battery = true;
  r.queue.start();
  await wait(40);
  assert.equal(r.calls.length, 0, 'nothing on battery power');
  assert.equal(r.queue.progress().waitingFor, 'battery');
  r.state.battery = false;
  r.state.load = { cpu: 0.95, lagMs: 0 };
  await wait(40);
  assert.equal(r.calls.length, 0, 'nothing while the machine is busy');
  assert.equal(r.queue.progress().waitingFor, 'busy');
  r.state.load = { cpu: 0.1, lagMs: 400 };
  await wait(40);
  assert.equal(r.calls.length, 0, 'nor while this app is lagging');
  r.state.load = { cpu: 0.1, lagMs: 0 };
  await until(() => r.calls.length === 1, 'work once the machine is quiet');
  await r.queue.stop();
}
{
  const store = new FakeStore([1]);
  const r = rig(store);
  r.state.enabled = false;
  r.queue.start();
  await wait(40);
  assert.equal(r.calls.length, 0, 'off means off');
  assert.equal(r.queue.progress().state, 'off');
  r.state.enabled = true;
  r.queue.refresh();
  await until(() => r.calls.length === 1, 'work after the setting goes on');
  await r.queue.stop();
}

// 6. Only what a track lacks.
{
  const store = new FakeStore([1, 2, 3]);
  // 1: a tempo and loudness from the file's own tags, no key. 2: a tempo of 0 (never set). 3: written by an older analyzer.
  Object.assign(store.rows.get(1), { bpm: 128, rg: -7.5, dnaVersion: 1, analysisJson: null });
  Object.assign(store.rows.get(2), { bpm: 0, rg: -3, dnaVersion: 1 });
  Object.assign(store.rows.get(3), { bpm: 90, key: 'C', rg: -4, dnaVersion: 1, analysisJson: JSON.stringify({ loud: 0, bpm: 0, key: 1, dna: 1 }) });
  const r = rig(store);
  r.queue.start();
  await until(() => r.calls.length === 3, 'every track');
  const wants = new Map(r.calls.map((c) => [idOf(c.path), c.want]));
  assert.deepEqual(wants.get(1), { loud: false, tempo: true, dna: false, peaks: false }, 'tags are not recomputed; the key is missing');
  assert.deepEqual(wants.get(2), { loud: false, tempo: true, dna: false, peaks: false }, 'a BPM of 0 is unknown, so it is worked out');
  assert.deepEqual(wants.get(3), { loud: true, tempo: true, dna: false, peaks: false }, 'values an older analyzer wrote are redone; the key it wrote at the current version is not');
  await r.queue.stop();
  assert.equal(store.rows.get(1).bpm, 128, 'the tag tempo is untouched');
  assert.equal(store.rows.get(1).key, 'Am');
  assert.equal(store.rows.get(2).bpm, 120, 'zero replaced by the analysed tempo');
  assert.equal(store.rows.get(3).key, 'C', 'a key already at the current version stays');
  const saved1 = store.saved.find((s) => s.id === 1);
  assert.equal(saved1.bpm, undefined, 'a field that was not asked for is not written');
}

// 7. A file that will not decode is not retried; an unreachable one is.
{
  const store = new FakeStore([1, 2, 3]);
  const tried = [];
  const r1 = rig(store, {
    analyze: async (request) => {
      const id = idOf(request.path);
      tried.push(id);
      if (id === 1) throw new Error('ffmpeg exited 1');
      if (id === 2) throw new AnalysisUnavailableError(request.path, new Error('ENOENT'));
      return okResult(request);
    },
  });
  r1.queue.start();
  await until(() => tried.length >= 3, 'all three');
  await r1.queue.stop();
  assert.deepEqual(store.pendingAnalysisIds(), [2], 'the broken file is marked tried; the unreachable one is still owed');
  const r2 = rig(store);
  r2.queue.start();
  await until(() => r2.calls.length === 1, 'the unreachable file, on the next run');
  assert.equal(idOf(r2.calls[0].path), 2);
  await r2.queue.stop();
}

// 8. Progress reads the store, and the estimate comes from the pace.
{
  const store = new FakeStore([1, 2, 3, 4]);
  const r = rig(store, { timing: { gapMs: 1 } });
  const before = r.queue.progress();
  assert.equal(before.total, 4);
  assert.equal(before.remaining, 4);
  r.queue.start();
  await until(() => store.pendingAnalysisIds().length === 0 || r.calls.length === 4, 'everything done');
  await r.queue.stop();
  const after = r.queue.progress();
  assert.equal(after.remaining, 0);
  assert.equal(after.done, 4);
  assert.equal(after.coverage.tempo, 4);
  assert.equal(after.coverage.key, 4);
  assert.equal(after.coverage.loudness, 4);
  assert.equal(after.coverage.dna, 4);
}

// 9. Files that cannot be read do not leave the queue "running" for ever, and a swapped library gets no results meant for the old one.
{
  const store = new FakeStore([1, 2]);
  const r = rig(store, {
    analyze: async (request) => {
      if (idOf(request.path) === 2) throw new AnalysisUnavailableError(request.path, new Error('gone'));
      return okResult(request);
    },
  });
  r.queue.start();
  await until(() => r.queue.progress().state === 'done', 'the queue to finish its pass');
  assert.equal(r.queue.progress().remaining, 1, 'the unreadable file is still counted as owed');
  await r.queue.stop();
}
{
  const store = new FakeStore([1]);
  let release;
  let started = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = rig(store, {
    analyze: async (request) => {
      started = true;
      await gate;
      return okResult(request);
    },
  });
  r.queue.start();
  await until(() => started, 'the analysis to be running');
  // The restored library holds other tracks: nothing of the old one is in it.
  store.rows.clear();
  store.order.length = 0;
  r.queue.reset();
  release();
  await wait(40);
  await r.queue.stop();
  assert.equal(store.saved.length, 0, 'a result that finished after the library was swapped is dropped');
}

console.log('[analysis-queue] PASS');
