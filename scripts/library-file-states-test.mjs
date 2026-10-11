// getTrackFileStates answers the scanner once per batch of files. When a batch
// held a path the table did not have in that exact spelling it used to read
// the whole tracks table and throw it away: a first scan of a big library
// spent more than a third of its time on that, on every platform, including
// Linux where it can never match. Now:
//  - where names compare without case (Windows, macOS) a miss is answered
//    from the path map the store already keeps, then one query for the
//    spellings it names; the table is read whole at most once, to build that map;
//  - elsewhere a miss is simply a new file and costs nothing extra;
//  - a case variant of a stored path still finds its row where it should.
// Run: npm run build:electron && node scripts/library-file-states-test.mjs
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-file-states-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const foldsCase = process.platform === 'win32' || process.platform === 'darwin';
const base = process.platform === 'win32' ? 'D:\\Music' : '/music';
const sep = process.platform === 'win32' ? '\\' : '/';
const pathFor = (i) => `${base}${sep}Artist ${i % 200}${sep}Album ${i % 40}${sep}${String(i).padStart(5, '0')} Track.flac`;

const library = await LibraryStore.open(join(root, 'library.db'));
const TRACKS = 6000;
for (let start = 0; start < TRACKS; start += 500) {
  library.upsertTracks(
    Array.from({ length: Math.min(500, TRACKS - start) }, (_, k) => ({
      path: pathFor(start + k),
      title: `Track ${start + k}`,
      artist: 'A',
      album: 'B',
      albumArtist: 'A',
      trackNo: null,
      discNo: null,
      year: null,
      genre: null,
      duration: 1,
      bitrate: null,
      sampleRate: null,
      replayGainTrackDb: null,
      replayGainAlbumDb: null,
      size: 100 + start + k,
      mtime: 5,
      art: null,
    })),
  );
}

// Count the statements that read the table whole.
const statements = [];
const many = library.many.bind(library);
library.many = (sql, params) => {
  statements.push(sql);
  return many(sql, params);
};
const wholeTableReads = () =>
  statements.filter((sql) => /FROM tracks\s*$/i.test(sql.trim()) && !/WHERE/i.test(sql)).length;

// 1. A first-scan shaped run: every batch has a file the table does not know.
{
  let known = 0;
  for (let batch = 0; batch < 30; batch++) {
    const paths = Array.from({ length: 127 }, (_, k) => pathFor((batch * 127 + k) % TRACKS));
    paths.push(`${base}${sep}New${sep}new-${batch}.flac`);
    const states = library.getTrackFileStates(paths);
    known += states.size;
    assert.equal(states.has(paths[paths.length - 1]), false, 'a new file has no state');
    assert.equal(states.size, new Set(paths.slice(0, 127)).size);
  }
  assert.ok(known > 0);
  assert.ok(
    wholeTableReads() <= (foldsCase ? 1 : 0),
    `${wholeTableReads()} whole-table reads for 30 batches (${foldsCase ? 'the path map' : 'none'} expected)`,
  );
}

// 2. What a state carries.
{
  const [path] = [pathFor(42)];
  const state = library.getTrackFileStates([path]).get(path);
  assert.equal(state.path, path);
  assert.equal(state.size, 142);
  assert.equal(state.mtime, 5);
  assert.equal(state.codec, null, 'no codec on record yet');
  assert.equal(state.hasArt, 0);
}

// 3. Spelling.
{
  const path = pathFor(7);
  const variant = foldsCase ? path.toUpperCase() : path;
  const states = library.getTrackFileStates([variant]);
  if (foldsCase) {
    const state = states.get(variant);
    assert.ok(state, 'a case variant finds the stored row where names ignore case');
    assert.equal(state.path, variant, 'the state is filed under the path that was asked about');
    assert.equal(state.size, 107);
  }
  // Separators: a stored path matches the same path written with the other slash.
  const slashed = foldsCase ? path.replace(/\\/g, '/') : path;
  if (foldsCase) assert.equal(library.getTrackFileStates([slashed]).get(slashed)?.size, 107);
  if (!foldsCase) {
    const wrongCase = path.toUpperCase();
    assert.equal(library.getTrackFileStates([wrongCase]).size, 0, 'case matters here, so a case variant is another file');
  }

  // A path map that remembers a row which has since been deleted just misses.
  const doomed = pathFor(9);
  library.db.run('DELETE FROM tracks WHERE path = ?', [doomed]);
  assert.equal(library.getTrackFileStates([foldsCase ? doomed.toUpperCase() : doomed]).size, 0);
}

// 4. New rows are visible to the map straight away.
{
  const added = `${base}${sep}Fresh${sep}fresh.flac`;
  assert.equal(library.getTrackFileStates([added]).size, 0);
  library.upsertTracks([{
    path: added, title: 'Fresh', artist: 'A', album: 'B', albumArtist: 'A', trackNo: null, discNo: null, year: null, genre: null,
    duration: 1, bitrate: null, sampleRate: null, replayGainTrackDb: null, replayGainAlbumDb: null, size: 9, mtime: 1, art: null,
  }]);
  assert.equal(library.getTrackFileStates([added]).get(added)?.size, 9);
  if (foldsCase) assert.equal(library.getTrackFileStates([added.toLowerCase()]).get(added.toLowerCase())?.size, 9);
}

library.close();
await rm(root, { recursive: true, force: true });
console.log('[library-file-states-test] ok: a miss no longer reads the whole table');
