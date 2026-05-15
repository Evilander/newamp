import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'open-files-smoke');
const musicRoot = join(smokeRoot, 'music');
const folderDropRoot = join(smokeRoot, 'folder-drop');
const dbPath = join(smokeRoot, 'library.db');
const audioPath = join(musicRoot, 'Explorer Launch.flac');
const folderTrackA = join(folderDropRoot, '01 Anywhere Drop.mp3');
const folderTrackB = join(folderDropRoot, 'Disc 2', '02 Folder Drop.wav');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });
await mkdir(join(folderDropRoot, 'Disc 2'), { recursive: true });
await writeFile(audioPath, '');
await writeFile(folderTrackA, '');
await writeFile(folderTrackB, '');

const library = await LibraryStore.open(dbPath);
library.upsertTracks([
  {
    path: audioPath,
    title: 'Explorer Launch',
    artist: 'Newamp Smoke',
    album: 'Shell',
    albumArtist: 'Newamp Smoke',
    trackNo: 1,
    discNo: null,
    year: 2026,
    genre: 'Test',
    duration: 123,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 0,
    mtime: Date.now(),
    art: null,
  },
  {
    path: folderTrackA,
    title: 'Anywhere Drop',
    artist: 'Newamp Smoke',
    album: 'Drop Folder',
    albumArtist: 'Newamp Smoke',
    trackNo: 1,
    discNo: 1,
    year: 2026,
    genre: 'Test',
    duration: 111,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 0,
    mtime: Date.now(),
    art: null,
  },
  {
    path: folderTrackB,
    title: 'Folder Drop',
    artist: 'Newamp Smoke',
    album: 'Drop Folder',
    albumArtist: 'Newamp Smoke',
    trackNo: 2,
    discNo: 2,
    year: 2026,
    genre: 'Test',
    duration: 112,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 0,
    mtime: Date.now(),
    art: null,
  },
]);

const resolved = library.getTracksByPaths([audioPath.replace(/\\/g, '/')]);
assert.equal(resolved.length, 1, 'library should resolve open-with paths after scan');
assert.equal(resolved[0].title, 'Explorer Launch');

const folderTracks = library.getFolderTracks(folderDropRoot, { recursive: true, limit: 10 });
assert.deepEqual(
  folderTracks.map((track) => track.title).sort(),
  ['Anywhere Drop', 'Folder Drop'],
  'recursive folder track lookup should support dropped folders',
);
library.close();

const [pkg, sharedTypes, mainSource, preloadSource, apiSource, appSource, libraryViewSource, nowPlayingSource, releaseGateSource] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
]);

const associations = pkg.build?.fileAssociations ?? [];
assert.ok(Array.isArray(associations) && associations.length >= 2, 'installer should register audio and playlist associations');
assert.ok(
  associations.some((item) => Array.isArray(item.ext) && item.ext.includes('mp3') && item.ext.includes('flac')),
  'installer should associate common audio formats',
);
assert.ok(
  associations.some((item) => Array.isArray(item.ext) && item.ext.includes('m3u') && item.ext.includes('m3u8') && item.ext.includes('pls')),
  'installer should associate M3U and PLS playlists',
);

assert.match(sharedTypes, /OpenFilesResult/, 'shared API should expose open-file results');
assert.match(sharedTypes, /getDroppedFilePaths/, 'shared API should expose safe dropped path resolution');
assert.match(mainSource, /requestSingleInstanceLock/, 'main process should enforce single-instance open-with delivery');
assert.match(mainSource, /open:consume-pending-files/, 'main process should expose pending launch files');
assert.match(mainSource, /open:files/, 'main process should scan and resolve opened files');
assert.match(mainSource, /normalizeOpenTargets/, 'main process should normalize opened files and dropped folders');
assert.match(mainSource, /folderPaths/, 'main process should handle dropped folders');
assert.match(mainSource, /getFolderTracks\(folderPath/, 'main process should resolve tracks from dropped folders');
assert.match(mainSource, /app:open-files/, 'main process should push second-instance files to the renderer');
assert.match(mainSource, /NEWAMP_UI_OPEN_FILE_SMOKE/, 'main process should support packaged open-file UI proof');
assert.match(mainSource, /newamp-ui-open-file-smoke/, 'main process should emit packaged open-file smoke results');
assert.match(mainSource, /os:show-in-folder/, 'main process should register Explorer reveal IPC');
assert.match(preloadSource, /consumePendingOpenFiles/, 'preload should expose pending file consumption');
assert.match(preloadSource, /webUtils\.getPathForFile/, 'preload should use Electron webUtils for dropped file paths');
assert.match(preloadSource, /getDroppedFilePaths/, 'preload should expose dropped path resolution');
assert.match(apiSource, /openFiles/, 'renderer API should expose openFiles');
assert.match(apiSource, /showInFolder/, 'renderer API should expose Explorer reveal actions');
assert.match(apiSource, /getDroppedFilePaths/, 'browser-safe API should include dropped path fallback');
assert.match(appSource, /handleOpenFiles/, 'App should consume open-with paths');
assert.match(appSource, /data-newamp-drop-zone/, 'App should expose an app-wide drop zone');
assert.match(appSource, /data-newamp-app-drop-overlay/, 'App should render a visible drop overlay');
assert.match(appSource, /setView\('now-playing'\)/, 'App should switch to Now Playing after opening playable files');
assert.match(libraryViewSource, /getDroppedFilePaths/, 'Library drag-drop should use preload path resolution');
assert.match(libraryViewSource, /data-show-in-folder/, 'Library rows should expose a file reveal control');
assert.match(libraryViewSource, /api\.showInFolder\(t\.path\)/, 'Library file reveal should open the selected track path');
assert.match(nowPlayingSource, /data-now-playing-show-in-folder/, 'Now Playing should expose a current-track file reveal control');
assert.match(nowPlayingSource, /api\.showInFolder\(current\.path\)/, 'Now Playing file reveal should open the current track path');
assert.match(JSON.stringify(pkg.scripts ?? {}), /smoke:packaged-open-files/, 'package scripts should expose packaged open-file proof');
assert.match(releaseGateSource, /smoke:open-files/, 'release gate should include open/drop file wiring smoke');

console.log(JSON.stringify({
  ok: true,
  resolved: resolved.map((track) => track.title),
  folderTracks: folderTracks.map((track) => track.title),
  associations: associations.map((item) => item.ext),
}, null, 2));
