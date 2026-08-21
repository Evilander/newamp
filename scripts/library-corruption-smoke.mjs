// Proves a page-corrupted library.db is quarantined at open instead of taking
// down the main process on first read. The failure this guards against shipped
// in 2.1.0: the header and schema of a corrupted DB still load cleanly, so the
// app started, then threw "database disk image is malformed" out of getStats()
// before the window was shown. The app never opened, and reinstalling did not
// help because the bad DB lives in userData.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'library-corruption-smoke');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

// 1. Build a real library with enough rows to span multiple btree pages.
{
  const store = await LibraryStore.open(dbPath);
  store.upsertTracks(
    Array.from({ length: 400 }, (_, i) => ({
      path: `Z:/music/artist-${i % 7}/album-${i % 13}/track-${i}.mp3`,
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
    })),
  );
  assert.equal(store.getStats().tracks, 400, 'seed library should hold 400 tracks');
  assert.equal(store.recoveryEvents.length, 0, 'a healthy library must not report recovery');
  store.close();
}

// A clean reopen must not trip the integrity probe.
{
  const store = await LibraryStore.open(dbPath);
  assert.equal(store.getStats().tracks, 400, 'clean reopen should preserve tracks');
  assert.equal(store.recoveryEvents.length, 0, 'clean reopen must not quarantine');
  store.close();
}

// 2. Corrupt interior btree pages while leaving the file header and schema
//    intact — this is what the real failure looked like on disk, and it is
//    exactly the case a plain open() + applySchema() does not catch.
const raw = readFileSync(dbPath);
const pageSize = raw.readUInt16BE(16) || 4096;
const pageCount = Math.floor(raw.length / pageSize);
assert.ok(pageCount > 8, `need a multi-page db to corrupt, got ${pageCount} pages`);
for (let page = 4; page < pageCount; page += 3) {
  raw.fill(0xa5, page * pageSize, page * pageSize + Math.min(pageSize, 512));
}
writeFileSync(dbPath, raw);

// The damage has to be real: the header still parses as SQLite.
assert.equal(raw.subarray(0, 15).toString('latin1'), 'SQLite format 3', 'header must survive');

// 3. Opening must recover rather than throw, and reads must not blow up.
const recoveredStore = await LibraryStore.open(dbPath);
assert.equal(recoveredStore.recoveryEvents.length, 1, 'corrupt library should record one recovery event');

const [event] = recoveredStore.recoveryEvents;
assert.equal(event.store, 'library', 'recovery event should be tagged as a library recovery');
assert.match(event.reason, /integrity check|malformed|corrupt/i, `unexpected reason: ${event.reason}`);
assert.ok(event.backupPath.includes('.corrupt-'), 'bad db should be quarantined alongside the original');
assert.ok(readFileSync(event.backupPath).length > 0, 'quarantined file must be kept, not discarded');

// A recovered library reads as empty so the app can rescan, and every read
// path stays callable — this is the assertion that would have caught 2.1.0.
assert.equal(recoveredStore.getStats().tracks, 0, 'recovered library should start empty');
assert.doesNotThrow(() => recoveredStore.getStats(), 'getStats must not throw after recovery');

// 4. It must survive a restart cleanly, with no second quarantine.
{
  const reopened = await LibraryStore.open(dbPath);
  assert.equal(reopened.recoveryEvents.length, 0, 'recovered library should reopen without recovering again');
  assert.equal(reopened.getStats().tracks, 0, 'reopened library should still read');
}

await rm(smokeRoot, { recursive: true, force: true });
console.log('library corruption smoke passed: corrupt db quarantined at open, reads stay safe');
