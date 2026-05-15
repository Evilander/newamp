import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'playlist-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const paths = [
  join(musicRoot, '01-radio-city.mp3'),
  join(musicRoot, '02-windowshade.flac'),
  join(musicRoot, '03-milkdrop.ogg'),
];
const coverPath = join(smokeRoot, 'road-test-cover.png');

for (const path of paths) await writeFile(path, '');
await writeFile(
  coverPath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIAgDZF4gAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const library = await LibraryStore.open(dbPath);
library.upsertTracks(paths.map((path, index) => ({
  path,
  title: ['Radio City', 'Windowshade', 'Milkdrop'][index],
  artist: 'Newamp Playlist Fixture',
  album: 'Durable Sets',
  albumArtist: 'Newamp Playlist Fixture',
  trackNo: index + 1,
  discNo: null,
  year: 2026,
  genre: 'Fixture',
  duration: 180 + index,
  bitrate: 320000,
  sampleRate: 44100,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 0,
  mtime: Date.now(),
  art: null,
})));

const tracks = library.getTracks({ sort: 'album', limit: 10 });
assert.equal(tracks.length, 3, 'fixture tracks should be available');

const saved = library.savePlaylist({
  name: 'Road Test',
  trackIds: [tracks[1].id, tracks[0].id, tracks[2].id],
  coverImagePath: coverPath,
});
assert.equal(saved.name, 'Road Test');
assert.equal(saved.trackCount, 3);
assert.ok(saved.duration >= 543);
assert.equal(saved.hasCoverArt, 1);
assert.ok(saved.coverArtUpdatedAt && saved.coverArtUpdatedAt > 0);

const cover = library.getPlaylistCover(saved.id);
assert.equal(cover?.mime, 'image/png');
assert.ok(cover && cover.data.byteLength > 0, 'saved playlist cover should be readable');

const listed = library.getPlaylists();
assert.equal(listed.length, 1, 'saved playlist should be listed');
assert.equal(listed[0].id, saved.id);
assert.equal(listed[0].trackCount, 3);
assert.equal(listed[0].hasCoverArt, 1);

const empty = library.savePlaylist({
  name: 'Empty Icon Set',
  trackIds: [],
  coverImagePath: coverPath,
});
assert.equal(empty.trackCount, 0, 'users should be able to create an empty named playlist');
assert.equal(empty.hasCoverArt, 1, 'empty playlists should still support custom icons');
assert.equal(library.getPlaylistTracks(empty.id).length, 0, 'empty playlists should persist without tracks');
assert.equal(library.getPlaylistCover(empty.id)?.mime, 'image/png');
library.deletePlaylist(empty.id);

const duplicateNamed = library.savePlaylist({
  name: 'Road Test',
  trackIds: [tracks[0].id],
});
assert.notEqual(duplicateNamed.id, saved.id, 'new playlists with an existing name should not overwrite the original');
assert.equal(duplicateNamed.name, 'Road Test 2');
assert.deepEqual(
  library.getPlaylistTracks(saved.id).map((track) => track.title),
  ['Windowshade', 'Radio City', 'Milkdrop'],
  'duplicate-name saves should preserve the original playlist contents',
);
library.deletePlaylist(duplicateNamed.id);

const ordered = library.getPlaylistTracks(saved.id);
assert.deepEqual(ordered.map((track) => track.title), ['Windowshade', 'Radio City', 'Milkdrop']);

const appendTarget = library.savePlaylist({
  name: 'Append Target',
  trackIds: [tracks[2].id],
});
const appended = library.addTracksToPlaylist({
  playlistId: appendTarget.id,
  trackIds: [tracks[0].id, 0, tracks[1].id],
});
assert.equal(appended?.trackCount, 3, 'direct playlist appends should skip invalid track ids');
assert.deepEqual(
  library.getPlaylistTracks(appendTarget.id).map((track) => track.title),
  ['Milkdrop', 'Radio City', 'Windowshade'],
  'direct playlist appends should preserve existing entries and append new tracks in order',
);
library.deletePlaylist(appendTarget.id);

const m3u = library.exportPlaylistM3u(saved.id);
assert.match(m3u, /^#EXTM3U/m, 'M3U export should include the header');
assert.match(m3u, /#PLAYLIST:Road Test/, 'M3U export should include playlist name');
assert.ok(m3u.indexOf(paths[1]) < m3u.indexOf(paths[0]), 'M3U export should preserve order');

const pls = library.exportPlaylistPls(saved.id);
assert.match(pls, /^\[playlist\]/m, 'PLS export should include the playlist header');
assert.match(pls, /NumberOfEntries=3/, 'PLS export should include entry count');
assert.match(pls, /File1=/, 'PLS export should include numbered file paths');
assert.match(pls, /Title1=Newamp Playlist Fixture - Windowshade/, 'PLS export should include numbered titles');
assert.ok(pls.indexOf(paths[1]) < pls.indexOf(paths[0]), 'PLS export should preserve order');

const imported = library.importPlaylistM3u({
  name: 'Imported Road Test',
  content: m3u,
});
assert.equal(imported.playlist.trackCount, 3);
assert.equal(imported.matched, 3);
assert.equal(imported.skipped, 0);

const importedTracks = library.getPlaylistTracks(imported.playlist.id);
assert.deepEqual(importedTracks.map((track) => track.title), ['Windowshade', 'Radio City', 'Milkdrop']);

const importedPls = library.importPlaylistM3u({
  name: 'Imported PLS Road Test',
  content: [
    '[playlist]',
    'NumberOfEntries=3',
    `File1=${paths[2]}`,
    'Title1=Milkdrop',
    'Length1=182',
    `File2=${paths[0]}`,
    'Title2=Radio City',
    'Length2=180',
    `File3=${paths[1]}`,
    'Title3=Windowshade',
    'Length3=181',
    'Version=2',
    '',
  ].join('\n'),
});
assert.equal(importedPls.playlist.trackCount, 3);
assert.equal(importedPls.matched, 3);
assert.equal(importedPls.skipped, 0);
assert.deepEqual(
  library.getPlaylistTracks(importedPls.playlist.id).map((track) => track.title),
  ['Milkdrop', 'Radio City', 'Windowshade'],
);

const updated = library.savePlaylist({
  id: saved.id,
  name: 'Road Test Edited',
  trackIds: [tracks[2].id],
});
assert.equal(updated.trackCount, 1);
assert.equal(updated.hasCoverArt, 1, 'updating tracks should preserve playlist cover art');
assert.deepEqual(library.getPlaylistTracks(saved.id).map((track) => track.title), ['Milkdrop']);

const cleared = library.savePlaylist({
  id: saved.id,
  name: 'Road Test Edited',
  trackIds: [tracks[2].id],
  clearCoverImage: true,
});
assert.equal(cleared.hasCoverArt, 0, 'clearCoverImage should remove the playlist icon');
assert.equal(library.getPlaylistCover(saved.id), null);

library.deletePlaylist(saved.id);
assert.equal(library.getPlaylistTracks(saved.id).length, 0);
assert.equal(library.getPlaylists().some((playlist) => playlist.id === saved.id), false);

library.close();

const [
  typesSource,
  preloadSource,
  apiSource,
  playlistViewSource,
  libraryViewSource,
  albumsViewSource,
  artistsViewSource,
  lovedViewSource,
  sidebarSource,
  quickPlaySource,
  mainSource,
] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/PlaylistView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/AlbumsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/ArtistsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/LovedView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/QuickPlayPalette.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
]);

assert.match(typesSource, /coverImagePath/, 'shared save playlist input should carry a selected cover image path');
assert.match(typesSource, /hasCoverArt/, 'shared playlist model should expose playlist cover state');
assert.match(preloadSource, /pickPlaylistCoverImage/, 'preload should expose playlist cover picker');
assert.match(apiSource, /getPlaylistCoverUrl/, 'renderer API should expose playlist cover URLs');
assert.match(sidebarSource, /label: 'Playlists'/, 'sidebar should make Playlists first-class');
assert.match(quickPlaySource, /title: 'Playlists'/, 'Quick Play should open the Playlists view by name');
assert.match(playlistViewSource, /Playlist icon/, 'Now Queue should expose playlist icon controls');
assert.match(playlistViewSource, /Insert image/, 'Now Queue should let users insert a playlist image');
assert.match(playlistViewSource, /CREATE EMPTY PLAYLIST/, 'Playlists view should allow creating an empty named playlist');
assert.match(playlistViewSource, /SAVE QUEUE AS PLAYLIST/, 'Playlists view should frame queue saves as playlist creation');
assert.match(playlistViewSource, /UPDATE PLAYLIST/, 'Now Queue should frame selected saves as playlist edits');
assert.match(playlistViewSource, /EXPORT PLS/, 'Now Queue should expose PLS export for Winamp playlist compatibility');
assert.match(mainSource, /newplaylistart/, 'main process should register a playlist art protocol');
assert.match(mainSource, /\.pls/, 'main process should import and open PLS playlists');
assert.match(preloadSource, /exportPlaylistPls/, 'preload should expose PLS export');
assert.match(typesSource, /exportPlaylistPls/, 'shared API should expose PLS export');
assert.match(typesSource, /addTracksToPlaylist/, 'shared API should expose direct saved-playlist appends');
assert.match(mainSource, /playlist:add-tracks/, 'main process should register direct playlist append IPC');
assert.match(preloadSource, /addTracksToPlaylist/, 'preload should expose direct playlist appends');
assert.match(apiSource, /addTracksToPlaylist/, 'browser-safe API should include direct playlist appends');
assert.match(libraryViewSource, /Add to playlist/, 'track tables should expose saved-playlist append controls');
assert.match(libraryViewSource, /PlaylistAppendPicker/, 'Library view should export a bulk saved-playlist append control');
assert.match(libraryViewSource, /ADD SELECTED TO PLAYLIST/, 'track tables should append selected rows to saved playlists');
assert.match(libraryViewSource, /SAVE SELECTED AS PLAYLIST/, 'track tables should create a new named playlist from selected rows');
assert.match(libraryViewSource, /New playlist name/, 'track tables should let users name selected-row playlists before saving');
assert.match(libraryViewSource, /selectedIds/, 'track tables should maintain multi-row selection state');
assert.match(albumsViewSource, /ADD ALBUM TO PLAYLIST/, 'Albums view should append full albums to saved playlists');
assert.match(artistsViewSource, /ADD ARTIST TO PLAYLIST/, 'Artists view should append full artist selections to saved playlists');
assert.match(lovedViewSource, /ADD LOVED TO PLAYLIST/, 'Loved view should append all loved tracks to saved playlists');

console.log(JSON.stringify({
  ok: true,
  saved,
  imported: imported.playlist,
  m3uLines: m3u.split(/\r?\n/).filter(Boolean).length,
}, null, 2));
