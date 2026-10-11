// Unit tests for electron/open-file-batcher.ts: files opened together reach
// the renderer as one batch, so selecting several files queues all of them.
// Run: node scripts/open-file-batcher-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/open-file-batcher-test-result.txt');
writeFileSync(RESULT, '[open-file-batcher-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/open-file-batcher.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/open-file-batcher-bundle.mjs'), logLevel: 'silent',
});
const { createOpenFileBatcher, mergeHandedOff } = await import(pathToFileURL(resolve('tmp/open-file-batcher-bundle.mjs')).href);

const log = [];
let pass = true;
const same = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  log.push(`${label}: ${a}`);
  if (a !== e) { pass = false; log.push(`FAIL: ${label} expected ${e}, got ${a}`); }
};

// A manual clock, so the timing cases do not depend on the machine.
function harness(options = {}) {
  let time = 0;
  let nextHandle = 1;
  const timers = new Map();
  const batches = [];
  const batcher = createOpenFileBatcher({
    quietMs: 400,
    maxWaitMs: 2000,
    deliver: (paths) => batches.push(paths),
    setTimer: (fn, ms) => { const handle = nextHandle++; timers.set(handle, { fn, at: time + ms }); return handle; },
    clearTimer: (handle) => { timers.delete(handle); },
    now: () => time,
    ...options,
  });
  const advance = (ms) => {
    const target = time + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    time = target;
  };
  return { batcher, batches, advance, pendingTimers: () => timers.size };
}

{
  const { batcher, batches, advance } = harness();
  for (let i = 1; i <= 5; i += 1) {
    batcher.push([`C:\\music\\${i}.flac`]);
    advance(20);
  }
  same('five events within 100 ms: nothing delivered yet', batches.length, 0);
  advance(500);
  same('five events within 100 ms become one batch of five, in order', batches,
    [[1, 2, 3, 4, 5].map((i) => `C:\\music\\${i}.flac`)]);
  advance(1000);
  batcher.push(['C:\\music\\6.flac']);
  advance(500);
  same('an event a second later starts a new batch', batches.slice(1), [['C:\\music\\6.flac']]);
}

{
  const { batcher, batches, advance } = harness();
  batcher.push(['a.mp3']);
  advance(300);
  batcher.push(['b.mp3']);
  advance(300);
  batcher.push(['c.mp3']);
  same('a gap shorter than the quiet period keeps the batch open', batches.length, 0);
  advance(400);
  same('delivered once the quiet period passes', batches, [['a.mp3', 'b.mp3', 'c.mp3']]);
}

{
  const { batcher, batches, advance } = harness();
  for (let i = 0; i < 12; i += 1) {
    batcher.push([`${i}.mp3`]);
    advance(300);
  }
  same('a steady trickle is delivered at the cap instead of waiting forever', batches.length >= 1 && batches[0].length <= 7, true);
  advance(1000);
  same('nothing is lost across the cap', batches.flat().length, 12);
}

{
  const { batcher, batches, advance } = harness();
  batcher.push(['A.mp3', 'b.mp3']);
  batcher.push(['a.MP3', 'c.mp3']);
  advance(500);
  same('the same file twice appears once (case-insensitive, first spelling kept)', batches, [['A.mp3', 'b.mp3', 'c.mp3']]);
}

{
  const { batcher, batches, advance, pendingTimers } = harness();
  batcher.push([]);
  same('an empty event schedules nothing', pendingTimers(), 0);
  batcher.push(['a.mp3']);
  batcher.push(['a.mp3']);
  advance(500);
  same('a repeated file does not grow the batch', batches, [['a.mp3']]);
}

{
  const { batcher, batches, advance } = harness();
  let settledAt = null;
  await batcher.settled();
  same('settled() with nothing waiting resolves at once', true, true);
  batcher.push(['a.mp3']);
  const waiting = batcher.settled().then(() => { settledAt = batches.length; });
  await Promise.resolve();
  same('settled() waits while a batch is open', settledAt, null);
  advance(500);
  await waiting;
  same('settled() resolves after the batch was delivered', settledAt, 1);
}

{
  const { batcher, batches, advance } = harness();
  batcher.push(['a.mp3']);
  let released = false;
  const waiting = batcher.settled().then(() => { released = true; });
  batcher.dispose();
  await waiting;
  advance(1000);
  same('dispose() drops the open batch and releases waiters', [batches.length, released], [0, true]);
}

// Cold start from Explorer: the renderer took the argv file and is playing it
// when the rest of the selection arrives as a batch.
{
  const WINDOW = 2000;
  const handedOff = { paths: ['C:\\music\\1.flac'], at: 10_000 };

  const merged = mergeHandedOff(['C:\\music\\2.flac', 'C:\\music\\3.flac'], handedOff, 10_600, WINDOW);
  same('a batch soon after the hand-off keeps the file the renderer already took, first',
    merged.files, ['C:\\music\\1.flac', 'C:\\music\\2.flac', 'C:\\music\\3.flac']);
  same('the hand-off keeps its original time', merged.handedOff?.at, 10_000);

  const second = mergeHandedOff(['C:\\music\\4.flac'], merged.handedOff, 11_500, WINDOW);
  same('a second batch inside the window still carries the whole selection',
    second.files, ['C:\\music\\1.flac', 'C:\\music\\2.flac', 'C:\\music\\3.flac', 'C:\\music\\4.flac']);

  const late = mergeHandedOff(['C:\\music\\5.flac'], second.handedOff, 12_001, WINDOW);
  same('past the window, a batch is only itself', late.files, ['C:\\music\\5.flac']);
  same('past the window, the hand-off is forgotten', late.handedOff, null);

  same('exactly at the edge of the window still merges',
    mergeHandedOff(['b.mp3'], { paths: ['a.mp3'], at: 0 }, 2000, WINDOW).files, ['a.mp3', 'b.mp3']);

  same('without a hand-off a batch passes through untouched',
    mergeHandedOff(['a.mp3', 'b.mp3'], null, 5, WINDOW), { files: ['a.mp3', 'b.mp3'], handedOff: null });

  same('a file in both lists appears once, in the hand-off position (case-insensitive)',
    mergeHandedOff(['C:\\Music\\1.FLAC', 'C:\\music\\2.flac'], handedOff, 10_100, WINDOW).files,
    ['C:\\music\\1.flac', 'C:\\music\\2.flac']);

  const input = ['x.mp3'];
  mergeHandedOff(input, { paths: ['y.mp3'], at: 0 }, 1, WINDOW);
  same('the batch passed in is not modified', input, ['x.mp3']);
}

const report = log.join('\n') + '\n' + (pass ? '[open-file-batcher-test] PASS' : '[open-file-batcher-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
