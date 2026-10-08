// A file that goes missing must never take its track's identity or user data
// with it. The library watcher used to delete any watched track it could not
// find 1.5s after an event, along with its plays, ratings, bookmarks and
// playlist places; a remount or a slow save-by-rename brought the file back
// as a new track with nothing. Now:
//  - the automatic path (what main.ts's reconcileWatchedTargets calls) only
//    marks the track unavailable; the scanner clears the mark and the track
//    keeps its id, even when the returning file is skipped as unchanged;
//  - unavailable tracks stay in browse and search (missing:file finds them)
//    but not in generated mixes, smart rules or Discover;
//  - an offline root (unplugged drive, empty mount point) deletes nothing,
//    through the watcher, a rescan, a forced rescan or explicit cleanup;
//  - explicit cleanup still removes files that are really gone from a
//    reachable folder;
//  - a scan that walks a root to the end marks what it didn't find (a file
//    deleted while NewAmp was closed), and nothing where it couldn't look;
//  - a dropped share is marked without a stat per file.
// Run: npm run build:electron && node scripts/library-availability-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises, { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { LibraryWatcher } from '../dist-electron/electron/library-watcher.js';
import { Scanner, readTrackFile } from '../dist-electron/electron/scanner.js';

async function waitFor(condition, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-availability-test');
const music = join(root, 'music');
const albumDir = join(music, 'Artist', 'Album');
const parked = join(root, 'parked');
await rm(root, { recursive: true, force: true });
await mkdir(albumDir, { recursive: true });
await mkdir(parked, { recursive: true });

// Not real audio: the scanner keeps a filename-titled row when parsing fails,
// which is all these paths need.
const aPath = join(albumDir, 'a-song.mp3');
const bPath = join(albumDir, 'b-song.mp3');
const cPath = join(music, 'c-loose.mp3');
for (const path of [aPath, bPath, cPath]) await writeFile(path, `fixture ${path}`);

const library = await LibraryStore.open(join(root, 'library.db'));
const scanner = new Scanner(library, () => {});
await scanner.start([music]);
assert.equal(library.getStats().tracks, 3);

const [a] = library.getTracksByPaths([aPath]);
library.setTrackRating(a.id, 5);
library.toggleLove(a.id);
library.recordPlay(a.id, 1_700_000_000_000);
library.recordPlay(a.id, 1_700_000_500_000);
library.saveTrackBookmark({ trackId: a.id, position: 42, label: 'Chorus' });
library.applyManualMetadataPatch(a.id, { genre: 'Keeper' });
const playlist = library.savePlaylist({ name: 'Keep me', trackIds: [a.id] });

function assertUserDataIntact(label) {
  const track = library.getTrack(a.id);
  assert.ok(track, `${label}: the track row must survive`);
  assert.equal(track.rating, 5, `${label}: rating`);
  assert.equal(track.loved, 1, `${label}: loved`);
  assert.equal(track.playCount, 2, `${label}: play count`);
  assert.equal(track.genre, 'Keeper', `${label}: edited metadata`);
  assert.equal(
    library.getListeningHistory({ limit: 50 }).filter((item) => item.track.id === a.id).length,
    2,
    `${label}: play history`,
  );
  assert.deepEqual(library.getTrackBookmarks(a.id).map((b) => b.label), ['Chorus'], `${label}: bookmarks`);
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((t) => t.id), [a.id], `${label}: playlist place`);
  return track;
}

const idsIn = (tracks) => tracks.map((track) => track.id);

// 1. The watcher's view: the file vanishes, the reconcile runs, the file returns.
{
  await rename(aPath, join(parked, 'a-song.mp3'));
  // main.ts reconcileWatchedTargets: mark what is still gone, then force-rescan the targets.
  assert.equal(library.markTracksMissing([aPath]), 1);
  await scanner.start([aPath], { force: true });

  const missing = assertUserDataIntact('while missing');
  assert.equal(typeof missing.missingSince, 'number', 'the track is marked unavailable');
  assert.equal(library.markTracksMissing([aPath]), 0, 'marking again changes nothing');

  // Browse and search keep it; generated sets skip it.
  assert.ok(idsIn(library.getTracks({ limit: 50 })).includes(a.id), 'browse still lists it');
  assert.ok(idsIn(library.getTracks({ search: 'a-song', limit: 50 })).includes(a.id), 'search still finds it');
  assert.deepEqual(idsIn(library.getTracks({ search: 'missing:file', limit: 50 })), [a.id]);
  assert.ok(!idsIn(library.getTracks({ search: 'has:file', limit: 50 })).includes(a.id));
  assert.ok(!idsIn(library.buildTasteMix({ count: 50 })).includes(a.id), 'taste mix skips it');
  assert.ok(!idsIn(library.buildTasteMix({ count: 50, seedTrackId: a.id })).includes(a.id), 'even as the seed');
  assert.ok(!idsIn(library.buildHarmonicMix({ count: 50, seedTrackId: a.id })).includes(a.id), 'harmonic mix skips it');
  assert.ok(
    !idsIn(library.runSmartPlaylistRule({ name: 'All', mood: 'focus', count: 50 })).includes(a.id),
    'smart rules skip it',
  );
  assert.ok(
    !idsIn(library.runSmartPlaylistRule({ name: 'Folder', mood: 'focus', count: 50, folderPath: music })).includes(a.id),
    'folder rules (Auto DJ) skip it',
  );
  library.saveTagRule({ name: 'keeper', body: 'tag(keeper) when genre = "Keeper"' });
  library.recomputeTags();
  assert.ok(!library.getTrackIdsByTag('keeper').includes(a.id), 'tag playlists (and the Radio Brain tag M3U) skip it');
  const tagPreview = library.previewTagRule({ body: 'tag(keeper) when genre = "Keeper"' });
  assert.deepEqual(
    { matchCount: tagPreview.matchCount, samples: tagPreview.sampleTrackIds },
    { matchCount: 0, samples: [] },
    'the tag-rule preview counts what the tag playlist will hold',
  );
  assert.ok(!library.getTrackIdsMissingDna(5000).includes(a.id), 'DNA analysis does not queue a file that is gone');
  assert.ok(
    !library.getLibraryHealth().recentlyAdded.some((track) => track.id === a.id),
    'Library Health does not offer it as recently added',
  );
  const discover = library.getDiscoverSurface({ limit: 12, seedTrackId: a.id });
  assert.ok(
    ![...discover.cards, ...discover.missions].flatMap((item) => item.tracks).some((track) => track.id === a.id),
    'Discover skips it',
  );

  // Back, unchanged: an incremental scan skips parsing it and must still clear the mark.
  await rename(join(parked, 'a-song.mp3'), aPath);
  await scanner.start([music]);
  const back = assertUserDataIntact('after return');
  assert.equal(back.missingSince, null, 'the mark clears when the scanner sees the file');
  assert.ok(idsIn(library.buildTasteMix({ count: 50 })).includes(a.id), 'and it is eligible for mixes again');
  assert.ok(library.getTrackIdsByTag('keeper').includes(a.id));
  assert.deepEqual(library.previewTagRule({ body: 'tag(keeper) when genre = "Keeper"' }).sampleTrackIds, [a.id]);
  assert.ok(library.getTrackIdsMissingDna(5000).includes(a.id), 'and DNA analysis picks it up again');
  assert.ok(library.getLibraryHealth().recentlyAdded.some((track) => track.id === a.id));

  // Playing a track is proof enough too, without waiting for a scan.
  const [c] = library.getTracksByPaths([cPath]);
  await rename(cPath, join(parked, 'c-loose.mp3'));
  library.markTracksMissing([cPath]);
  await rename(join(parked, 'c-loose.mp3'), cPath);
  assert.equal(typeof library.getTrack(c.id).missingSince, 'number');
  library.recordPlay(c.id);
  assert.equal(library.getTrack(c.id).missingSince, null, 'a successful play clears the mark');

  // Same through the watcher's own forced rescan of the returning path.
  await rename(aPath, join(parked, 'a-song.mp3'));
  library.markTracksMissing([aPath]);
  await rename(join(parked, 'a-song.mp3'), aPath);
  await scanner.start([aPath], { force: true });
  assert.equal(assertUserDataIntact('after forced return').missingSince, null);
  assert.equal(library.getStats().tracks, 3, 'no duplicate row for the returning file');
}

// 2. The whole root goes offline: nothing path through the library deletes.
{
  await rename(music, join(root, 'music-unplugged'));
  library.markTracksMissing([music]); // a watcher event on the root itself
  await scanner.start([music]);
  await scanner.start([music], { force: true });
  assert.equal(library.getStats().tracks, 3, 'rescans of an offline root delete nothing');

  const pruned = library.pruneMissingTracks(undefined, [music]);
  assert.deepEqual(pruned, { checked: 3, removed: 0, offline: 3 }, 'explicit cleanup keeps tracks on an offline root');
  const targeted = library.pruneMissingTracks([music], [music]);
  assert.deepEqual(targeted, { checked: 3, removed: 0, offline: 3 });

  // (An empty mount point left at the root's path, and sub-mounts under a
  // reachable root, need a second device: scripts/library-prune-safety-test.mjs.)
  assertUserDataIntact('root offline');

  await rename(join(root, 'music-unplugged'), music);
  await scanner.start([music]);
  assert.equal(assertUserDataIntact('root back').missingSince, null);
  assert.equal(library.getTracks({ search: 'missing:file', limit: 50 }).length, 0, 'every mark cleared');
}

// 3. Explicit cleanup still removes what is really gone from a reachable root.
{
  await rm(bPath);
  const [b] = library.getTracksByPaths([bPath]);
  library.applyManualMetadataPatch(b.id, { title: 'Doomed edit' });
  const deletedFile = library.pruneMissingTracks(undefined, [music]);
  assert.deepEqual(deletedFile, { checked: 3, removed: 1, offline: 0 });
  assert.equal(library.getTrack(b.id), null);

  // A whole album folder deleted inside a root that is still there.
  await rm(join(music, 'Artist'), { recursive: true });
  const deletedFolder = library.pruneMissingTracks(undefined, [music]);
  assert.deepEqual(deletedFolder, { checked: 2, removed: 1, offline: 0 });
  assert.equal(library.getTrack(a.id), null);
  assert.deepEqual(library.getPlaylistTracks(playlist.id), []);
  assert.equal(library.getStats().tracks, 1, 'the loose track in the root is untouched');
}
library.close();

// 4. A watched root that goes away and comes back is noticed without a
//    relaunch: its disappearance is queued like any vanished path (so its
//    tracks get marked), and its return is handed over for a rescan (which
//    clears the marks).
{
  const watchedRoot = join(root, 'watched');
  const away = join(root, 'watched-away');
  await mkdir(watchedRoot, { recursive: true });
  const changed = [];
  const returned = [];
  const watcher = new LibraryWatcher((targets) => void changed.push(...targets), {
    debounceMs: 50,
    rootPollMs: 60,
    onRootAvailable: (path) => returned.push(path),
  });
  watcher.start([watchedRoot]);
  await rename(watchedRoot, away);
  await waitFor(() => changed.includes(watchedRoot), 'the vanished root is queued');
  assert.deepEqual(watcher.getWatchedRoots(), []);
  await rename(away, watchedRoot);
  await waitFor(() => returned.includes(watchedRoot), 'the returning root is reported');
  assert.deepEqual(watcher.getWatchedRoots(), [watchedRoot], 'and watched again');
  watcher.stop();

  // Launched with the drive unplugged, while settings saves keep calling
  // start() with the same roots (they do, every few seconds during playback).
  const lateRoot = join(root, 'late-drive');
  const lateReturned = [];
  const lateWatcher = new LibraryWatcher(() => {}, {
    debounceMs: 50,
    rootPollMs: 60,
    onRootAvailable: (path) => lateReturned.push(path),
  });
  lateWatcher.start([lateRoot]);
  const resaves = setInterval(() => lateWatcher.start([lateRoot]), 20);
  await mkdir(lateRoot);
  try {
    await waitFor(() => lateReturned.includes(lateRoot), 'a root that was missing at launch is picked up');
  } finally {
    clearInterval(resaves);
    lateWatcher.stop();
  }
}

// 5. The production wiring: the watcher path marks, only the IPC deletes.
const mainSource = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const reconcileBody = mainSource.slice(
  mainSource.indexOf('function reconcileWatchedTargets'),
  mainSource.indexOf('// Quiesces the two automatic'),
);
assert.match(reconcileBody, /library\.markTracksMissing\(stillMissing\)/, 'the watcher marks missing tracks');
assert.doesNotMatch(reconcileBody, /pruneMissingTracks/, 'the watcher must never delete tracks');
const pruneHandler = mainSource.slice(
  mainSource.indexOf("ipcMain.handle('library:prune-missing',"),
  mainSource.indexOf("ipcMain.handle('history:get'"),
);
assert.equal(
  mainSource.match(/\.pruneMissingTracks\(/g)?.length,
  pruneHandler.match(/\.pruneMissingTracks\(/g)?.length,
  'pruneMissingTracks is reachable only from the explicit library:prune-missing IPC',
);
assert.match(pruneHandler, /settings\.get\(\)\.libraryRoots/, 'explicit cleanup knows the library roots');

// 6. Files deleted while NewAmp was closed left no watcher event behind, so
//    the next scan marks them. Only where the scan really looked: a root that
//    isn't there, a folder the walk couldn't list, or a scan cancelled part
//    way marks nothing, and a file the walk skips (inside a dot-folder) but
//    that is there stays as it is. Marking never deletes.
{
  const scanRoot = join(root, 'closed');
  const albumA = join(scanRoot, 'Album A');
  const albumB = join(scanRoot, 'Album B');
  const hidden = join(scanRoot, '.hidden');
  for (const dir of [albumA, albumB, hidden]) await mkdir(dir, { recursive: true });
  const keepPath = join(albumA, 'keep.mp3');
  const gonePath = join(albumA, 'gone.mp3');
  const unlistedPath = join(albumB, 'unlisted.mp3');
  const hiddenPath = join(hidden, 'hidden.mp3');
  for (const path of [keepPath, gonePath, unlistedPath, hiddenPath]) await writeFile(path, `fixture ${path}`);

  const lib = await LibraryStore.open(join(root, 'closed-library', 'library.db'));
  const scan = new Scanner(lib, () => {});
  await scan.start([scanRoot]);
  lib.upsertTracks([await readTrackFile(hiddenPath)]); // added some other way; the walk skips dot-folders
  const id = (path) => lib.getTracksByPaths([path])[0].id;
  const marked = (path) => lib.getTrack(id(path)).missingSince != null;
  lib.recordPlay(id(gonePath));

  await rm(gonePath);
  await scan.start([scanRoot]);
  assert.ok(marked(gonePath), 'the next scan marks a file deleted while NewAmp was closed');
  assert.equal(lib.getTrack(id(gonePath)).playCount, 1, 'marked with its history');
  assert.equal(lib.getStats().tracks, 4, 'and not deleted');
  assert.ok(!idsIn(lib.buildTasteMix({ count: 50 })).includes(id(gonePath)), 'mixes and Auto DJ stop picking it');
  assert.ok(!marked(keepPath) && !marked(unlistedPath), 'files that are there are not marked');
  assert.ok(!marked(hiddenPath), 'nor is one the walk skips but that is there');

  // Folders the walk can't list: not finding their files says nothing.
  await rm(unlistedPath);
  const realReaddir = fsPromises.readdir;
  const refuse = (blocked) => async (dir, ...rest) => {
    if (resolve(String(dir)) === resolve(blocked)) {
      const err = new Error(`EACCES: permission denied, scandir '${dir}'`);
      err.code = 'EACCES';
      throw err;
    }
    return realReaddir.call(fsPromises, dir, ...rest);
  };
  for (const blocked of [albumB, scanRoot]) {
    fsPromises.readdir = refuse(blocked);
    try {
      await scan.start([scanRoot]);
    } finally {
      fsPromises.readdir = realReaddir;
    }
    assert.ok(!marked(unlistedPath), `an unlistable ${blocked === scanRoot ? 'root' : 'folder'} marks nothing under it`);
  }

  // A scan cancelled part way marks nothing.
  fsPromises.readdir = async (dir, ...rest) => {
    if (resolve(String(dir)) === resolve(albumA)) scan.cancel();
    return realReaddir.call(fsPromises, dir, ...rest);
  };
  try {
    await scan.start([scanRoot]);
  } finally {
    fsPromises.readdir = realReaddir;
  }
  assert.ok(!marked(unlistedPath), 'a cancelled scan marks nothing');

  // A root that isn't there (unplugged, share dropped) marks nothing.
  await rename(scanRoot, `${scanRoot}-unplugged`);
  await scan.start([scanRoot]);
  await scan.start([scanRoot], { force: true });
  await rename(`${scanRoot}-unplugged`, scanRoot);
  assert.ok(!marked(keepPath) && !marked(unlistedPath), 'an offline root marks nothing');

  // Listable and walked to the end again: now its absence counts.
  await scan.start([scanRoot]);
  assert.ok(marked(unlistedPath));
  assert.ok(!marked(keepPath));

  // And a mark clears when the file is back.
  await writeFile(gonePath, 'back again');
  await scan.start([scanRoot]);
  assert.ok(!marked(gonePath));
  lib.close();
}

// 7. A network share or drive dropping as a whole: the watcher hands over its
//    root, and the tracks under it are marked without a stat per file (tens
//    of thousands of stats on a dead SMB path hang the main process). Where
//    the target itself is still there, each folder is checked once before
//    its files.
{
  const lib = await LibraryStore.open(join(root, 'share-library', 'library.db'));
  const deadShare = join(root, 'dead-share'); // never there: the share is gone
  const liveShare = join(root, 'live-share'); // there, but its album folders are gone
  await mkdir(liveShare, { recursive: true });
  const tracksUnder = (base) => Array.from({ length: 40 }, (_, i) => join(base, `Album ${i % 4}`, `track ${i}.mp3`));
  lib.upsertTracks([...tracksUnder(deadShare), ...tracksUnder(liveShare)].map((path) => ({
    path, title: basename(path), artist: 'Share', album: 'Share', albumArtist: 'Share', trackNo: null, discNo: null,
    year: null, genre: null, duration: 100, bitrate: null, sampleRate: null, bpm: null, key: null,
    replayGainTrackDb: null, replayGainAlbumDb: null, size: 1, mtime: 1, art: null,
  })));

  let countUnder = null;
  let statsInside = 0;
  const count = (path) => {
    if (countUnder && resolve(String(path)).startsWith(`${countUnder}${sep}`)) statsInside += 1;
  };
  const realExistsSync = fs.existsSync;
  const realStatSync = fs.statSync;
  const realLstatSync = fs.lstatSync;
  fs.existsSync = (path, ...rest) => (count(path), realExistsSync.call(fs, path, ...rest));
  fs.statSync = (path, ...rest) => (count(path), realStatSync.call(fs, path, ...rest));
  fs.lstatSync = (path, ...rest) => (count(path), realLstatSync.call(fs, path, ...rest));
  syncBuiltinESMExports();
  try {
    countUnder = resolve(deadShare);
    assert.equal(lib.markTracksMissing([deadShare]), 40);
    assert.equal(statsInside, 0, 'a target that is gone answers for every track under it, with no stat of each file');
    countUnder = resolve(liveShare);
    statsInside = 0;
    assert.equal(lib.markTracksMissing([liveShare]), 40);
    assert.ok(statsInside <= 4, `one stat per missing folder, not one per file (${statsInside} for 4 folders)`);
  } finally {
    fs.existsSync = realExistsSync;
    fs.statSync = realStatSync;
    fs.lstatSync = realLstatSync;
    syncBuiltinESMExports();
    lib.close();
  }
}

await rm(root, { recursive: true, force: true });
console.log('[library-availability-test] ok: missing files keep their identity and data; offline roots delete nothing');
