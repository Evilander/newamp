// Tests for the Last.fm scrobble outbox's auth-failure handling
// (electron/lastfm.ts).
//
// Bug: isRetryableLastfmFailure() treated error code 9 ("Invalid session
// key") as retryable. flush() blocks the whole outbox behind the FIRST
// retryable failure to preserve scrobble ordering, so once a user's Last.fm
// session went bad, every future scrobble hit code 9, was marked
// retryable, and jammed the entire queue behind it forever — silently, with
// no way for the user to find out. Fix: codes 4/9/10 (auth failures) are
// terminal, not transient; flush() now surfaces a distinct needsReconnect
// state instead of quietly retrying forever, while genuinely transient
// failures (service down, rate limited) keep the original ordering-
// preserving block-and-retry behavior unchanged.
//
// Run: npm run build:electron && node scripts/lastfm-outbox-auth-test.mjs
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  LastfmScrobbleOutbox,
  LastfmApiError,
  shouldRetryLastfmError,
  isLastfmAuthFailure,
} from '../dist-electron/electron/lastfm.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
const RESULT = resolve(repoRoot, 'tmp/lastfm-outbox-auth-test-result.txt');
writeFileSync(RESULT, '[lastfm-outbox-auth-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const smokeRoot = join(repoRoot, 'tmp', 'lastfm-outbox-auth-test');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const track = (n) => ({ artist: `Artist ${n}`, title: `Track ${n}`, album: null, albumArtist: null, duration: 200, trackNumber: n });

// --- 1. Code 9 (invalid session key) is terminal and surfaces needsReconnect ---
{
  const outboxPath = join(smokeRoot, 'outbox-auth.json');
  const outbox = new LastfmScrobbleOutbox(outboxPath);
  await outbox.enqueue(track(1), 1000);
  await outbox.enqueue(track(2), 1001);
  await outbox.enqueue(track(3), 1002);

  let sendCalls = 0;
  const result = await outbox.flush(async () => {
    sendCalls += 1;
    throw new LastfmApiError('Invalid session key', { code: 9, status: 200 });
  });

  if (sendCalls !== 1) fail(`code-9 failure on item 1 should stop the flush immediately, got ${sendCalls} send() calls`);
  if (result.sent !== 0) fail(`expected 0 sent, got ${result.sent}`);
  if (result.remaining !== 3) fail(`expected all 3 items still queued, got ${result.remaining}`);
  if (result.needsReconnect !== true) fail('flush() result should report needsReconnect: true for a code-9 failure');

  const status = await outbox.status();
  if (status.pending !== 3) fail(`expected 3 pending after code-9 flush, got ${status.pending}`);
  if (status.needsReconnect !== true) fail('status() should report needsReconnect: true while a code-9 failure is queued');
  log.push(`code 9: sendCalls=${sendCalls} remaining=${result.remaining} needsReconnect=${result.needsReconnect}`);

  // --- 1b. Reconnecting (session now valid) drains the queue in order and clears needsReconnect ---
  const sentOrder = [];
  const result2 = await outbox.flush(async (item) => { sentOrder.push(item.track.title); });
  if (result2.sent !== 3) fail(`expected all 3 items to send after reconnect, got ${result2.sent}`);
  if (result2.remaining !== 0) fail(`expected an empty outbox after a successful flush, got ${result2.remaining}`);
  if (result2.needsReconnect !== false) fail('needsReconnect should clear once the queue drains successfully');
  if (JSON.stringify(sentOrder) !== JSON.stringify(['Track 1', 'Track 2', 'Track 3'])) {
    fail(`scrobble order must be preserved through the jam, got ${JSON.stringify(sentOrder)}`);
  }
  const status2 = await outbox.status();
  if (status2.pending !== 0 || status2.needsReconnect !== false) fail('status() should be clean after a full successful flush');
  log.push(`reconnect drains queue in order: ${JSON.stringify(sentOrder)}`);
}

// --- 2. A genuinely transient failure (service temporarily unavailable, code 16)
//        still blocks-and-retries the way it always did — this is intentional
//        (preserves scrobble ordering) and must not be affected by the auth fix. ---
{
  const outboxPath = join(smokeRoot, 'outbox-transient.json');
  const outbox = new LastfmScrobbleOutbox(outboxPath);
  await outbox.enqueue(track(1), 2000);
  await outbox.enqueue(track(2), 2001);

  let sendCalls = 0;
  const result = await outbox.flush(async () => {
    sendCalls += 1;
    throw new LastfmApiError('Service Offline', { code: 11, status: 200 });
  });
  if (sendCalls !== 1) fail(`transient failure should still block behind item 1, got ${sendCalls} send() calls`);
  if (result.remaining !== 2) fail(`expected both items still queued behind a transient failure, got ${result.remaining}`);
  if (result.needsReconnect !== false) fail('a transient (non-auth) failure must not report needsReconnect');
  log.push(`transient failure (code 11) still blocks the queue, needsReconnect=false: ok`);

  const result2 = await outbox.flush(async () => {});
  if (result2.sent !== 2 || result2.remaining !== 0) fail('transient outbox should drain once the service recovers');
}

// --- 3. A non-retryable, non-auth failure (e.g. malformed request) is dropped,
//        not blocking — unchanged pre-existing behavior. ---
{
  const outboxPath = join(smokeRoot, 'outbox-permanent.json');
  const outbox = new LastfmScrobbleOutbox(outboxPath);
  await outbox.enqueue(track(1), 3000);
  await outbox.enqueue(track(2), 3001);

  const sent = [];
  const result = await outbox.flush(async (item) => {
    if (item.track.title === 'Track 1') throw new LastfmApiError('Invalid parameters', { code: 6, status: 200 });
    sent.push(item.track.title);
  });
  if (result.remaining !== 0) fail(`a permanently-invalid item should be dropped, not block item 2, got remaining=${result.remaining}`);
  if (result.needsReconnect !== false) fail('a non-auth permanent failure must not report needsReconnect');
  if (!sent.includes('Track 2')) fail('item 2 should still be attempted after item 1 is dropped as non-retryable');
  log.push('non-auth permanent failure dropped without blocking later items: ok');
}

// --- An auth failure on the LIVE send path must preserve the play. Marking
// code 9 non-retryable is right for flush(), but the live scrobble handler
// decides whether to queue by asking the same question. If it only queues
// retryable errors, a dead session key means every scrobble is dropped, the
// outbox stays empty, and needsReconnect can never become true - silent,
// permanent loss that is worse than the queue jam this all started from. ---
{
  const authErr = new LastfmApiError('Invalid session key', { code: 9, status: 200 });
  const otherErr = new LastfmApiError('Invalid parameters', { code: 6, status: 200 });
  const transientErr = new LastfmApiError('Service Offline', { code: 11, status: 200 });

  if (shouldRetryLastfmError(authErr)) fail('code 9 should not be retryable');
  if (!isLastfmAuthFailure(authErr)) fail('code 9 should be recognised as an auth failure');
  if (isLastfmAuthFailure(otherErr)) fail('code 6 is not an auth failure');
  if (isLastfmAuthFailure(transientErr)) fail('code 11 is transient, not an auth failure');

  // the live handler's exact predicate
  const wouldQueue = (err) => shouldRetryLastfmError(err) || isLastfmAuthFailure(err);
  if (!wouldQueue(authErr)) fail('an auth failure must still be queued so the play is not lost');
  if (!wouldQueue(transientErr)) fail('a transient failure must still be queued');
  if (wouldQueue(otherErr)) fail('a permanently-invalid scrobble should still be dropped');

  // and once queued, the outbox reports that a reconnect is needed
  const outboxPath = join(smokeRoot, 'outbox-live-auth.json');
  const outbox = new LastfmScrobbleOutbox(outboxPath);
  await outbox.enqueue(track(9), 4000, 'Invalid session key');
  const status = await outbox.status();
  if (status.pending !== 1) fail(`the dropped-live scrobble should be queued, got pending=${status.pending}`);
  log.push('live-path auth failure is queued, not dropped: ok');
}

const report = log.join('\n') + '\n' + (pass ? '[lastfm-outbox-auth-test] PASS' : '[lastfm-outbox-auth-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
