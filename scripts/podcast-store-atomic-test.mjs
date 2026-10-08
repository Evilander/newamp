// PodcastStore writes go through atomicWriteFileSync
// (a mutation is staged, persisted, and only then swapped into memory), and
// the constructor's load() treats a locked file as transient, not corruption
// — it retries with backoff, and if the lock never clears it runs the
// session on in-memory defaults without ever writing over the untouched
// original. Genuinely invalid JSON is still quarantined.
// Run: npm run build:electron && node scripts/podcast-store-atomic-test.mjs
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PodcastStore, parsePodcastFeed } from '../dist-electron/electron/podcasts.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'podcast-store-atomic-test');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

function feedXml(title = 'Long Drive') {
  return `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
    <channel>
      <title>Atomic Show</title>
      <item>
        <guid>same-guid</guid>
        <title>${title}</title>
        <itunes:duration>3600</itunes:duration>
        <enclosure url="https://cdn.example.com/long-drive.mp3" type="audio/mpeg" />
      </item>
    </channel>
  </rss>`;
}

function lockedError(code) {
  const err = new Error(`fixture ${code} lock`);
  err.code = code;
  return err;
}

const realReadFileSync = fs.readFileSync;
function patchRead(targetFile, code, failTimes) {
  let calls = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === targetFile) {
      calls += 1;
      if (calls <= failTimes) throw lockedError(code);
    }
    return realReadFileSync.call(fs, p, ...rest);
  };
  syncBuiltinESMExports();
}
function unpatchRead() {
  fs.readFileSync = realReadFileSync;
  syncBuiltinESMExports();
}

const realWriteSync = fs.writeSync;
function failNextWrite(code) {
  let fired = false;
  fs.writeSync = (...args) => {
    if (!fired) {
      fired = true;
      throw lockedError(code);
    }
    return realWriteSync.apply(fs, args);
  };
  syncBuiltinESMExports();
}
function unpatchWrite() {
  fs.writeSync = realWriteSync;
  syncBuiltinESMExports();
}

// 1. A write that fails mid-flight (ENOSPC after the temp file is opened,
//    the old writeFileSync-over-the-original bug this replaces) must leave
//    the last good file untouched and must NOT swap the failed mutation into
//    memory — the caller sees the error instead of a silently lost update.
//    Uses markDownloaded, not updateProgress: progress writes now debounce
//    (see podcast-progress-coalesce-test.mjs) and no longer write
//    synchronously at all — every other mutation still stages through
//    commit() and keeps this guarantee.
{
  const dir = join(smokeRoot, 'mid-write-enospc');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const store = new PodcastStore(file);
  const feedUrl = 'https://example.invalid/atomic-feed';
  const parsed = parsePodcastFeed(feedXml(), feedUrl, Date.parse('2026-05-15T08:00:00.000Z'));
  store.upsert(parsed.feed, parsed.episodes);
  const episode = store.listSubscriptions()[0].episodes[0];
  const original = readFileSync(file, 'utf8');

  failNextWrite('ENOSPC');
  try {
    assert.throws(
      () => store.markDownloaded({ feedUrl, episodeId: episode.id, downloadPath: join(dir, 'ep.mp3'), downloadBytes: 555 }),
      /ENOSPC|could not replace/,
      'a failed atomic write must surface to the caller instead of being swallowed',
    );
  } finally {
    unpatchWrite();
  }

  assert.equal(readFileSync(file, 'utf8'), original, 'a failed write must not truncate or overwrite the last good file');
  assert.equal(
    store.listSubscriptions()[0].episodes[0].downloadBytes,
    null,
    'in-memory state must not advance past a save that never landed on disk',
  );

  // A subsequent successful mutation still works normally afterward.
  const downloaded = store.markDownloaded({ feedUrl, episodeId: episode.id, downloadPath: join(dir, 'ep.mp3'), downloadBytes: 555 });
  assert.equal(downloaded?.downloadBytes, 555);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).subscriptions[0].episodes[0].downloadBytes, 555);
}

// 2. A locked read (EBUSY) that clears within the startup retry budget must
//    load the real subscriptions — no recovery event, nothing suppressed.
{
  const dir = join(smokeRoot, 'read-clears');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const feedUrl = 'https://example.invalid/clears-feed';
  const seedStore = new PodcastStore(file);
  const seeded = parsePodcastFeed(feedXml(), feedUrl, Date.now());
  seedStore.upsert(seeded.feed, seeded.episodes);
  const original = readFileSync(file, 'utf8');

  patchRead(file, 'EBUSY', 1);
  let store;
  try {
    store = new PodcastStore(file);
  } finally {
    unpatchRead();
  }
  assert.equal(store.recoveryEvents.length, 0, 'a lock that clears on retry is not a recovery event');
  assert.equal(store.listSubscriptions().length, 1, 'the real subscription must load once the lock clears');
  assert.equal(readFileSync(file, 'utf8'), original, 'the original must be untouched by the retry');
}

// 3. A locked read (EBUSY) that never clears — including through the first
//    mutation, so the self-heal retry in maybeRetrySuppressed() also fails —
//    must leave the original untouched, fall back to empty in-memory
//    subscriptions, record exactly one recovery event, and refuse to persist
//    any mutation: the store must never write over a file it never read.
{
  const dir = join(smokeRoot, 'read-stays-locked');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const feedUrl = 'https://example.invalid/locked-feed';
  const seedStore = new PodcastStore(file);
  const seeded = parsePodcastFeed(feedXml(), feedUrl, Date.now());
  seedStore.upsert(seeded.feed, seeded.episodes);
  const original = readFileSync(file, 'utf8');

  patchRead(file, 'EBUSY', 999);
  let store;
  try {
    store = new PodcastStore(file);
  } finally {
    unpatchRead();
  }
  assert.equal(store.recoveryEvents.length, 1, 'a lock that never clears must be recorded');
  assert.equal(store.recoveryEvents[0].store, 'podcasts');
  assert.match(store.recoveryEvents[0].reason, /EBUSY/);
  assert.equal(store.recoveryEvents[0].backupPath, file, 'nothing was quarantined — the original was never read');
  assert.equal(store.listSubscriptions().length, 0, 'an unreadable file must fall back to empty, not fabricate data');
  assert.equal(readFileSync(file, 'utf8'), original, 'the untouched original must survive a permanently locked read');

  // Subscribing while still locked (through the self-heal retry too) still
  // works in memory for this session…
  patchRead(file, 'EBUSY', 999);
  const other = parsePodcastFeed(feedXml('Suppressed Session'), 'https://example.invalid/other-feed', Date.now());
  try {
    store.upsert(other.feed, other.episodes);
  } finally {
    unpatchRead();
  }
  assert.equal(store.listSubscriptions().length, 1);
  assert.equal(store.recoveryEvents.length, 1, 'a failed self-heal attempt must not add a second recovery event');
  // …but must never reach disk, so the real file (with the real subscription
  // this session never saw) survives exactly as it was.
  assert.equal(readFileSync(file, 'utf8'), original, 'a suppressed store must never write over the untouched original');
}

// 4. Self-heal: still locked at boot, but the lock clears before the first
//    mutation — maybeRetrySuppressed() re-reads the real subscriptions
//    before upsert() computes its result, so the new subscription lands
//    alongside the real one instead of replacing it. Suppression lifts.
{
  const dir = join(smokeRoot, 'self-heal');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const realFeedUrl = 'https://example.invalid/real-feed';
  const seedStore = new PodcastStore(file);
  const seeded = parsePodcastFeed(feedXml('Real Session'), realFeedUrl, Date.now());
  seedStore.upsert(seeded.feed, seeded.episodes);
  const original = readFileSync(file, 'utf8');

  patchRead(file, 'EBUSY', 999);
  let store;
  try {
    store = new PodcastStore(file);
  } finally {
    unpatchRead();
  }
  assert.equal(store.isSuppressed(), true);
  assert.equal(store.listSubscriptions().length, 0, 'in-memory state must still be empty before the first mutation');

  // Read is NOT re-locked this time: the first mutation retries and succeeds.
  const other = parsePodcastFeed(feedXml('New Session'), 'https://example.invalid/new-feed', Date.now());
  store.upsert(other.feed, other.episodes);
  assert.equal(store.isSuppressed(), false, 'a mutation while the lock has cleared must lift suppression');
  const subscriptions = store.listSubscriptions();
  assert.equal(subscriptions.length, 2, 'the new subscription must land alongside the real one, not replace it');
  assert.ok(subscriptions.some((s) => s.feed.url === realFeedUrl), 'the real, pre-suppression subscription must survive');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.subscriptions.length, 2, 'the merged result must actually be persisted');
}

// 4b. Still locked at the first mutation and clear by a later one: mutations
//     try again, at most once every 10 seconds (progress updates arrive every
//     ~5 s during playback), and the session saves again once the real file
//     reads. Nothing is written before that read succeeds.
{
  const dir = join(smokeRoot, 'late-heal');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const realFeedUrl = 'https://example.invalid/late-real-feed';
  const seedStore = new PodcastStore(file);
  const seeded = parsePodcastFeed(feedXml('Real Session'), realFeedUrl, Date.now());
  seedStore.upsert(seeded.feed, seeded.episodes);
  const original = readFileSync(file, 'utf8');

  patchRead(file, 'EBUSY', 999);
  let store;
  try {
    store = new PodcastStore(file);
  } finally {
    unpatchRead();
  }
  assert.equal(store.isSuppressed(), true);

  let clock = 1_000_000;
  const ownNow = Object.getOwnPropertyDescriptor(performance, 'now');
  performance.now = () => clock;
  let locked = true;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === file) {
      reads += 1;
      if (locked) throw lockedError('EBUSY');
    }
    return realReadFileSync.call(fs, p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const early = parsePodcastFeed(feedXml('Early'), 'https://example.invalid/early-feed', Date.now());
    store.upsert(early.feed, early.episodes);
    assert.equal(store.isSuppressed(), true, 'still locked at the first mutation');

    locked = false;
    clock += 5_000;
    const readsBefore = reads;
    store.remove('https://example.invalid/early-feed');
    assert.equal(reads, readsBefore, 'inside the cooldown a mutation does not read the file again');
    assert.equal(realReadFileSync.call(fs, file, 'utf8'), original, 'nothing is written before a read of the real file succeeds');

    clock += 5_000;
    const later = parsePodcastFeed(feedXml('Later'), 'https://example.invalid/later-feed', Date.now());
    store.upsert(later.feed, later.episodes);
    assert.equal(store.isSuppressed(), false, 'a later mutation once the lock has cleared must lift suppression');
    const onDisk = JSON.parse(realReadFileSync.call(fs, file, 'utf8'));
    assert.deepEqual(
      onDisk.subscriptions.map((s) => s.feed.url).sort(),
      ['https://example.invalid/late-real-feed', 'https://example.invalid/later-feed'],
      'the real subscriptions survive and the session saves again',
    );
  } finally {
    if (ownNow) Object.defineProperty(performance, 'now', ownNow);
    else delete performance.now;
    unpatchRead();
  }
}

// 5. Genuinely corrupt JSON is still quarantined — the transient-I/O
//    carve-out above must not swallow real corruption.
{
  const dir = join(smokeRoot, 'corrupt');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  writeFileSync(file, '{"subscriptions": [truncated', 'utf8');
  const store = new PodcastStore(file);
  assert.equal(store.recoveryEvents.length, 1, 'unparseable podcasts.json should record one recovery event');
  assert.ok(store.recoveryEvents[0].backupPath.includes('.corrupt-'), 'bad file must be quarantined, kept as backup');
  assert.equal(store.listSubscriptions().length, 0);
}

await rm(smokeRoot, { recursive: true, force: true });
console.log('[podcast-store-atomic-test] PASS: atomic podcast persistence and locked-read handling verified');
