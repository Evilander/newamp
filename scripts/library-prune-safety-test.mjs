// "Clean missing files" deletes history, ratings, bookmarks, edits and
// playlist places, so it has to be sure a file is really gone and has to say
// what it will take before it takes it.
//  - A library root that holds a separate mount (Linux /media/$USER or /mnt,
//    a Windows junction to a NAS) is reachable while that mount is gone. Its
//    tracks used to be deleted then. Now a missing file counts as deleted only
//    when the nearest folder still there is a real folder (not a link or
//    junction) on the device the file was on when it was last scanned.
//  - Tracks scanned before devices were recorded fall back to their root's
//    device, and only for a populated folder strictly inside the root.
//  - A track's own populated folder only counts when it is on the track's
//    device, and a track under no configured root can't be proven deleted
//    from anything further up.
//  - The preview counts exactly what the removal then deletes, and deletes
//    nothing itself; main backs up before removing, and the Library view asks
//    first and can't get stuck on a rejected call.
// Run: npm run build:electron && node scripts/library-prune-safety-test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-prune-safety-test');
const music = join(root, 'music');
const nasTarget = join(root, 'nas-share');
await rm(root, { recursive: true, force: true });
await mkdir(join(music, 'Artist', 'Album'), { recursive: true });
await mkdir(nasTarget, { recursive: true });
await writeFile(join(music, 'loose.mp3'), 'keeps the root populated');

const library = await LibraryStore.open(join(root, 'library.db'));
const rootDev = Number(statSync(music).dev);
// A device number no real folder here has: the file lived on another drive.
const otherDev = rootDev + 7919;

function reading(path, dev) {
  return {
    path,
    title: path.split(/[\\/]/).pop(),
    artist: 'Prune Safety',
    album: 'Album',
    albumArtist: 'Prune Safety',
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    duration: 100,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1,
    mtime: 1,
    art: null,
    dev,
  };
}
const ids = (paths) => library.getTracksByPaths(paths).map((track) => track.id);
const roots = [music];

// 1. A sub-mount of the root is unplugged: its folder is gone and what is left
//    at the path is the root's own filesystem.
{
  const onUsb = join(music, 'USB', 'Artist', 'song.flac');
  library.upsertTracks([reading(onUsb, otherDev)]);
  const preview = library.previewPruneMissingTracks(undefined, roots);
  assert.equal(preview.tracks, 0, 'a track on an unmounted drive under the root is not deletable');
  assert.equal(preview.offline, 1);
  assert.deepEqual(library.pruneMissingTracks(undefined, roots), { checked: 1, removed: 0, offline: 1 });
  assert.equal(ids([onUsb]).length, 1);
}

// 2. A junction/symlink inside the root pointing at a share that is offline.
let linked = false;
{
  const link = join(music, 'NAS');
  try {
    symlinkSync(nasTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch (err) {
    console.warn(`[library-prune-safety-test] skipping the junction case: ${err.message}`);
  }
  if (linked) {
    const onNas = join(link, 'nas-song.flac');
    await writeFile(join(nasTarget, 'nas-song.flac'), 'x');
    library.upsertTracks([reading(onNas, Number(statSync(nasTarget).dev))]);
    await rm(nasTarget, { recursive: true, force: true }); // the share goes away; the junction dangles
    assert.equal(library.previewPruneMissingTracks(undefined, roots).tracks, 0, 'a dangling junction is offline, not deleted');
    assert.equal(library.pruneMissingTracks(undefined, roots).removed, 0);
    assert.equal(ids([onNas]).length, 1);
    mkdirSync(nasTarget, { recursive: true });
    // Back, but the file itself deleted: a linked folder still isn't proof.
    assert.equal(library.pruneMissingTracks(undefined, roots).removed, 0);
  }
}

// 3. Real deletions on reachable storage are still removed, with a preview
//    that counts exactly what goes.
{
  const deletedFile = join(music, 'Artist', 'Album', 'deleted.flac');
  const inDeletedFolder = join(music, 'Artist', 'Gone Album', 'track.flac');
  const survivor = join(music, 'Artist', 'Album', 'survivor.flac');
  await writeFile(deletedFile, 'x');
  await writeFile(survivor, 'x');
  await mkdir(join(music, 'Artist', 'Gone Album'));
  await writeFile(inDeletedFolder, 'x');
  library.upsertTracks([reading(deletedFile, rootDev), reading(inDeletedFolder, rootDev), reading(survivor, rootDev)]);
  const [deletedId, folderId] = ids([deletedFile, inDeletedFolder]);
  library.recordPlay(deletedId);
  library.recordPlay(deletedId);
  library.recordPlay(folderId);
  library.recordSkip(folderId);
  library.saveTrackBookmark({ trackId: deletedId, position: 10, label: 'Here' });
  library.applyManualMetadataPatch(deletedId, { title: 'Edited', genre: 'Edited' });
  const list = library.savePlaylist({ name: 'Mixed', trackIds: [deletedId, folderId, deletedId] });
  await rm(deletedFile);
  await rm(join(music, 'Artist', 'Gone Album'), { recursive: true });

  const preview = library.previewPruneMissingTracks(undefined, roots);
  assert.deepEqual(
    { tracks: preview.tracks, plays: preview.plays, skips: preview.skips, playlistEntries: preview.playlistEntries, bookmarks: preview.bookmarks, edits: preview.edits },
    { tracks: 2, plays: 3, skips: 1, playlistEntries: 3, bookmarks: 1, edits: 2 },
  );
  assert.equal(ids([deletedFile, inDeletedFolder]).length, 2, 'the preview deletes nothing');
  const result = library.pruneMissingTracks(undefined, roots);
  assert.equal(result.removed, preview.tracks, 'the removal matches the preview');
  assert.equal(result.offline, preview.offline);
  assert.equal(ids([deletedFile, inDeletedFolder]).length, 0);
  assert.equal(library.getPlaylistTracks(list.id).length, 0);
  assert.equal(ids([survivor]).length, 1);
}

// 4. Tracks scanned before devices were recorded: root device, populated
//    folder strictly inside the root, or they are kept.
{
  const legacyDeleted = join(music, 'Artist', 'Album', 'legacy.flac');
  const legacyOnMountPoint = join(root, 'empty-mount', 'legacy-top.flac');
  await mkdir(join(root, 'empty-mount'));
  library.upsertTracks([reading(legacyDeleted, null), reading(legacyOnMountPoint, null)]);
  const legacyRoots = [music, join(root, 'empty-mount')];
  const result = library.pruneMissingTracks(undefined, legacyRoots);
  assert.equal(ids([legacyDeleted]).length, 0, 'a legacy track missing from a populated folder is removable');
  assert.equal(ids([legacyOnMountPoint]).length, 1, 'a legacy track directly in an empty mount point is kept');
  assert.equal(result.removed, 1);
}

// 6. A drive letter or mount point now used by a different volume that has
//    the same folder names. The track's own folder is there, real and
//    populated, but on another device than the one the track was scanned
//    on: it isn't the track's folder, so the file is not proven deleted.
{
  const reusedAlbum = join(music, 'Reused', 'Album');
  await mkdir(reusedAlbum, { recursive: true });
  await writeFile(join(reusedAlbum, 'what-the-other-volume-has.flac'), 'x');
  const scannedElsewhere = join(reusedAlbum, 'scanned-on-the-old-volume.flac');
  library.upsertTracks([reading(scannedElsewhere, otherDev)]);
  const scope = [join(music, 'Reused')];
  const preview = library.previewPruneMissingTracks(scope, roots);
  assert.equal(preview.tracks, 0, 'a populated folder on another device is not proof the file was deleted');
  assert.equal(preview.offline, 1);
  assert.equal(library.pruneMissingTracks(scope, roots).removed, 0);
  assert.equal(ids([scannedElsewhere]).length, 1);
}

// 7. Tracks under no configured root. Renaming the library folder and
//    pointing the root at the new name leaves every track under the old name
//    with no root, and the nearest folder still there is somewhere above the
//    library (in real life often the drive itself), which proves nothing
//    about the files. They are kept, history and all, device recorded or not.
{
  const oldName = join(root, 'Old Library');
  const newName = join(root, 'New Library');
  await mkdir(join(oldName, 'Artist', 'Album'), { recursive: true });
  const song = join(oldName, 'Artist', 'Album', 'song.flac');
  const legacySong = join(oldName, 'Artist', 'Album', 'legacy-song.flac');
  await writeFile(song, 'x');
  await writeFile(legacySong, 'x');
  library.upsertTracks([reading(song, Number(statSync(oldName).dev)), reading(legacySong, null)]);
  const [songId] = ids([song]);
  library.recordPlay(songId);
  library.recordPlay(songId);
  await rename(oldName, newName);
  for (const configured of [[newName], []]) {
    const preview = library.previewPruneMissingTracks([oldName], configured);
    assert.equal(preview.tracks, 0, `tracks under no root are not deletable (roots: [${configured.join(', ')}])`);
    assert.equal(preview.offline, 2);
    assert.equal(library.pruneMissingTracks([oldName], configured).removed, 0);
  }
  assert.equal(library.getTrack(songId).playCount, 2, 'the history stays');

  // A file opened from outside the library and later deleted, whose own
  // folder is still there on the same device, is still removable, whether
  // that folder has other things in it or is now empty.
  const downloads = join(root, 'Downloads');
  await mkdir(downloads, { recursive: true });
  await writeFile(join(downloads, 'still-here.flac'), 'x');
  const openedOnce = join(downloads, 'opened-once.flac');
  library.upsertTracks([reading(openedOnce, Number(statSync(downloads).dev))]);
  assert.equal(library.pruneMissingTracks([downloads], roots).removed, 1);
  const emptied = join(root, 'Emptied');
  await mkdir(emptied, { recursive: true });
  const lastOne = join(emptied, 'last-one.flac');
  await writeFile(lastOne, 'x');
  library.upsertTracks([reading(lastOne, Number(statSync(lastOne).dev))]);
  await rm(lastOne);
  assert.equal(library.pruneMissingTracks([emptied], roots).removed, 1, 'its own folder, empty now, still speaks for it');
}
library.close();

// 5. The wiring around it: main backs up before removing and deletes nothing
//    if that fails; the Library view previews, asks, and recovers from errors.
const [mainSource, preloadSource, viewSource] = await Promise.all([
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
]);
const pruneHandler = mainSource.slice(
  mainSource.indexOf("ipcMain.handle('library:prune-missing',"),
  mainSource.indexOf("ipcMain.handle('history:get'"),
);
assert.ok(pruneHandler.includes('createBackupFromLiveStores'), 'the prune IPC takes a backup');
assert.ok(
  pruneHandler.indexOf('createBackupFromLiveStores') < pruneHandler.lastIndexOf('pruneMissingTracks('),
  'the backup comes before the deleting call',
);
assert.match(mainSource, /ipcMain\.handle\('library:prune-missing-preview'/);
assert.match(preloadSource, /previewPruneMissingTracks/);
const check = viewSource.slice(viewSource.indexOf('async function checkMissingFiles'), viewSource.indexOf('async function removeMissingFiles'));
const remove = viewSource.slice(viewSource.indexOf('async function removeMissingFiles'), viewSource.indexOf('async function createDuplicateReviewPlaylist'));
assert.match(check, /previewPruneMissingTracks/, 'the button previews first');
assert.doesNotMatch(check, /pruneMissingTracks\(/, 'previewing never deletes');
assert.match(check, /catch \(error\)/, 'a failed check reports instead of hanging on "Checking file paths..."');
assert.match(remove, /catch \(error\)/, 'a failed removal reports instead of hanging');
assert.match(viewSource, /onConfirmPrune=\{\(\) => void removeMissingFiles\(\)\}/, 'removal only runs from the confirmation');

await rm(root, { recursive: true, force: true });
console.log(`[library-prune-safety-test] ok: unmounted sub-mounts${linked ? ' and dangling junctions' : ''} are kept; real deletions preview and remove exactly`);
