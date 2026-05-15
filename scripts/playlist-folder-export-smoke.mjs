import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPlaylistFolder } from '../dist-electron/electron/playlist-export.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'playlist-folder-export-smoke');
const musicRoot = join(smokeRoot, 'music');
const exportRoot = join(smokeRoot, 'exports');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });
await mkdir(exportRoot, { recursive: true });

const firstPath = join(musicRoot, '01-road-song.mp3');
const secondPath = join(musicRoot, '02-b-side.flac');
const missingPath = join(musicRoot, '03-missing.ogg');

await writeFile(firstPath, 'first audio fixture');
await writeFile(secondPath, 'second audio fixture');

const playlist = {
  id: 42,
  name: 'Road / USB: Set',
  trackCount: 3,
  duration: 555,
  hasCoverArt: 0,
  coverArtUpdatedAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const tracks = [
  trackFixture(1, firstPath, 'Road Song', 'Portable Fixture', 180),
  trackFixture(2, secondPath, 'B:Side?', 'Portable Fixture', 195),
  trackFixture(3, missingPath, 'Missing Cut', 'Portable Fixture', 180),
];

const result = await exportPlaylistFolder({ playlist, tracks, destinationRoot: exportRoot });
assert.equal(result.copied, 2, 'export should copy existing playlist tracks');
assert.deepEqual(result.skipped, [missingPath], 'export should report missing tracks without aborting the folder');
assert.ok(result.bytes >= 36, 'export should report copied bytes');
assert.match(result.path, /Road USB Set$/, 'export should create a safe playlist-named folder');
assert.match(result.playlistPath, /playlist\.m3u8$/, 'export should write a relative M3U8 file');

const exportedFiles = await readdir(result.path);
assert.ok(exportedFiles.includes('playlist.m3u8'), 'export folder should include a playlist.m3u8');
assert.ok(exportedFiles.some((file) => file.startsWith('001 - Portable Fixture - Road Song') && file.endsWith('.mp3')));
assert.ok(exportedFiles.some((file) => file.startsWith('002 - Portable Fixture - B Side') && file.endsWith('.flac')));
const exportedMp3 = exportedFiles.find((file) => file.endsWith('.mp3'));
assert.ok(exportedMp3, 'export folder should include the copied MP3');
assert.equal(String(await readFile(join(result.path, exportedMp3))), 'first audio fixture');

const playlistText = await readFile(result.playlistPath, 'utf8');
assert.match(playlistText, /^#EXTM3U/m);
assert.match(playlistText, /#PLAYLIST:Road \/ USB: Set/);
assert.match(playlistText, /#EXTINF:180,Portable Fixture - Road Song/);
assert.doesNotMatch(playlistText, /tmp[\\/].*playlist-folder-export-smoke/, 'M3U8 should use relative copied file names');
assert.doesNotMatch(playlistText, /Missing Cut/, 'M3U8 should omit missing tracks');

const second = await exportPlaylistFolder({ playlist, tracks: tracks.slice(0, 1), destinationRoot: exportRoot });
assert.match(second.path, /Road USB Set-2$/, 'repeat exports should not overwrite a previous export folder');
assert.equal((await stat(second.playlistPath)).isFile(), true);

const [typesSource, mainSource, preloadSource, apiSource, playlistViewSource, packageSource, releaseGateSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/PlaylistView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /PlaylistFolderExportResult/, 'shared API should expose folder export results');
assert.match(typesSource, /exportPlaylistFolder/, 'shared API should expose playlist folder export');
assert.match(typesSource, /ExportTracksFolderInput/, 'shared API should expose queue folder export input');
assert.match(typesSource, /exportTracksFolder/, 'shared API should expose arbitrary track folder export');
assert.match(mainSource, /playlist:export-folder/, 'main process should register playlist folder export IPC');
assert.match(mainSource, /playlist:export-tracks-folder/, 'main process should register queue folder export IPC');
assert.match(mainSource, /normalizeExportFolderName/, 'main process should normalize ad-hoc export folder names');
assert.match(mainSource, /choosePlaylistFolderExportRoot/, 'main process should use a native folder picker');
assert.match(preloadSource, /exportPlaylistFolder/, 'preload should expose playlist folder export');
assert.match(preloadSource, /exportTracksFolder/, 'preload should expose queue folder export');
assert.match(apiSource, /exportPlaylistFolder/, 'browser-safe API should include playlist folder export');
assert.match(apiSource, /exportTracksFolder/, 'browser-safe API should include queue folder export');
assert.match(playlistViewSource, /EXPORT FOLDER/, 'Playlists view should expose portable folder export');
assert.match(playlistViewSource, /EXPORT QUEUE FOLDER/, 'Playlists view should export the active queue as a folder');
assert.match(playlistViewSource, /api\.exportTracksFolder/, 'Playlists view should use the queue folder export API');
assert.match(playlistViewSource, /queueExportName/, 'Playlists view should name ad-hoc queue folder exports');
assert.match(packageSource, /smoke:playlist-folder-export/, 'package scripts should expose folder export smoke');
assert.match(releaseGateSource, /smoke:playlist-folder-export/, 'release gate should cover folder export smoke');

console.log(JSON.stringify({ ok: true, result, files: exportedFiles }, null, 2));

function trackFixture(id, path, title, artist, duration) {
  return {
    id,
    path,
    title,
    artist,
    album: 'Portable Sets',
    albumArtist: artist,
    trackNo: id,
    discNo: null,
    year: 2026,
    genre: 'Fixture',
    duration,
    bitrate: 320000,
    sampleRate: 44100,
    size: null,
    mtime: Date.now(),
    hasArt: 0,
    loved: 0,
    rating: 0,
    playCount: 0,
    lastPlayed: null,
    skipCount: 0,
    lastSkipped: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
  };
}
