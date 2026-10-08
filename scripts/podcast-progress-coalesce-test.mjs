// Tests PodcastStore's progress-write coalescing: playback calls
// updateProgress roughly every 5s; the fix debounces the actual disk write
// instead of doing a synchronous fsync'd atomic replace of the whole file on
// the main thread every call, while every other mutation (subscribe/
// unsubscribe/download) keeps its staged-commit guarantee (persist before
// swap, synchronous). A debounced write that is still in flight, or still
// retrying a locked file, must never land over a newer synchronous write.
// Run: npm run build:electron && node scripts/podcast-progress-coalesce-test.mjs
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import fsPromises, { mkdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PodcastStore, parsePodcastFeed } from '../dist-electron/electron/podcasts.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'podcast-progress-coalesce-test');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
    await sleep(10);
  }
}

// Fault injection at the fs boundary, for both the sync and async writers:
// the store reaches fs through named imports, which syncBuiltinESMExports
// re-points at whatever is patched here.
const realRenameSync = fs.renameSync;
const realRename = fsPromises.rename;
const realOpen = fsPromises.open;
function restoreFs() {
  fs.renameSync = realRenameSync;
  fsPromises.rename = realRename;
  fsPromises.open = realOpen;
  syncBuiltinESMExports();
}

// What antivirus or an indexer holding podcasts.json looks like on Windows:
// replacing it fails with EPERM until the hold is released.
function lockReplacesOf(target, isLocked, onAttempt) {
  const fail = (to) => {
    if (String(to) !== target || !isLocked()) return null;
    onAttempt();
    const err = new Error(`EPERM: operation not permitted, rename -> '${target}'`);
    err.code = 'EPERM';
    return err;
  };
  fs.renameSync = (from, to) => {
    const err = fail(to);
    if (err) throw err;
    return realRenameSync.call(fs, from, to);
  };
  fsPromises.rename = async (from, to) => {
    const err = fail(to);
    if (err) throw err;
    return realRename.call(fsPromises, from, to);
  };
  syncBuiltinESMExports();
}

// Holds the debounced writer's temp-file open until `gate` resolves, so a
// test can act while that write is in flight. The synchronous writers use
// openSync and are not held.
function holdAsyncTempWrites(target, gate, onHeld) {
  fsPromises.open = async (path, ...rest) => {
    if (String(path).startsWith(`${target}.tmp-`)) {
      onHeld();
      await gate;
    }
    return realOpen.call(fsPromises, path, ...rest);
  };
  syncBuiltinESMExports();
}

function feedXml(title = 'Coalesce Show') {
  return `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
    <channel>
      <title>${title}</title>
      <item>
        <guid>same-guid</guid>
        <title>Episode One</title>
        <itunes:duration>3600</itunes:duration>
        <enclosure url="https://cdn.example.com/episode.mp3" type="audio/mpeg" />
      </item>
    </channel>
  </rss>`;
}

// 1. Several rapid updateProgress() calls land in memory immediately but
//    coalesce into a single debounced write instead of one write per call.
{
  const dir = join(smokeRoot, 'coalesce');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const store = new PodcastStore(file);
  const feedUrl = 'https://example.invalid/coalesce-feed';
  const parsed = parsePodcastFeed(feedXml(), feedUrl, Date.now());
  store.upsert(parsed.feed, parsed.episodes);
  const episode = store.listSubscriptions()[0].episodes[0];
  const afterUpsert = readFileSync(file, 'utf8');

  for (const position of [10, 20, 30, 40, 50]) {
    store.updateProgress({ feedUrl, episodeId: episode.id, position, duration: 3600 });
    // Memory reflects the latest call immediately, every time.
    assert.equal(store.listSubscriptions()[0].episodes[0].progressSeconds, position);
  }
  // None of those five calls should have written synchronously — the file
  // must still read exactly what upsert() left it as.
  assert.equal(readFileSync(file, 'utf8'), afterUpsert, 'progress updates must not write synchronously on every call');

  await sleep(1000); // past the 800ms debounce
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.subscriptions[0].episodes[0].progressSeconds, 50, 'the debounced write must land the latest progress');
  const strays = readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(strays, [], 'the debounced write must clean up its own temp file');
}

// 2. A real mutation (markDownloaded) that lands while a progress write is
//    still pending must supersede it synchronously — staged-commit still
//    holds, and it includes the latest progress already applied in memory.
{
  const dir = join(smokeRoot, 'supersede');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const store = new PodcastStore(file);
  const feedUrl = 'https://example.invalid/supersede-feed';
  const parsed = parsePodcastFeed(feedXml(), feedUrl, Date.now());
  store.upsert(parsed.feed, parsed.episodes);
  const episode = store.listSubscriptions()[0].episodes[0];

  store.updateProgress({ feedUrl, episodeId: episode.id, position: 77, duration: 3600 }); // schedules, doesn't write yet
  store.markDownloaded({ feedUrl, episodeId: episode.id, downloadPath: join(dir, 'ep.mp3'), downloadBytes: 123 });
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.subscriptions[0].episodes[0].progressSeconds, 77, "commit()'s write must include the pending progress");
  assert.equal(onDisk.subscriptions[0].episodes[0].downloadBytes, 123);

  await sleep(1000); // the cancelled debounce must not fire a stale write later
  const stillOnDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stillOnDisk.subscriptions[0].episodes[0].progressSeconds, 77);
  assert.equal(stillOnDisk.subscriptions[0].episodes[0].downloadBytes, 123);
}

// 3. flushProgressSync() lands a pending debounced write immediately — the
//    quit path and the backup-snapshot path both rely on this.
{
  const dir = join(smokeRoot, 'flush');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const store = new PodcastStore(file);
  const feedUrl = 'https://example.invalid/flush-feed';
  const parsed = parsePodcastFeed(feedXml(), feedUrl, Date.now());
  store.upsert(parsed.feed, parsed.episodes);
  const episode = store.listSubscriptions()[0].episodes[0];

  store.updateProgress({ feedUrl, episodeId: episode.id, position: 99, duration: 3600 });
  const beforeFlush = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(beforeFlush.subscriptions[0].episodes[0].progressSeconds, 0, 'the write must not have landed yet');

  store.flushProgressSync();
  const afterFlush = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(afterFlush.subscriptions[0].episodes[0].progressSeconds, 99, 'flushProgressSync must land the pending write immediately');

  // A second flush with nothing dirty must be a no-op, not an extra write.
  const beforeSecond = readFileSync(file, 'utf8');
  store.flushProgressSync();
  assert.equal(readFileSync(file, 'utf8'), beforeSecond);
}

// 4. An unsubscribe that lands while the debounced progress write is still
//    retrying a locked podcasts.json is the newer state. Once the lock
//    clears, that older progress snapshot must not be put back over it: the
//    subscription would return on the next launch.
{
  const dir = join(smokeRoot, 'locked-replace');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const store = new PodcastStore(file);
  const feedUrl = 'https://example.invalid/locked-replace-feed';
  const parsed = parsePodcastFeed(feedXml(), feedUrl, Date.now());
  store.upsert(parsed.feed, parsed.episodes);
  const episode = store.listSubscriptions()[0].episodes[0];

  let locked = true;
  let attempts = 0;
  lockReplacesOf(file, () => locked, () => { attempts += 1; });
  try {
    store.updateProgress({ feedUrl, episodeId: episode.id, position: 120, duration: 3600 });
    await waitFor(() => attempts >= 2, 'the progress write has met the lock and is retrying');
    locked = false;
    store.remove(feedUrl);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).subscriptions.length, 0, 'the unsubscribe is on disk at once');
    await sleep(1500); // past every retry the progress write had left
  } finally {
    restoreFs();
  }
  assert.equal(store.listSubscriptions().length, 0);
  assert.equal(
    JSON.parse(readFileSync(file, 'utf8')).subscriptions.length,
    0,
    'the progress write must not put its older snapshot back over the unsubscribe',
  );
}

// 5. The restore path: main calls flushProgressSync() and then puts the
//    backup's podcasts.json in place. A progress write already in flight at
//    that moment has cleared its dirty flag but isn't on disk yet. The flush
//    has to land that progress itself and retire the in-flight write, or the
//    write lands afterwards and puts the old file back over the restored one.
{
  const dir = join(smokeRoot, 'flush-in-flight');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const store = new PodcastStore(file);
  const feedUrl = 'https://example.invalid/in-flight-feed';
  const parsed = parsePodcastFeed(feedXml(), feedUrl, Date.now());
  store.upsert(parsed.feed, parsed.episodes);
  const episode = store.listSubscriptions()[0].episodes[0];

  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  let held = false;
  holdAsyncTempWrites(file, gate, () => { held = true; });
  const restored = JSON.stringify({ subscriptions: [] }, null, 2);
  try {
    store.updateProgress({ feedUrl, episodeId: episode.id, position: 240, duration: 3600 });
    await waitFor(() => held, 'the debounced progress write is in flight');
    store.flushProgressSync();
    assert.equal(
      JSON.parse(readFileSync(file, 'utf8')).subscriptions[0].episodes[0].progressSeconds,
      240,
      'the flush must land the progress the in-flight write was carrying',
    );
    writeFileSync(file, restored); // what the restore puts in place
    release();
    await sleep(300);
  } finally {
    release();
    restoreFs();
  }
  assert.equal(readFileSync(file, 'utf8'), restored, 'the retired write must not land over the restored file');
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp')), [], 'and it cleans up its temp file');
}

await rm(smokeRoot, { recursive: true, force: true });
console.log('[podcast-progress-coalesce-test] PASS: podcast progress writes coalesce, other mutations still stage-commit');
