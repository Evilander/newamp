// Regression tests for the Last.fm scrobble outbox's read-modify-write race
// (electron/lastfm.ts).
//
// Bug: enqueue() and flush() each did their own list() -> mutate -> write()
// round trip against the outbox file. A scrobble that failed and was
// enqueue()d while an earlier flush() was still awaiting send() got dropped:
// flush() had already read its own snapshot before the enqueue happened, so
// when flush() finished it wrote that stale snapshot back and silently
// erased the new item. Fix: the outbox keeps one authoritative in-memory
// state array behind a promise-chain mutex; flush() snapshots the batch to
// send and releases the lock before the network wait, then reconciles
// against whatever the CURRENT state is (which may include items enqueued
// meanwhile) instead of overwriting it.
//
// Run: npm run build:electron && node scripts/lastfm-outbox-race-test.mjs
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { LastfmScrobbleOutbox } from '../dist-electron/electron/lastfm.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
const RESULT = resolve(repoRoot, 'tmp/lastfm-outbox-race-test-result.txt');
writeFileSync(RESULT, '[lastfm-outbox-race-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const smokeRoot = join(repoRoot, 'tmp', 'lastfm-outbox-race-test');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const track = (n) => ({ artist: `Artist ${n}`, title: `Track ${n}`, album: null, albumArtist: null, duration: 200, trackNumber: n });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// --- 1. An item enqueued while flush() is awaiting send() on an earlier
//        item must survive the flush, not be dropped by its stale write. ---
{
  const outboxPath = join(smokeRoot, 'outbox-mid-flush-enqueue.json');
  const outbox = new LastfmScrobbleOutbox(outboxPath);
  await outbox.enqueue(track('A'), 1000);
  await outbox.enqueue(track('B'), 1001);
  await outbox.enqueue(track('C'), 1002);

  const gate = deferred();
  const sentOrder = [];
  const flushPromise = outbox.flush(async (item) => {
    sentOrder.push(item.track.title);
    if (item.track.title === 'Track A') await gate.promise;
  });

  // Give flush() a tick to read its batch and start sending item A, then
  // enqueue a new item while it's still awaiting the gate.
  await new Promise((r) => setTimeout(r, 20));
  await outbox.enqueue(track('D'), 1003);
  gate.resolve();

  const result = await flushPromise;
  const finalItems = await outbox.list();
  const finalTitles = finalItems.map((i) => i.track.title);

  if (result.sent !== 3) fail(`expected all 3 pre-existing items to send, got sent=${result.sent}`);
  if (!finalTitles.includes('Track D')) {
    fail(`item D enqueued mid-flush was LOST — final outbox contents: ${JSON.stringify(finalTitles)}`);
  }
  if (finalTitles.length !== 1 || finalTitles[0] !== 'Track D') {
    fail(`expected only the mid-flush item left queued, got ${JSON.stringify(finalTitles)}`);
  }
  log.push(`mid-flush enqueue preserved: sent=${result.sent} finalOutbox=${JSON.stringify(finalTitles)}`);
}

// --- 2. Two flushes started concurrently must never send the same item
//        twice. ---
{
  const outboxPath = join(smokeRoot, 'outbox-concurrent-flush.json');
  const outbox = new LastfmScrobbleOutbox(outboxPath);
  await outbox.enqueue(track('X'), 2000);
  await outbox.enqueue(track('Y'), 2001);

  const sendCounts = new Map();
  const send = async (item) => {
    sendCounts.set(item.id, (sendCounts.get(item.id) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, 15));
  };

  const [resultA, resultB] = await Promise.all([outbox.flush(send), outbox.flush(send)]);
  const totalSent = resultA.sent + resultB.sent;
  const duplicated = [...sendCounts.values()].some((count) => count > 1);

  if (duplicated) fail(`an item was sent more than once across concurrent flushes: ${JSON.stringify([...sendCounts])}`);
  if (totalSent !== 2) fail(`expected exactly 2 total sends across both flushes, got ${totalSent}`);
  const finalStatus = await outbox.status();
  if (finalStatus.pending !== 0) fail(`expected an empty outbox after both flushes finish, got pending=${finalStatus.pending}`);
  log.push(`concurrent flushes: totalSent=${totalSent} duplicated=${duplicated}`);
}

// --- 3. One item fails: ordering, attempt count, and later-queued items
//        are preserved. ---
{
  const outboxPath = join(smokeRoot, 'outbox-ordering.json');
  const outbox = new LastfmScrobbleOutbox(outboxPath);
  await outbox.enqueue(track('1'), 3000);
  await outbox.enqueue(track('2'), 3001);
  await outbox.enqueue(track('3'), 3002);

  const attempted = [];
  const result = await outbox.flush(async (item) => {
    attempted.push(item.track.title);
    if (item.track.title === 'Track 2') throw new Error('temporary outage');
  });

  if (result.sent !== 1) fail(`expected only item 1 to send before the failure, got sent=${result.sent}`);
  if (!JSON.stringify(attempted).includes('Track 1') || attempted[attempted.length - 1] !== 'Track 2') {
    fail(`expected item 1 sent then item 2 attempted and blocked, got ${JSON.stringify(attempted)}`);
  }
  const items = await outbox.list();
  const titles = items.map((i) => i.track.title);
  if (JSON.stringify(titles) !== JSON.stringify(['Track 2', 'Track 3'])) {
    fail(`expected items 2 and 3 still queued in order, got ${JSON.stringify(titles)}`);
  }
  const failedItem = items.find((i) => i.track.title === 'Track 2');
  if (!failedItem || failedItem.attempts !== 1) fail(`expected item 2's attempt count to be 1, got ${failedItem?.attempts}`);
  const untouchedItem = items.find((i) => i.track.title === 'Track 3');
  if (!untouchedItem || untouchedItem.attempts !== 0) fail(`item 3 was never attempted, its attempt count must stay 0, got ${untouchedItem?.attempts}`);
  log.push(`ordering preserved behind a failure: queued=${JSON.stringify(titles)} item2attempts=${failedItem?.attempts}`);
}

// --- 4. A write failure must never corrupt or lose the prior valid outbox
//        file — the atomic tmp+rename write leaves the last good file
//        readable and complete if the rename/write step fails. ---
{
  const outboxDir = join(smokeRoot, 'outbox-write-failure');
  const outboxPath = join(outboxDir, 'scrobbles.json');
  await mkdir(outboxDir, { recursive: true });
  const outbox = new LastfmScrobbleOutbox(outboxPath);
  await outbox.enqueue(track('safe-1'), 4000);
  await outbox.enqueue(track('safe-2'), 4001);

  const before = await readFile(outboxPath, 'utf8');
  const beforeParsed = JSON.parse(before);
  if (beforeParsed.length !== 2) fail(`expected 2 items persisted before the induced failure, got ${beforeParsed.length}`);

  let writeFailed = false;
  try {
    await chmod(outboxDir, 0o444);
    await outbox.enqueue(track('will-fail'), 4002);
  } catch {
    writeFailed = true;
  } finally {
    await chmod(outboxDir, 0o755);
  }

  const after = await readFile(outboxPath, 'utf8');
  const afterParsed = JSON.parse(after);
  const afterTitles = afterParsed.map((i) => i.track.title);

  if (process.platform !== 'win32' && !writeFailed) {
    // On POSIX a read-only directory reliably blocks the temp-file write.
    // Windows directory permission bits don't reliably block writes for the
    // owning user, so this branch is only asserted off Windows; the file
    // integrity assertion below still runs everywhere.
    fail('expected the induced read-only-directory write to fail');
  }
  if (!afterTitles.includes('Track safe-1') || !afterTitles.includes('Track safe-2')) {
    fail(`prior valid outbox contents were lost after a failed write: ${JSON.stringify(afterTitles)}`);
  }
  log.push(`write-failure safety: writeFailed=${writeFailed} fileIntact=${JSON.stringify(afterTitles)}`);
}

const report = log.join('\n') + '\n' + (pass ? '[lastfm-outbox-race-test] PASS' : '[lastfm-outbox-race-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
