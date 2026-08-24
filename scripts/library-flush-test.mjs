// Tests for LibraryStore crash-safety:
//  - flushSync()/flushAsync() land library.db via tmp file + fsync + rename
//    (atomic replace), so the on-disk file is never a truncated partial write
//    and no .tmp-* siblings are left behind;
//  - open() only quarantines genuinely corrupt databases (bad header /
//    unparseable pages / failed integrity check) and treats an empty file as
//    fresh, never as corruption.
// Run: npm run build:electron && node scripts/library-flush-test.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'library-flush-test');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

function seedRows(prefix, count) {
  return Array.from({ length: count }, (_, i) => ({
    path: `${prefix}/artist-${i % 7}/album-${i % 13}/track-${i}.mp3`,
    title: `Track ${i} ${'pad'.repeat(20)}`,
    artist: `Artist ${i % 7}`,
    album: `Album ${i % 13}`,
    albumArtist: `Artist ${i % 7}`,
    trackNo: (i % 12) + 1,
    discNo: 1,
    year: 1990 + (i % 30),
    genre: `Genre ${i % 5}`,
    duration: 180 + i,
    bitrate: 320,
    sampleRate: 44100,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 5_000_000 + i,
    mtime: 1_700_000_000 + i,
    art: null,
  }));
}

const tmpSiblings = () => readdirSync(smokeRoot).filter((f) => f.includes('.tmp'));

// 1. The quit-path flushSync must land a complete, valid SQLite file atomically.
{
  const store = await LibraryStore.open(dbPath);
  store.upsertTracks(seedRows('Z:/music', 400));
  assert.equal(store.getStats().tracks, 400);
  store.close();

  const raw = readFileSync(dbPath);
  assert.equal(raw.subarray(0, 16).toString('latin1'), 'SQLite format 3\0', 'flushed db must have a valid SQLite header');
  assert.deepEqual(tmpSiblings(), [], 'no temp siblings may survive close()');
}

// 2. Reopening that file yields the full dataset with a clean integrity check.
{
  const store = await LibraryStore.open(dbPath);
  assert.equal(store.getStats().tracks, 400, 'atomically flushed db must reopen intact');
  assert.equal(store.recoveryEvents.length, 0, 'a healthy flushed db must not be quarantined');
  store.close();
}

// 3. An EMPTY db file is a fresh database, not corruption — opening it must
//    not quarantine (regression guard for the header check).
{
  const emptyPath = join(smokeRoot, 'empty-library.db');
  writeFileSync(emptyPath, Buffer.alloc(0));
  const store = await LibraryStore.open(emptyPath);
  assert.equal(store.recoveryEvents.length, 0, 'an empty db file must not be treated as corruption');
  assert.equal(store.getStats().tracks, 0);
  store.close();
}

// 4. A garbage file with NO SQLite header is real corruption: quarantined
//    exactly once, app continues on an in-memory database.
{
  const garbagePath = join(smokeRoot, 'garbage-library.db');
  writeFileSync(garbagePath, Buffer.from('this was a truncated in-place write, not a database', 'utf-8'));
  const store = await LibraryStore.open(garbagePath);
  try {
    assert.equal(store.recoveryEvents.length, 1, 'garbage db should record one recovery event');
    assert.match(store.recoveryEvents[0].reason, /corrupt/i);
    assert.ok(readFileSync(store.recoveryEvents[0].backupPath).length > 0, 'quarantined file must be kept');
    assert.equal(store.getStats().tracks, 0, 'recovered library should start empty');
  } finally {
    store.close();
  }
}

// 5. A TRUNCATED file whose header survived is also corruption (the exact
//    shape a crashed in-place write produced): header parses, pages don't.
{
  const truncatedPath = join(smokeRoot, 'truncated-library.db');
  const good = readFileSync(dbPath);
  writeFileSync(truncatedPath, good.subarray(0, Math.min(good.length, 4096)));
  const store = await LibraryStore.open(truncatedPath);
  try {
    assert.equal(store.recoveryEvents.length, 1, 'truncated db should record one recovery event');
    assert.equal(store.getStats().tracks, 0);
  } finally {
    store.close();
  }
}

await rm(smokeRoot, { recursive: true, force: true });
// A quit while an async flush is still writing must not corrupt the database.
// The two writers used to share one `.tmp-<pid>` path, so the synchronous
// write could truncate the inode the async write still held, rename it into
// place, and let the async bytes land inside the live library.db.
{
  const raceRoot = join(repoRoot, 'tmp', 'library-flush-race');
  await rm(raceRoot, { recursive: true, force: true });
  await mkdir(raceRoot, { recursive: true });
  const racePath = join(raceRoot, 'library.db');

  const store = new LibraryStore(racePath);
  await store.init();
  store.upsertTracks(seedRows('race-a', 400));

  // Start the async flush, then quit mid-write without awaiting it.
  const inFlight = store.flushAsync?.();
  store.upsertTracks(seedRows('race-b', 40));
  store.close();
  await Promise.resolve(inFlight).catch(() => {});
  await new Promise((r) => setTimeout(r, 250)); // let any stray threadpool write land

  const header = readFileSync(racePath).subarray(0, 16).toString('binary');
  assert.equal(header, 'SQLite format 3\0', 'a quit during an async flush must leave a valid database');
  const strays = readdirSync(raceRoot).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(strays, [], `no temp files should survive, found ${strays.join(', ')}`);

  // The two writers must not be able to pick the same temp path in the first
  // place - that is the property the race above can only sample.
  const librarySrc = readFileSync(join(repoRoot, 'electron', 'library.ts'), 'utf8');
  const settingsSrc = readFileSync(join(repoRoot, 'electron', 'settings.ts'), 'utf8');
  const recoverySrc = readFileSync(join(repoRoot, 'electron', 'recovery.ts'), 'utf8');
  assert.match(recoverySrc, /\.tmp-\$\{process\.pid\}-sync/, 'the synchronous writer needs its own temp suffix');
  for (const [name, src] of [['library', librarySrc], ['settings', settingsSrc]]) {
    assert.match(src, /\.tmp-\$\{process\.pid\}-\$\{seq\}/, `${name} async flush must use a per-flush temp path`);
    assert.doesNotMatch(src, /\.tmp-\$\{process\.pid\}`/, `${name} must not share the bare per-pid temp path`);
  }
  await rm(raceRoot, { recursive: true, force: true });
}

console.log('[library-flush-test] PASS: atomic flush verified, recovery classification verified, quit-during-flush safe');
