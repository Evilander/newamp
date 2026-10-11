// How the library watcher turns file system events into scans.
//  - An event with no file name (Windows reports one when a fast bulk copy
//    overflows its buffer) means "something changed under this root". It is
//    queued as an incremental root scan, never a forced one: forcing re-reads
//    every file of the library, cached or not.
//  - Events that name an audio file or folder art stay forced, so a file
//    rewritten in place is read again whatever its size and date say.
//  - A target asked for both ways is forced.
//  - While events keep arriving the debounce keeps restarting; a deadline
//    makes the watcher flush anyway, so a long copy is imported as it goes.
//  - Against the real file system: a burst of files from another process
//    reaches the callback with the root only ever in the incremental list.
//    Only Windows reports nameless overflow events, so on Linux and macOS that
//    section checks delivery and never sees the root swept.
//  - The scans main starts for those incremental targets are gated: one runs
//    at a time, and what is asked for while a slow one runs is a single batch
//    afterwards, however often it was asked.
// Run: npm run build:electron && node scripts/library-watch-plan-test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncrementalScanGate, LibraryWatcher } from '../dist-electron/electron/library-watcher.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-watch-plan-test');
await rm(root, { recursive: true, force: true });
await mkdir(join(root, 'Artist', 'Album'), { recursive: true });
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function waitFor(condition, what, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${what}`);
    await sleep(10);
  }
}
// A rename event stats its path before it queues anything; wait for that.
const renamesSettled = (watcher) => waitFor(() => watcher.pendingRenames.size === 0, 'rename events to settle');

function recorder(options = {}) {
  const batches = [];
  const watcher = new LibraryWatcher((targets, plan) => { batches.push({ targets, plan, at: performance.now() }); }, {
    debounceMs: 50,
    ...options,
  });
  // The handler fs.watch calls, driven directly so the events are exact.
  const emit = (eventType, fileName, recursive = true) =>
    watcher.onWatchEvent(root, recursive, watcher.generation, eventType, fileName);
  return { watcher, batches, emit };
}

// 1. The decision for each kind of event. The debounce is long here so only
// the explicit flushes below hand anything over.
{
  const { watcher, batches, emit } = recorder({ debounceMs: 60_000 });

  emit('rename', null);
  watcher.flushNow();
  assert.deepEqual(batches[0].plan, { force: [], incremental: [resolve(root)] }, 'a nameless event is an incremental root scan');
  assert.deepEqual(batches[0].targets, [resolve(root)]);

  emit('rename', '');
  watcher.flushNow();
  assert.deepEqual(batches[1].plan, { force: [], incremental: [resolve(root)] }, 'so is an empty name');

  emit('change', join('Artist', 'Album', '01 Song.mp3'));
  watcher.flushNow();
  assert.deepEqual(batches[2].plan, { force: [resolve(root, 'Artist', 'Album', '01 Song.mp3')], incremental: [] });

  emit('change', join('Artist', 'Album', 'cover.jpg'));
  watcher.flushNow();
  assert.deepEqual(batches[3].plan, { force: [resolve(root, 'Artist', 'Album')], incremental: [] }, 'folder art re-reads the folder');

  emit('change', 'notes.txt');
  emit('change', join('Artist', 'Album', 'booklet.pdf'));
  watcher.flushNow();
  assert.equal(batches.length, 4, 'other files queue nothing');

  // Mixed batch: the root stays incremental next to forced files.
  emit('rename', null);
  emit('change', join('Artist', 'Album', '02 Song.flac'));
  emit('change', join('Artist', 'Album', '03 Song.flac'));
  watcher.flushNow();
  assert.deepEqual(batches[4].plan.incremental, [resolve(root)]);
  assert.deepEqual(batches[4].plan.force, [
    resolve(root, 'Artist', 'Album', '02 Song.flac'),
    resolve(root, 'Artist', 'Album', '03 Song.flac'),
  ]);
  assert.deepEqual(batches[4].targets.length, 3);

  // A folder that appears or is renamed is an incremental scan of that folder...
  emit('rename', join('Artist', 'Album'));
  await renamesSettled(watcher);
  watcher.flushNow();
  assert.deepEqual(batches[5].plan, { force: [], incremental: [resolve(root, 'Artist', 'Album')] });

  // ...unless the same folder was also asked for because of its art.
  emit('change', join('Artist', 'Album', 'folder.png'));
  emit('rename', join('Artist', 'Album'));
  await renamesSettled(watcher);
  watcher.flushNow();
  assert.deepEqual(batches[6].plan, { force: [resolve(root, 'Artist', 'Album')], incremental: [] }, 'force wins');
  // And the other order.
  emit('rename', join('Artist', 'Album'));
  await renamesSettled(watcher);
  emit('change', join('Artist', 'Album', 'folder.png'));
  watcher.flushNow();
  assert.deepEqual(batches[7].plan, { force: [resolve(root, 'Artist', 'Album')], incremental: [] }, 'force wins either way');

  // A removed folder is queued for a look, not forced.
  emit('rename', join('Artist', 'Gone'));
  await renamesSettled(watcher);
  watcher.flushNow();
  assert.deepEqual(batches[8].plan, { force: [], incremental: [resolve(root, 'Artist', 'Gone')] });

  // Events from a watcher that has since been stopped are ignored.
  const staleGeneration = watcher.generation;
  watcher.stop();
  watcher.onWatchEvent(root, true, staleGeneration, 'rename', null);
  watcher.flushNow();
  assert.equal(batches.length, 9);
}

// 2. A deadline for the flush.
{
  // Events arrive every 25 ms, well inside the 100 ms debounce, so only the
  // deadline can flush before the burst ends. The burst runs five times the
  // deadline, which leaves a loaded machine room to be late.
  const { watcher, batches, emit } = recorder({ debounceMs: 100, maxWaitMs: 400 });
  const burstMs = 2000;
  const started = performance.now();
  let n = 0;
  const feed = setInterval(() => emit('change', `burst-${n++}.mp3`), 25);
  await sleep(burstMs);
  clearInterval(feed);
  const during = batches.filter((batch) => batch.at - started < burstMs);
  assert.ok(during.length >= 2, `flushed while events kept coming (${during.length} flushes)`);
  assert.ok(during[0].at - started < burstMs * 0.9, `first flush by the deadline, not after the burst (${Math.round(during[0].at - started)} ms)`);
  assert.ok(during[0].at - started >= 350, 'and not before the deadline');
  const names = new Set(batches.flatMap((batch) => batch.plan.force));
  await sleep(250);
  for (const batch of batches) assert.equal(batch.plan.incremental.length, 0);
  assert.ok(batches.flatMap((batch) => batch.plan.force).length >= n - 1, 'every event reached a flush');
  assert.ok(names.size > 0);
  watcher.stop();

  // Without a burst the debounce alone decides, as before.
  const quiet = recorder({ debounceMs: 100, maxWaitMs: 400 });
  const t0 = performance.now();
  quiet.emit('change', 'one.mp3');
  await waitFor(() => quiet.batches.length > 0, 'the debounce to flush');
  assert.ok(quiet.batches[0].at - t0 >= 90, 'the debounce waits before it flushes');
  await sleep(500);
  assert.equal(quiet.batches.length, 1, 'one change, one flush');
  quiet.watcher.stop();

  // The deadline never undercuts the debounce.
  const odd = new LibraryWatcher(() => {}, { debounceMs: 500, maxWaitMs: 10 });
  assert.equal(odd.maxWaitMs, 500);
}

// 3. The real thing: another process copying a burst of files.
{
  const watched = join(root, 'watched');
  await mkdir(join(watched, 'Bulk'), { recursive: true });
  const batches = [];
  const watcher = new LibraryWatcher((targets, plan) => { batches.push({ targets, plan }); }, { debounceMs: 150, maxWaitMs: 600 });
  watcher.start([watched]);
  await waitFor(() => watcher.watchedPathCount() >= (watcher.strategy === 'per-directory' ? 2 : 1), 'the watchers to be in place');
  const writer = spawn(process.execPath, [
    '-e',
    `const fs = require('fs'); const path = require('path');
     for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(${JSON.stringify(join(watched, 'Bulk'))}, 'track-' + i + '.mp3'), 'x'.repeat(2000));`,
  ], { stdio: 'ignore' });
  await new Promise((resolveExit) => writer.on('exit', resolveExit));
  await waitFor(() => batches.length >= 1, 'the burst to be flushed');
  await sleep(400);
  watcher.stop();

  assert.ok(batches.length >= 1, 'the burst reached the callback');
  const rootPath = resolve(watched);
  for (const { plan } of batches) {
    assert.ok(!plan.force.includes(rootPath), 'the root is never forced');
    for (const target of plan.force) assert.match(target, /\.mp3$|[\\/]Bulk$/, `forced: ${target}`);
  }
  const seen = new Set(batches.flatMap(({ plan }) => [...plan.force, ...plan.incremental]));
  assert.ok(seen.size > 1, 'files or their folder were reported');
  const nameless = batches.some(({ plan }) => plan.incremental.includes(rootPath));
  console.log(`  real burst: ${batches.length} flushes, ${seen.size} distinct targets, root swept: ${nameless}`);
}

// 4. Scans for incremental targets are gated. The stub stands for a root walk
// that outlasts several flush deadlines.
{
  const calls = [];
  let inFlight = 0;
  let overlapped = false;
  const releases = [];
  const gate = new IncrementalScanGate((targets) => {
    calls.push(targets);
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
    return new Promise((resolveScan, rejectScan) => {
      releases.push({
        finish: () => { inFlight -= 1; resolveScan(); },
        fail: (err) => { inFlight -= 1; rejectScan(err); },
      });
    });
  });
  const rootA = resolve(root, 'a');
  const rootB = resolve(root, 'b');

  gate.request([rootA]);
  assert.equal(calls.length, 1, 'the first ask starts a scan at once');
  assert.deepEqual(calls[0], [rootA]);

  // Five more flushes arrive while it walks, one of them naming another folder.
  for (let i = 0; i < 4; i++) gate.request([rootA]);
  gate.request([rootA, rootB]);
  await sleep(20);
  assert.equal(calls.length, 1, 'nothing else starts while it walks');

  releases[0].finish();
  await waitFor(() => calls.length === 2, 'the follow-up to start');
  assert.deepEqual([...calls[1]].sort(), [rootA, rootB].sort(), 'what was asked for meanwhile is one batch');
  gate.request([rootB]);
  gate.request([rootA]);
  releases[1].finish();
  await waitFor(() => calls.length === 3, 'the second follow-up to start');
  assert.deepEqual([...calls[2]].sort(), [rootA, rootB].sort());
  releases[2].finish();
  await sleep(30);
  assert.equal(calls.length, 3, 'no ask, no scan');
  assert.equal(overlapped, false, 'never two scans at once');

  // A failed scan does not wedge the gate, and what waited behind it still runs.
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    gate.request([rootA]);
    gate.request([rootB]);
    releases[3].fail(new Error('walk failed'));
    await waitFor(() => calls.length === 5, 'the batch behind a failed scan to start');
    assert.deepEqual(calls[4], [rootB]);
    releases[4].finish();
    await sleep(30);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /walk failed/);
  gate.request([rootA]);
  assert.equal(calls.length, 6, 'idle again after a failure');
  releases[5].finish();
  await sleep(30);
  assert.equal(overlapped, false);
}

await rm(root, { recursive: true, force: true });
console.log('[library-watch-plan-test] ok: nameless events scan incrementally, named ones stay forced, bursts flush by the deadline, incremental scans are gated');
