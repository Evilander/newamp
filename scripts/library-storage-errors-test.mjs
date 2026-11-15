// What library.ts does when the storage answers badly, and the library work
// that used to hold the main thread or give the wrong answer on a big library:
//  - a path whose stat fails for any reason but "not there" (a timeout, an I/O
//    error, no permission) is neither present nor gone: nothing is marked
//    missing for it and "Clean missing files" keeps the track as offline;
//  - the async marking and clean-up give the same answers as the sync ones, and
//    look again at the tracks they picked before they mark or delete them;
//  - a tmp copy left beside library.db by a dead write is swept on open, but a
//    newer whole copy, left by a replace that kept failing, is kept and reported;
//  - saves that keep failing are retried at the pace of the delay and reported;
//  - folders play in album order (numbers compared as numbers), singles by name,
//    each directory together, and a long folder is sorted once, not per page;
//  - searching "music" doesn't match every track through the library's own
//    folder, and accented paths match in either Unicode form;
//  - pages past the first ones are cut from one sorted id list;
//  - playlists: covers stored by name, counts that match the list, orphan
//    covers removed; deleting a list takes its items;
//  - setting the stars a track already shows keeps its finer score.
// Run: npm run build:electron && node scripts/library-storage-errors-test.mjs
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import fsp, { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LibraryStore, normalizePruneTargets, pathPresence, pathPresenceAsync, presenceOfError } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-storage-errors-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const base = {
  album: 'Album', albumArtist: 'Artist', trackNo: null, discNo: null, year: 2001, genre: 'Rock', duration: 100,
  bitrate: 320000, sampleRate: 44100, replayGainTrackDb: null, replayGainAlbumDb: null, size: 1, mtime: 1, art: null,
};
const incoming = (path, extra = {}) => ({ ...base, path, title: path.split('/').pop(), artist: 'Artist', ...extra });
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const canDenyAccess = process.platform !== 'win32' && !isRoot;

// ---- tri-state presence
const music = join(root, 'Music');
mkdirSync(join(music, 'Present'), { recursive: true });
writeFileSync(join(music, 'Present', 'here.mp3'), 'x');
writeFileSync(join(music, 'plain.txt'), 'x');
mkdirSync(join(music, 'Sub'), { recursive: true });
writeFileSync(join(music, 'Sub', 'keep.mp3'), 'x');
assert.equal(pathPresence(join(music, 'Present', 'here.mp3')), 'present');
assert.equal(pathPresence(join(music, 'Present', 'gone.mp3')), 'absent');
assert.equal(pathPresence(join(music, 'plain.txt', 'below-a-file')), 'absent', 'ENOTDIR counts as not there');
assert.equal(await pathPresenceAsync(join(music, 'Present', 'gone.mp3')), 'absent');
if (canDenyAccess) {
  const locked = join(music, 'Locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'a.mp3'), 'x');
  chmodSync(locked, 0o000);
  try {
    assert.equal(pathPresence(join(locked, 'a.mp3')), 'unknown', 'a refused stat is not "gone"');
    assert.equal(await pathPresenceAsync(join(locked, 'a.mp3')), 'unknown');
    const [target] = normalizePruneTargets([join(locked, 'a.mp3')]);
    assert.equal(target.exists, false);
    assert.equal(target.unknown, true, 'the target carries that it is unknown');
  } finally {
    chmodSync(locked, 0o755);
  }
}
// The permission case above only runs for a non-root POSIX user. What each error
// code is taken to mean is checked here for every platform: only "no such file"
// and "not a directory" are a file that is gone; a timeout, an I/O error, a
// refusal, a stale handle or a path the system will not parse is a question the
// storage did not answer.
for (const code of ['ENOENT', 'ENOTDIR']) assert.equal(presenceOfError({ code }), 'absent', `${code} is a file that is not there`);
for (const code of ['ETIMEDOUT', 'EIO', 'EPERM', 'EACCES', 'ESTALE', 'ENOTCONN', 'EBUSY', 'ELOOP', 'ENAMETOOLONG', 'EINVAL', 'UNKNOWN']) {
  assert.equal(presenceOfError({ code }), 'unknown', `${code} is not evidence that the file is gone`);
}
assert.equal(presenceOfError(new Error('no code')), 'unknown');
assert.equal(presenceOfError(null), 'unknown');

// ---- marking missing, sync and async
const library = await LibraryStore.open(join(root, 'library.db'));
library.upsertTracks([
  incoming(join(music, 'Present', 'here.mp3')),
  incoming(join(music, 'Present', 'gone.mp3')),
  incoming(join(music, 'Sub', 'Vanished', 'old.mp3')),
  ...(canDenyAccess ? [incoming(join(music, 'Locked', 'a.mp3'))] : []),
]);
const missingPaths = () => library.getTracks({ limit: 100 }).filter((track) => track.missingSince).map((track) => basename(track.path)).sort();
const targets = [join(music, 'Present'), join(music, 'Sub', 'Vanished'), ...(canDenyAccess ? [join(music, 'Locked')] : [])];
if (canDenyAccess) chmodSync(join(music, 'Locked'), 0o000);
try {
  const marked = await library.markTracksMissingAsync(targets);
  assert.equal(marked, 2, 'the vanished folder and the one deleted file are marked; the locked folder is not');
  assert.deepEqual(missingPaths(), ['gone.mp3', 'old.mp3']);
} finally {
  if (canDenyAccess) chmodSync(join(music, 'Locked'), 0o755);
}
assert.equal(library.markTracksMissing(targets), 0, 'the sync form agrees and finds nothing new');
// A file handed over as a root that the walk already found costs no stat and adds nothing.
assert.equal(library.markUnfoundTracksMissing([join(music, 'Present', 'here.mp3')], [join(music, 'Present', 'here.mp3')]), 0);

// ---- clean missing files: tri-state, sync and async agree
const roots = [music];
const syncPreview = library.previewPruneMissingTracks(undefined, roots);
const asyncPreview = await library.previewPruneMissingTracksAsync(undefined, roots);
assert.deepEqual(asyncPreview, syncPreview, 'the sliced preview counts what the sync one does');
assert.equal(asyncPreview.tracks, 2, 'the deleted file and the vanished folder are proven gone');
if (canDenyAccess) {
  // The sweep just made is kept for the removal that follows; any write ends that.
  library.toggleLove(library.getTracks({ limit: 1 })[0].id);
  chmodSync(join(music, 'Locked'), 0o000);
  try {
    const locked = await library.previewPruneMissingTracksAsync(undefined, roots);
    assert.equal(locked.tracks, 2, 'a track in a folder that will not answer is kept');
    assert.ok(locked.offline >= 1, 'and counted as offline');
    assert.deepEqual(library.previewPruneMissingTracks(undefined, roots).tracks, 2, 'the sync preview keeps it too');
  } finally {
    chmodSync(join(music, 'Locked'), 0o755);
  }
}
const pruned = await library.pruneMissingTracksAsync(undefined, roots);
assert.equal(pruned.removed, 2);
assert.deepEqual(library.getTracks({ limit: 100 }).map((track) => basename(track.path)).sort(), canDenyAccess ? ['a.mp3', 'here.mp3'] : ['here.mp3']);
library.close();

// ---- a stale tmp copy is swept on open, a fresh one is not
const tmpDir = join(root, 'sweep');
await mkdir(tmpDir, { recursive: true });
{
  const first = await LibraryStore.open(join(tmpDir, 'library.db'));
  first.upsertTracks([incoming('/m/one.mp3')]);
  first.close();
  const stale = join(tmpDir, 'library.db.tmp-99999-3');
  const fresh = join(tmpDir, 'library.db.tmp-99999-4');
  writeFileSync(stale, 'old');
  writeFileSync(fresh, 'new');
  const longAgo = new Date(Date.now() - 10 * 60_000);
  utimesSync(stale, longAgo, longAgo);
  const second = await LibraryStore.open(join(tmpDir, 'library.db'));
  for (let i = 0; i < 40 && existsSync(stale); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(existsSync(stale), false, 'the stale tmp copy is removed');
  assert.equal(existsSync(fresh), true, 'a recent one may belong to a write in progress');
  second.close();
}

// ---- a newer copy left by a replace that kept failing is put in place, not swept
{
  const dir = join(root, 'unsaved');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'library.db');
  const first = await LibraryStore.open(file);
  first.upsertTracks([incoming('/m/one.mp3')]);
  first.close();
  const oneTrack = readFileSync(file);
  // What an earlier session had in memory when it could not replace library.db: one more track.
  const later = await LibraryStore.open(join(dir, 'later.db'));
  later.upsertTracks([incoming('/m/one.mp3'), incoming('/m/two.mp3')]);
  const twoTracks = Buffer.from(later.exportSnapshot());
  later.close();
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);
  const place = (folder, name, bytes, minutesAgo) => {
    const path = join(folder, name);
    writeFileSync(path, bytes);
    utimesSync(path, at(minutesAgo), at(minutesAgo));
    return path;
  };
  const siblings = (folder, start) => readdirSync(folder).filter((name) => name.startsWith(start));
  utimesSync(file, at(60), at(60));
  const newest = place(dir, 'library.db.tmp-4242-sync', twoTracks, 10);
  const sameProcess = place(dir, 'library.db.tmp-4242-5', oneTrack, 20);
  const otherProcess = place(dir, 'library.db.tmp-4245-2', oneTrack, 15);
  const cutOff = place(dir, 'library.db.tmp-4243-7', twoTracks.subarray(0, 5000), 10);
  const older = place(dir, 'library.db.tmp-4244-3', twoTracks, 120);
  const second = await LibraryStore.open(file);
  assert.equal(second.getTrackCount(), 2, 'the newest whole copy is the library that opens');
  for (const gone of [newest, sameProcess, cutOff, older]) assert.equal(existsSync(gone), false, `${gone} is gone`);
  assert.deepEqual(siblings(dir, 'library.db.tmp-'), [], 'no temp copy is left to be swept later');
  const replaced = siblings(dir, 'library.db.replaced-');
  assert.equal(replaced.length, 1, 'the library.db it replaced is kept');
  assert.deepEqual(readFileSync(join(dir, replaced[0])), oneTrack);
  const unsaved = siblings(dir, 'library.db.unsaved-');
  assert.equal(unsaved.length, 1, 'a whole copy from another process is kept under its own name');
  assert.match(unsaved[0], /^library\.db\.unsaved-4245-/);
  assert.equal(second.recoveryEvents.length, 2);
  assert.deepEqual(second.recoveryEvents.map((event) => event.backupPath), [join(dir, replaced[0]), join(dir, unsaved[0])], 'each notice says where the file it concerns is');
  second.close();
  const again = await LibraryStore.open(file);
  assert.equal(again.getTrackCount(), 2, 'and the next launch finds the same library');
  assert.equal(again.recoveryEvents.length, 0, 'with nothing more to say');
  again.close();

  // A library.db that fails its integrity check is moved aside, as before; the copy the
  // failed replace left is the library there is, so it is put in place, not left behind.
  const brokenDir = join(dir, 'broken');
  await mkdir(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, 'library.db'), 'this is not a database');
  const copy = place(brokenDir, 'library.db.tmp-4242-sync', twoTracks, 10);
  const begun = await LibraryStore.open(join(brokenDir, 'library.db'));
  assert.equal(begun.getTrackCount(), 2);
  assert.equal(existsSync(copy), false);
  assert.equal(siblings(brokenDir, 'library.db.corrupt-').length, 1, 'the unreadable file is kept aside');
  assert.equal(begun.recoveryEvents.length, 2, 'and both steps are reported');
  begun.close();

  // No library.db at all, and a whole copy beside where it was.
  const goneDir = join(dir, 'gone');
  await mkdir(goneDir, { recursive: true });
  place(goneDir, 'library.db.tmp-4242-sync', twoTracks, 10);
  const restored = await LibraryStore.open(join(goneDir, 'library.db'));
  assert.equal(restored.getTrackCount(), 2);
  assert.match(restored.recoveryEvents[0].reason, /missing/);
  restored.close();

  // The whole sequence, with real failures: a flush writes its temp copy, the replace of
  // library.db is refused, the app quits, and starts again.
  const lockedDir = join(dir, 'locked');
  await mkdir(lockedDir, { recursive: true });
  const lockedFile = join(lockedDir, 'library.db');
  const session = await LibraryStore.open(lockedFile);
  session.upsertTracks([incoming('/m/one.mp3')]);
  await session.albumsReady?.();
  await session.flushPendingWrites();
  const before = readFileSync(lockedFile);
  await rm(lockedFile);
  await mkdir(lockedFile);
  session.upsertTracks([incoming('/m/two.mp3'), incoming('/m/three.mp3')]);
  await session.flushAsync();
  assert.equal(session.dirty, true, 'the replace was refused');
  assert.throws(() => session.close(), /complete copy/, 'and so is the one at quit');
  // The process would be gone; the retry the failed quit-time save armed must not run in this one.
  clearTimeout(session.persistTimer);
  const leftovers = siblings(lockedDir, 'library.db.tmp-');
  assert.ok(leftovers.length >= 1, 'the failed saves left their copies');
  await rm(lockedFile, { recursive: true });
  writeFileSync(lockedFile, before);
  utimesSync(lockedFile, at(60), at(60));
  leftovers.forEach((name, index) => utimesSync(join(lockedDir, name), at(10 - index), at(10 - index)));
  const started = await LibraryStore.open(lockedFile);
  assert.equal(started.getTrackCount(), 3, 'the next start has everything the last session had');
  assert.deepEqual(siblings(lockedDir, 'library.db.tmp-'), []);
  assert.equal(siblings(lockedDir, 'library.db.replaced-').length, 1);
  started.close();
}

// ---- clean missing files: a file that came back since the sweep is not deleted
{
  const lib = await LibraryStore.open(join(root, 'recheck.db'));
  const folder = join(root, 'Recheck', 'Album');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'stays.mp3'), 'x');
  lib.upsertTracks([incoming(join(folder, 'stays.mp3')), incoming(join(folder, 'back.mp3')), incoming(join(folder, 'gone.mp3'))]);
  const sweepRoots = [join(root, 'Recheck')];
  const preview = await lib.previewPruneMissingTracksAsync(undefined, sweepRoots);
  assert.equal(preview.tracks, 2, 'both missing files are proven gone when the sweep is made');
  // The removal that follows the preview reuses its sweep; the file returns before it.
  writeFileSync(join(folder, 'back.mp3'), 'x');
  const result = await lib.pruneMissingTracksAsync(undefined, sweepRoots);
  assert.equal(result.removed, 1, 'only the file that is still gone is removed');
  assert.deepEqual(lib.getTracks({ limit: 10 }).map((track) => basename(track.path)).sort(), ['back.mp3', 'stays.mp3']);
  lib.close();
}

// ---- marking missing: the tracks picked are looked at again before they are marked
{
  const lib = await LibraryStore.open(join(root, 'mark.db'));
  const folder = join(root, 'Mark', 'Album');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'stays.mp3'), 'x');
  lib.upsertTracks([incoming(join(folder, 'stays.mp3')), incoming(join(folder, 'flicker.mp3')), incoming(join(folder, 'gone.mp3'))]);
  // flicker.mp3 is not there when the folder is first looked at and is back for the second look.
  const realReaddir = fsp.readdir;
  let looks = 0;
  fsp.readdir = async (path, ...rest) => {
    if (path === folder) {
      looks += 1;
      if (looks === 2) writeFileSync(join(folder, 'flicker.mp3'), 'x');
    }
    return realReaddir(path, ...rest);
  };
  let marked;
  try {
    marked = await lib.markTracksMissingAsync([folder]);
  } finally {
    fsp.readdir = realReaddir;
  }
  assert.equal(looks, 2, 'the folder is looked at again before anything is marked');
  assert.equal(marked, 1, 'only the file that is still gone is marked');
  assert.deepEqual(lib.getTracks({ limit: 10 }).filter((track) => track.missingSince).map((track) => basename(track.path)), ['gone.mp3']);

  // A store closed while the checks were under way marks nothing and does not throw.
  const closing = join(root, 'Mark', 'Closing');
  mkdirSync(closing, { recursive: true });
  lib.upsertTracks([incoming(join(closing, 'missing.mp3'))]);
  fsp.readdir = async (path, ...rest) => {
    if (path === closing) lib.close();
    return realReaddir(path, ...rest);
  };
  try {
    assert.equal(await lib.markTracksMissingAsync([closing]), 0);
  } finally {
    fsp.readdir = realReaddir;
  }
}

// ---- marking what a scan did not find, async: the same answers as the sync form, and careful
{
  const setup = async (name) => {
    const home = join(root, `Unfound-${name}`);
    const music = join(home, 'Music');
    const lib = await LibraryStore.open(join(home, 'library.db'));
    const tracks = [];
    for (const folder of ['A', 'B', 'C']) {
      mkdirSync(join(music, folder), { recursive: true });
      writeFileSync(join(music, folder, 'keep.mp3'), 'x');
      tracks.push(incoming(join(music, folder, 'keep.mp3')), incoming(join(music, folder, 'missing.mp3')));
    }
    lib.upsertTracks(tracks);
    const found = ['A', 'B', 'C'].map((folder) => join(music, folder, 'keep.mp3'));
    const missing = () => lib.getTracks({ limit: 100 }).filter((track) => track.missingSince).map((track) => basename(track.path));
    return { home, music, lib, found, missing };
  };

  // Same filtering as the sync form: a file in a folder the walk could not list is left
  // alone, a path the scanner skips is marked without a stat, a folder that is gone marks its files.
  {
    const results = [];
    for (const form of ['sync', 'async']) {
      const { music, lib, found, missing } = await setup(`same-${form}`);
      mkdirSync(join(music, 'Unlisted'), { recursive: true });
      lib.upsertTracks([
        incoming(join(music, 'Unlisted', 'x.mp3')),
        incoming(join(music, 'Vanished', 'old.mp3')),
        incoming(join(music, 'A', '._stub.mp3')),
      ]);
      const args = [[music], found, [join(music, 'Unlisted')]];
      const marked = form === 'sync' ? lib.markUnfoundTracksMissing(...args) : await lib.markUnfoundTracksMissingAsync(...args);
      results.push({ marked, missing: missing().sort() });
      lib.close();
    }
    assert.deepEqual(results[1], results[0], 'the async form marks what the sync form does');
    assert.deepEqual(results[0].missing, ['._stub.mp3', 'missing.mp3', 'missing.mp3', 'missing.mp3', 'old.mp3']);
  }

  // The walked root stops answering after the folders have been read once: a drive that is
  // unplugged (every folder then reads as gone) or a share that times out. Nothing is marked.
  const realReaddir = fsp.readdir;
  for (const [name, stopAnswering] of [
    ['unplugged', (music) => rmSync(music, { recursive: true, force: true })],
    ['timeout', () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); }],
  ]) {
    const { music, lib, found, missing } = await setup(name);
    let reads = 0;
    fsp.readdir = async (path, ...rest) => {
      if (String(path).startsWith(music)) {
        reads += 1;
        if (reads === 4) stopAnswering(music);
        else if (reads > 4 && name === 'timeout') stopAnswering(music);
      }
      return realReaddir(path, ...rest);
    };
    let marked;
    try {
      marked = await lib.markUnfoundTracksMissingAsync([music], found);
    } finally {
      fsp.readdir = realReaddir;
    }
    assert.ok(reads >= 4, `${name}: the folders were read a second time`);
    assert.equal(marked, 0, `${name}: nothing is marked once the root stops answering`);
    assert.deepEqual(missing(), []);
    lib.close();
  }

  // A file that is gone at the first look and back at the second is not marked.
  {
    const { music, lib, found, missing } = await setup('back');
    let reads = 0;
    fsp.readdir = async (path, ...rest) => {
      if (String(path).startsWith(music)) {
        reads += 1;
        if (reads === 4) writeFileSync(join(music, 'A', 'missing.mp3'), 'x');
      }
      return realReaddir(path, ...rest);
    };
    let marked;
    try {
      marked = await lib.markUnfoundTracksMissingAsync([music], found);
    } finally {
      fsp.readdir = realReaddir;
    }
    assert.equal(marked, 2, 'the two files that are still gone are marked');
    assert.equal(missing().length, 2);
    assert.equal(lib.getTracks({ limit: 100 }).find((track) => track.path === join(music, 'A', 'missing.mp3')).missingSince, null);
    lib.close();
  }
}

// ---- the rest on one library
const lib2 = await LibraryStore.open(join(root, 'second.db'));
const music2 = '/Users/x/Music';
lib2.upsertTracks([
  incoming(`${music2}/Album/1 - A.flac`, { trackNo: 1, album: 'Num' }),
  incoming(`${music2}/Album/10 - J.flac`, { trackNo: 10, album: 'Num' }),
  incoming(`${music2}/Album/2 - B.flac`, { trackNo: 2, album: 'Num' }),
  incoming(`${music2}/Multi/CD10/01 c.flac`, { trackNo: 1, album: 'Multi' }),
  incoming(`${music2}/Multi/CD2/01 b.flac`, { trackNo: 1, album: 'Multi' }),
  incoming(`${music2}/Multi/CD1/01 a.flac`, { trackNo: 1, album: 'Multi' }),
  incoming(`${music2}/Singles/zeta.mp3`, { trackNo: 1, album: 'S1' }),
  incoming(`${music2}/Singles/alpha.mp3`, { trackNo: 1, album: 'S2' }),
  incoming(`${music2}/Singles/mid.mp3`, { trackNo: 1, album: 'S3' }),
  incoming(`${music2}/Björk/Homogenic/01 Hunter.flac`, { artist: 'Björk', album: 'Homogenic' }),
  // The accented name is in the path alone, so only the path can answer a search for it.
  incoming(`${music2}/Zoë Keating/Re/01 Ingrata.flac`, { title: 'Ingrata', artist: 'Artist', album: 'Re' }),
]);
const names = (tracks) => tracks.map((track) => track.path.slice(music2.length + 1));
assert.deepEqual(names(lib2.getFolderTracks(music2, { recursive: true })).slice(0, 9), [
  'Album/1 - A.flac', 'Album/2 - B.flac', 'Album/10 - J.flac',
  'Björk/Homogenic/01 Hunter.flac',
  'Multi/CD1/01 a.flac', 'Multi/CD2/01 b.flac', 'Multi/CD10/01 c.flac',
  'Singles/alpha.mp3', 'Singles/mid.mp3',
], 'numbers compare as numbers; a directory of singles goes by name');
assert.deepEqual(lib2.getFolderTrackIds(music2, { recursive: true }), lib2.getFolderTracks(music2, { recursive: true }).map((t) => t.id));
assert.deepEqual(
  names(await lib2.getFolderTracksAsync(`${music2}/Album`, {})),
  ['Album/1 - A.flac', 'Album/2 - B.flac', 'Album/10 - J.flac'],
  'the sliced listing orders the same way',
);
assert.deepEqual(names(lib2.getFolderTracks(music2, { recursive: true, limit: 2, offset: 1 })), ['Album/2 - B.flac', 'Album/10 - J.flac'], 'a page is cut after the sort');

// search: the folder the library lives in is not part of a free-text match
assert.equal(lib2.getTrackCount({ search: 'music' }), 0, '"music" is the library folder, not a track');
assert.equal(lib2.getTrackCount({ search: 'users' }), 0);
assert.equal(lib2.getTrackCount({ search: 'singles' }), 3, 'a folder below it still matches');
assert.equal(lib2.getTrackCount({ search: 'path:music' }), 11, 'path: still matches the whole path');
const nfd = 'Bjo\u0308rk';
// The artist is Björk too, so these two are met by the tags; the Zoë ones below are the path's.
assert.equal(lib2.getTrackCount({ search: nfd }), 1, 'a decomposed typed name finds the composed path');
assert.equal(lib2.getTrackCount({ search: `path:${nfd}` }), 1);
assert.equal(lib2.getTrackCount({ search: 'Zoe\u0308 Keating' }), 1, 'a decomposed name matches a path whose tags do not carry it');
assert.equal(lib2.getTrackCount({ search: 'path:Zoe\u0308 Keating' }), 1);
assert.equal(lib2.getTracksByPaths([`${music2}/BJÖRK/HOMOGENIC/01 HUNTER.FLAC`]).length, 1, 'a playlist path in another case resolves');
assert.equal(lib2.getTracksByPaths([`${music2}/Bjo\u0308rk/Homogenic/01 Hunter.flac`]).length, 1, 'and in another Unicode form');

// ratings: the same stars again leave a finer score alone
const [rated] = lib2.getTracks({ search: 'alpha', limit: 1 });
lib2.setTrackRatingScore(rated.id, 87);
assert.equal(lib2.getTrack(rated.id).rating, 4);
lib2.setTrackRating(rated.id, 4);
assert.equal(lib2.getTrack(rated.id).ratingScore, 87, 'four stars again keeps 87');
lib2.setTrackRating(rated.id, 5);
assert.equal(lib2.getTrack(rated.id).ratingScore, 100);
lib2.setTrackRating(rated.id, 0);
assert.equal(lib2.getTrack(rated.id).ratingScore, null);

// playlists: counts agree with the list, covers are stored by name
const picture = join(root, 'cover.png');
await writeFile(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const all = lib2.getTracks({ limit: 100 });
const playlist = lib2.savePlaylist({ name: 'Mixed', trackIds: [all[0].id, 999999, all[1].id], coverImagePath: picture });
assert.equal(playlist.trackCount, 2, 'an id that is no track is not counted');
assert.equal(lib2.getPlaylistTracks(playlist.id).length, 2);
const storedCover = lib2.one(`SELECT cover_art_path FROM playlists WHERE id = ?`, [playlist.id]).cover_art_path;
assert.ok(!storedCover.includes('/') && !storedCover.includes('\\'), 'the cover is stored as a file name');
assert.equal(lib2.getPlaylistCover(playlist.id)?.mime, 'image/png');
// A library.db that stored the whole path of another machine still finds the file by its name.
lib2.db.run(`UPDATE playlists SET cover_art_path = ? WHERE id = ?`, [`C:\\Users\\other\\playlist-art\\${storedCover}`, playlist.id]);
assert.equal(lib2.getPlaylistCover(playlist.id)?.mime, 'image/png', 'a legacy absolute path resolves by its name');
const added = lib2.addTracksToPlaylist({ playlistId: playlist.id, trackIds: [all[2].id, all[2].id, 888888] });
assert.equal(added.trackCount, 4, 'known ids are added, repeats included; unknown ones are not');
const coverFile = join(root, 'playlist-art', storedCover);
assert.equal(existsSync(coverFile), true);
lib2.deletePlaylist(playlist.id);
for (let i = 0; i < 40 && existsSync(coverFile); i += 1) await new Promise((r) => setTimeout(r, 25));
assert.equal(existsSync(coverFile), false, 'deleting the playlist removes its cover file');

// lists: the items go with the list
const list = lib2.saveList({ title: 'Gone soon' });
lib2.addListItem({ listId: list.id, trackId: null, label: 'one' });
lib2.deleteList(list.id);
assert.equal(lib2.one(`SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?`, [list.id]).n, 0, 'the list items are deleted with the list');

// tags: a limited pass leaves the other tracks' tags alone; the async pass agrees
lib2.saveTagRule({ name: 'rocky', body: 'tag(rocky) when genre = "Rock"' });
const full = lib2.recomputeTags();
assert.equal(full.tracksEvaluated, lib2.getTrackCount());
const before = lib2.getTagSummaries().find((tag) => tag.name === 'rocky').trackCount;
lib2.recomputeTags({ limit: 2 });
assert.equal(lib2.getTagSummaries().find((tag) => tag.name === 'rocky').trackCount, before, 'a pass over two tracks keeps the tags of the rest');
const asyncPass = await lib2.recomputeTagsAsync();
assert.equal(asyncPass.tracksEvaluated, full.tracksEvaluated);
assert.equal(lib2.getTagSummaries().find((tag) => tag.name === 'rocky').trackCount, before);
const preview = await lib2.previewTagRuleAsync({ body: 'tag(rocky2) when genre = "Rock"', limit: 4 });
assert.equal(preview.ok, true);
assert.equal(preview.totalCount, lib2.getTrackCount());
assert.equal(preview.sampledCount, 4, 'a large library is sampled down to the limit');
assert.deepEqual(await lib2.previewTagRuleAsync({ body: 'tag(rocky2) when genre = "Rock"', limit: 4 }), preview, 'the sample is the same each time');

// history views: the sliced forms agree with the sync ones, and a profile page keeps listening private
const [one, two] = lib2.getTracks({ limit: 2 });
lib2.recordPlay(one.id, Date.UTC(2026, 4, 15, 12));
lib2.recordPlay(two.id, Date.UTC(2026, 4, 14, 12));
lib2.recordSkip(two.id, Date.UTC(2026, 4, 14, 13), 5);
const now = Date.UTC(2026, 4, 15, 18);
assert.deepEqual(await lib2.getListeningInsightsAsync({ now }), lib2.getListeningInsights({ now }));
assert.deepEqual(await lib2.getWrappedStatsAsync({ range: 'all', now }), lib2.getWrappedStats({ range: 'all', now }));
assert.equal(lib2.getWrappedStats({ range: 'all', now }).totals.plays, 2);
assert.doesNotMatch(lib2.buildProfileBundleHtml({ now }), /Top artists/, 'a local profile does not publish its listening');
lib2.saveProfile({ defaultPrivacy: 'public' });
assert.match(lib2.buildProfileBundleHtml({ now }), /Top artists/);

// paging: a page past the first ones comes from the same order as a direct page
const many = Array.from({ length: 1500 }, (_, i) => incoming(`/big/${String(i).padStart(4, '0')} Song.flac`, { title: `Song ${i}`, artist: `Artist ${i % 37}` }));
lib2.upsertTracks(many);
const direct = lib2.getTrackIds({ sort: 'artist', limit: 1000, offset: 0 });
const wide = lib2.getTrackIds({ sort: 'artist', limit: 1400, offset: 0 });
assert.deepEqual(wide.slice(0, 1000), direct, 'the long list begins with the direct page');
assert.deepEqual(lib2.getTrackIds({ sort: 'artist', limit: 200, offset: 1000 }), wide.slice(1000, 1200), 'a direct page at the edge matches');
assert.deepEqual(lib2.getTrackIds({ sort: 'artist', limit: 100, offset: 1300 }), wide.slice(1300, 1400), 'a page from the kept list matches');
assert.deepEqual(lib2.getTracks({ sort: 'artist', limit: 100, offset: 1300 }).map((t) => t.id), wide.slice(1300, 1400));
// A write drops the kept list, and the next page is cut from a fresh one. The
// sort is one the write changes: five stars moves a track from the tail to the head.
const byRating = lib2.getTrackIds({ sort: 'rating', limit: 1400, offset: 0 });
const tailId = byRating[1300];
assert.deepEqual(lib2.getTrackIds({ sort: 'rating', limit: 100, offset: 1300 }), byRating.slice(1300, 1400), 'the page comes from the kept list');
lib2.setTrackRating(tailId, 5);
const byRatingAfter = lib2.getTrackIds({ sort: 'rating', limit: 1400, offset: 0 });
assert.equal(byRatingAfter[0], tailId, 'the rated track leads the list rebuilt after the write');
assert.deepEqual(lib2.getTrackIds({ sort: 'rating', limit: 100, offset: 1300 }), byRatingAfter.slice(1300, 1400));
assert.notDeepEqual(byRatingAfter.slice(1300, 1400), byRating.slice(1300, 1400), 'a stale list would have given the old page');

// Tracks that tie on every sort column page the same from the first page, the
// direct query and the kept list.
lib2.upsertTracks(Array.from({ length: 1200 }, (_, i) => incoming(`/same/${String((i * 7919) % 1200).padStart(4, '0')}.flac`, { title: 'Same', artist: 'Same', album: 'Same' })));
const tiedWide = lib2.getTrackIds({ sort: 'title', limit: 3000, offset: 0 });
const tiedDirect = lib2.getTrackIds({ sort: 'title', limit: 500, offset: 400 });
assert.deepEqual(tiedDirect, tiedWide.slice(400, 900), 'a page cut by the query matches the same page of the kept list');
assert.equal(new Set(tiedWide).size, tiedWide.length, 'no track repeats or is dropped across pages');
assert.deepEqual(lib2.getTrackIds({ sort: 'title', limit: 200, offset: 1100 }), tiedWide.slice(1100, 1300), 'pages that cross the direct limit agree');
lib2.close();

// A flush that can't export keeps the changes dirty and tries again by itself.
{
  const file = join(root, 'flush.db');
  const lib4 = await LibraryStore.open(file);
  lib4.upsertTracks([incoming('/m/flush.mp3')]);
  await lib4.flushPendingWrites();
  const realExport = lib4.db.export.bind(lib4.db);
  let failures = 1;
  lib4.db.export = () => {
    if (failures-- > 0) throw new Error('out of memory');
    return realExport();
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const [track] = lib4.getTracks({ limit: 1 });
  lib4.toggleLove(track.id);
  await new Promise((r) => setTimeout(r, 1200));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'a failed export is not an unhandled rejection');
  assert.equal(lib4.dirty, true, 'the changes are still waiting to be written');
  assert.notEqual(lib4.persistTimer, null, 'and a retry is scheduled');
  lib4.close();
  const reopened = await LibraryStore.open(file);
  assert.equal(reopened.getTrack(track.id).loved, 1, 'closing wrote what the failed flush could not');
  reopened.close();
}

// Saves that keep failing are retried at the pace of the delay, whatever the user
// does meanwhile, and are reported once it is clear they are not about to work.
{
  const lib6 = await LibraryStore.open(join(root, 'backoff.db'));
  lib6.upsertTracks([incoming('/m/a.mp3')]);
  await lib6.albumsReady?.();
  await lib6.flushPendingWrites();
  const realExport = lib6.db.export.bind(lib6.db);
  let failing = true;
  lib6.db.export = () => {
    if (failing) throw new Error('out of memory');
    return realExport();
  };
  const notices = [];
  lib6.onSaveFailed = (event) => notices.push(event);
  // Timers are collected, not waited for, so the test sees what is armed and for how long.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const armed = [];
  const pending = () => armed.filter((timer) => !timer.cleared && !timer.fired);
  const fire = (timer) => {
    timer.fired = true;
    timer.fn();
  };
  const [track] = lib6.getTracks({ limit: 1 });
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms, cleared: false, fired: false };
    armed.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };
  try {
    lib6.toggleLove(track.id);
    assert.deepEqual(pending().map((timer) => timer.ms), [800], 'an edit arms the usual short timer');
    fire(pending()[0]);
    assert.deepEqual(pending().map((timer) => timer.ms), [5000], 'a failed save is retried after 5 s');
    const retry = pending()[0];
    for (let i = 0; i < 5; i += 1) lib6.toggleLove(track.id);
    assert.equal(retry.cleared, false, 'edits made while saves fail do not cancel the retry');
    assert.deepEqual(pending().map((timer) => timer.ms), [5000], 'and do not start attempts of their own');
    fire(retry);
    assert.deepEqual(pending().map((timer) => timer.ms), [10_000], 'the delay doubles');
    assert.equal(lib6.saveError, null, 'two failures are not reported');
    fire(pending()[0]);
    assert.deepEqual(pending().map((timer) => timer.ms), [20_000]);
    assert.match(lib6.saveError, /^out of memory; changes are kept in memory/, 'the third failure in a row is reported with its reason');
    assert.equal(notices.length, 1, 'and the app is told once');
    assert.equal(notices[0].store, 'library');
    assert.match(notices[0].reason, /out of memory/);
    assert.ok(lib6.recoveryEvents.includes(notices[0]), 'the notice is among the recovery events');
    for (const delay of [40_000, 60_000, 60_000]) {
      fire(pending()[0]);
      assert.deepEqual(pending().map((timer) => timer.ms), [delay], 'the delay stops growing at a minute');
    }
    assert.equal(notices.length, 1, 'more failures are not new reports');
    failing = false;
    fire(pending()[0]);
    await lib6.waitForPendingWrites();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  assert.equal(lib6.dirty, false, 'the changes landed once saving worked');
  assert.equal(lib6.saveError, null, 'and the report is withdrawn');
  assert.equal(notices.length, 1, 'nothing more is said when saving works again');
  lib6.close();
}

// The same with a real failure: library.db has become a folder, so the replace is refused.
{
  const dir = join(root, 'refused');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'library.db');
  const lib7 = await LibraryStore.open(file);
  lib7.upsertTracks([incoming('/m/a.mp3')]);
  await lib7.albumsReady?.();
  await lib7.flushPendingWrites();
  await rm(file);
  await mkdir(file);
  const notices = [];
  lib7.onSaveFailed = (event) => notices.push(event);
  const [track] = lib7.getTracks({ limit: 1 });
  lib7.toggleLove(track.id);
  // An edit made while a write is under way is written right after it, unless that
  // write failed: then it waits for the retry, whatever timer the edit armed.
  let exports = 0;
  const realExport = lib7.db.export.bind(lib7.db);
  lib7.db.export = () => {
    exports += 1;
    return realExport();
  };
  // A refused replace must not make the main thread sleep and rewrite the file as the
  // quit-time save does (Windows refuses with EPERM, which that save waits out; elsewhere
  // a folder in the way is refused outright, so this holds either way).
  const realWait = Atomics.wait;
  let sleeps = 0;
  Atomics.wait = (...args) => {
    sleeps += 1;
    return realWait(...args);
  };
  try {
    const firstWrite = lib7.flushAsync();
    lib7.setTrackRating(track.id, 3);
    const secondWrite = lib7.flushAsync();
    await Promise.all([firstWrite, secondWrite]);
  } finally {
    Atomics.wait = realWait;
  }
  assert.equal(sleeps, 0, 'a refused replace in a background save does not sleep on the main thread');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(exports, 1, 'a write is not repeated, at once or by the edit\'s own timer, after a failed one');
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    assert.equal(lib7.saveError, null, `${attempt - 1} failures are not reported`);
    await lib7.flushAsync();
    assert.equal(lib7.dirty, true, 'the change is still waiting to be written');
  }
  assert.ok(lib7.saveError, 'the third failure in a row is reported');
  assert.equal(notices[0]?.filePath, file, 'and names the file');
  assert.equal(notices.length, 1);
  await rm(file, { recursive: true });
  await lib7.flushAsync();
  assert.equal(lib7.saveError, null);
  assert.equal(notices.length, 1);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), [], 'the copies the failed saves left are removed once one lands');
  lib7.close();
  const back = await LibraryStore.open(file);
  assert.equal(back.getTrack(track.id).loved, 1, 'the change made while saving failed is on disk');
  assert.equal(back.getTrack(track.id).rating, 3, 'and so is the one made during a write that failed');
  back.close();
}

// After a run of answers that are neither yes nor no the sweep stops asking, so
// a file past the run is kept as offline even when it is plainly gone.
if (canDenyAccess) {
  const lib5 = await LibraryStore.open(join(root, 'fifth.db'));
  const music5 = join(root, 'Music5');
  mkdirSync(join(music5, 'Gone'), { recursive: true });
  writeFileSync(join(music5, 'Gone', 'kept.mp3'), 'x');
  mkdirSync(join(music5, 'Locked'), { recursive: true });
  for (let i = 0; i < 6; i += 1) writeFileSync(join(music5, 'Locked', `${i}.mp3`), 'x');
  lib5.upsertTracks([
    ...Array.from({ length: 6 }, (_, i) => incoming(join(music5, 'Locked', `${i}.mp3`))),
    incoming(join(music5, 'Gone', 'deleted.mp3')),
  ]);
  const before = lib5.previewPruneMissingTracks(undefined, [music5]);
  assert.equal(before.tracks, 1, 'with every folder answering, the deleted file is proven gone');
  chmodSync(join(music5, 'Locked'), 0o000);
  try {
    const during = lib5.previewPruneMissingTracks(undefined, [music5]);
    assert.equal(during.tracks, 0, 'five unanswered files in a row end the sweep; the one after is not judged');
    assert.equal(during.offline, 7, 'and everything left is counted offline');
    const duringAsync = await lib5.previewPruneMissingTracksAsync(undefined, [music5]);
    assert.equal(duringAsync.tracks, 1, 'the sliced sweep asks every file at once, and a deleted one is still proven');
    assert.equal(duringAsync.offline, 6);
  } finally {
    chmodSync(join(music5, 'Locked'), 0o755);
  }
  lib5.close();
}

// ---- folder order: a directory's tracks stay together, and the sort compares directories
{
  // Two directories whose names differ only in case compare equal to the collator.
  // Their tracks used to be shuffled together by file name.
  const lib8 = await LibraryStore.open(join(root, 'eighth.db'));
  const base8 = '/Users/x/Music3';
  lib8.upsertTracks([
    incoming(`${base8}/rock/a.mp3`, { title: 'a', album: '' }),
    incoming(`${base8}/Rock/b.mp3`, { title: 'b', album: '' }),
    incoming(`${base8}/rock/b2.mp3`, { title: 'b2', album: '' }),
    incoming(`${base8}/Rock/a2.mp3`, { title: 'a2', album: '' }),
  ]);
  const titles = lib8.getFolderTracks(base8, { recursive: true }).map((track) => track.title);
  assert.deepEqual(titles, ['a2', 'b', 'a', 'b2'], 'each directory plays through before the next one starts');
  lib8.close();
}

{
  // Counting how often the collator is asked needs a copy of the module loaded while Intl.Collator is wrapped.
  let collations = 0;
  const RealCollator = Intl.Collator;
  Intl.Collator = function CountingCollator(...args) {
    const collator = new RealCollator(...args);
    const compare = collator.compare;
    Object.defineProperty(collator, 'compare', { value: (a, b) => { collations += 1; return compare(a, b); } });
    return collator;
  };
  let CountingStore;
  try {
    const url = pathToFileURL(resolve(repoRoot, 'dist-electron', 'electron', 'library.js')).href;
    ({ LibraryStore: CountingStore } = await import(`${url}?counting`));
  } finally {
    Intl.Collator = RealCollator;
  }
  const lib9 = await CountingStore.open(join(root, 'ninth.db'));
  const base9 = '/Users/x/Big';
  const ALBUMS = 100;
  const PER_ALBUM = 30;
  // Albums arrive in no particular order; the tracks of one album stay together.
  const order = Array.from({ length: ALBUMS }, (_, i) => (i * 37) % ALBUMS);
  lib9.upsertTracks(order.flatMap((a) => Array.from({ length: PER_ALBUM }, (_, t) => incoming(
    `${base9}/Artist ${String(a).padStart(3, '0')}/Album/${String(t + 1).padStart(2, '0')} Song.flac`,
    { trackNo: t + 1, album: `Album ${a}`, artist: `Artist ${a}`, albumArtist: `Artist ${a}`, title: `Song ${t + 1}` },
  ))));
  await lib9.albumsReady?.();
  const everyTrack = ALBUMS * PER_ALBUM;
  collations = 0;
  const firstPage = lib9.getFolderTrackIds(base9, { recursive: true, limit: 60 });
  assert.ok(collations < everyTrack, `sorting ${everyTrack} tracks compared names ${collations} times; directories are compared, not every pair of tracks`);
  assert.deepEqual(
    lib9.getTracksByIdsInOrder(firstPage).map((track) => track.title),
    [...Array.from({ length: PER_ALBUM }, (_, t) => `Song ${t + 1}`), ...Array.from({ length: PER_ALBUM }, (_, t) => `Song ${t + 1}`)],
    'two albums in order, track by track',
  );
  // The pages after the first come from the sort already made.
  const realPrepare = lib9.db.prepare.bind(lib9.db);
  let scans = 0;
  lib9.db.prepare = (...args) => {
    scans += 1;
    return realPrepare(...args);
  };
  collations = 0;
  const secondPage = lib9.getFolderTrackIds(base9, { recursive: true, limit: 60, offset: 60 });
  assert.equal(scans, 0, 'a later page is cut from the kept order, without reading the library again');
  assert.equal(collations, 0);
  assert.equal(new Set([...firstPage, ...secondPage]).size, 120);
  // A write ends it: the next page is worked out again and sees the new track.
  lib9.upsertTracks([incoming(`${base9}/Artist 000/Album/99 New.flac`, { trackNo: 99, album: 'Album 0', artist: 'Artist 0', albumArtist: 'Artist 0', title: 'New' })]);
  assert.equal(lib9.getFolderTrackIds(base9, { recursive: true }).length, everyTrack + 1, 'a kept order is not served after the library changes');
  lib9.db.prepare = realPrepare;
  lib9.close();
}

// ---- search: a library folder named with a character outside the basic plane
{
  const lib10 = await LibraryStore.open(join(root, 'tenth.db'));
  const home = join(root, '\u{1F3B5} Mix');
  const plain = { album: 'Album', artist: 'Artist', albumArtist: 'Artist', genre: 'Pop' };
  lib10.upsertTracks([
    incoming(join(home, 'Rock', 'a.mp3'), { ...plain, title: 'First' }),
    incoming(join(home, 'Jazz', 'b.mp3'), { ...plain, title: 'Second' }),
  ]);
  assert.deepEqual(lib10.getTracks({ search: 'rock' }).map((track) => track.title), ['First'], 'a folder name below the library folder is searched');
  assert.equal(lib10.getTrackCount({ search: 'mix' }), 0, 'the library folder itself is not');
  lib10.close();
}

// ---- tag rule preview: a library over the limit is sampled at an even spacing
{
  const lib11 = await LibraryStore.open(join(root, 'eleventh.db'));
  lib11.upsertTracks(Array.from({ length: 10 }, (_, i) => incoming(`/s/${i}.mp3`, { title: `S${i}` })));
  const ids = lib11.getTracks({ limit: 10, sort: 'title' }).map((track) => track.id);
  const everything = 'tag(everything) when duration > 0';
  const sampled = await lib11.previewTagRuleAsync({ body: everything, limit: 4 });
  assert.equal(sampled.sampledCount, 4, 'as many tracks as the limit, not about half of them');
  assert.deepEqual(sampled.sampleTrackIds, [ids[2], ids[4], ids[7], ids[9]], 'spread evenly through the library');
  assert.equal((await lib11.previewTagRuleAsync({ body: everything, limit: 10 })).sampledCount, 10, 'a library no larger than the limit is all of it');
  // Ids with gaps (tracks that were removed) sample no worse.
  lib11.removeTracksById([ids[0], ids[1], ids[5]]);
  const gaps = await lib11.previewTagRuleAsync({ body: everything, limit: 3 });
  assert.equal(gaps.sampledCount, 3);
  assert.equal(gaps.totalCount, 7);
  lib11.close();
}

if (process.platform === 'darwin' || process.platform === 'win32') {
  // Where names compare without case a changed file under a re-cased folder is the same row.
  const lib3 = await LibraryStore.open(join(root, 'third.db'));
  lib3.upsertTracks([incoming('/Users/x/music/The Beatles/one.flac', { title: 'One' })]);
  lib3.upsertTracks([incoming('/Users/x/music/the beatles/one.flac', { title: 'One', size: 2 })]);
  assert.equal(lib3.getTrackCount(), 1, 'a case-variant path updates the row instead of adding one');
  lib3.close();
}

// A file renamed in case or Unicode form keeps its row, and the row takes the
// spelling the file has now, so playback opens a path that exists. On a volume
// that keeps the spellings apart, two files that differ only in case stay two.
if (process.platform === 'darwin') {
  const lib6 = await LibraryStore.open(join(root, 'sixth.db'));
  const dir6 = join(root, 'Rename');
  mkdirSync(dir6, { recursive: true });
  writeFileSync(join(dir6, 'track.mp3'), 'x');
  // Stored under a spelling the disk no longer has.
  lib6.upsertTracks([incoming(join(dir6, 'Track.mp3'), { title: 'Track' })]);
  const [stored] = lib6.getTracks({ limit: 10 });
  lib6.recordPlay(stored.id, Date.UTC(2026, 4, 1));
  lib6.upsertTracks([incoming(join(dir6, 'track.mp3'), { title: 'Track', size: 2 })]);
  const rows = lib6.getTracks({ limit: 10 });
  assert.equal(rows.length, 1, 'the renamed file is the same row');
  assert.equal(rows[0].id, stored.id, 'with the same id');
  assert.equal(rows[0].path, join(dir6, 'track.mp3'), 'under the spelling the file has now');
  assert.equal(lib6.getTrack(stored.id).playCount, 1, 'its history is kept');

  const nfc = 'Caf\u00e9.mp3';
  const nfdName = 'Cafe\u0301.mp3';
  writeFileSync(join(dir6, nfc), 'x');
  lib6.upsertTracks([incoming(join(dir6, nfdName), { title: 'Cafe' })]);
  lib6.upsertTracks([incoming(join(dir6, nfc), { title: 'Cafe', size: 2 })]);
  assert.equal(lib6.getTracks({ limit: 10 }).filter((track) => track.title === 'Cafe').length, 1, 'a Unicode-form rename is one row too');

  // Two real files: a volume that tells them apart holds both rows.
  const twin = join(root, 'Twin');
  mkdirSync(twin, { recursive: true });
  writeFileSync(join(twin, 'A.flac'), 'x');
  const apart = !existsSync(join(twin, 'a.flac'));
  if (apart) {
    writeFileSync(join(twin, 'a.flac'), 'y');
    lib6.upsertTracks([incoming(join(twin, 'A.flac'), { title: 'Upper' })]);
    lib6.upsertTracks([incoming(join(twin, 'a.flac'), { title: 'Lower' })]);
    assert.equal(lib6.getTracks({ limit: 20 }).filter((track) => track.path.startsWith(twin)).length, 2, 'files that differ only in case stay two rows');
  }
  lib6.close();
}

await rm(root, { recursive: true, force: true });
console.log('[library-storage-errors-test] ok');
