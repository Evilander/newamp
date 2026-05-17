import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'folder-browser-smoke');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });

const library = await LibraryStore.open(dbPath);
try {
  library.upsertTracks([
    fixture('K:\\music\\Root Song.mp3', 'Root Song', 1, null),
    fixture('K:\\music\\Artist A\\Album A\\01 - One.mp3', 'One', 2, {
      mime: 'image/png',
      data: Buffer.from('folder-art'),
    }),
    fixture('K:\\music\\Artist A\\Album A\\02 - Two.mp3', 'Two', 3, null),
    fixture('K:\\music\\Artist B\\Singles\\01 - Single.flac', 'Single', 4, null),
    fixture('L:\\incoming\\Loose\\Other.mp3', 'Other', 5, null),
  ]);

  const roots = library.getFolders(null, ['K:/music']);
  assert.equal(roots.length, 1, 'configured roots should filter the folder browser to library roots');
  assert.equal(roots[0].path, 'K:\\music');
  assert.equal(roots[0].trackCount, 1, 'root summary should count direct tracks');
  assert.equal(roots[0].totalTrackCount, 4, 'root summary should count descendant tracks');
  assert.equal(roots[0].childFolderCount, 2, 'root summary should count immediate child folders');

  const children = library.getFolders('K:/music', ['K:/music']);
  assert.deepEqual(children.map((folder) => folder.name), ['Artist A', 'Artist B']);
  assert.equal(children[0].totalTrackCount, 2, 'child folder should include descendant album tracks');
  assert.equal(children[0].childFolderCount, 1, 'artist folder should expose album child folder');
  assert.ok(children[0].artFromTrackId, 'folder summary should expose descendant album art');

  const albumTracks = library.getFolderTracks('K:/music/Artist A/Album A', { recursive: false });
  assert.deepEqual(albumTracks.map((track) => track.title), ['One', 'Two']);

  const recursiveArtistTracks = library.getFolderTracks('K:/music/Artist A', { recursive: true });
  assert.deepEqual(recursiveArtistTracks.map((track) => track.title), ['One', 'Two']);
  const recursiveArtistTrackIds = library.getFolderTrackIds('K:/music/Artist A', { recursive: true });
  assert.deepEqual(
    recursiveArtistTrackIds,
    recursiveArtistTracks.map((track) => track.id),
    'folder playlist append should be able to fetch ordered ids without serializing full tracks',
  );

  const directArtistTracks = library.getFolderTracks('K:/music/Artist A', { recursive: false });
  assert.equal(directArtistTracks.length, 0, 'direct folder tracks should not include child albums');

  const derivedRoots = library.getFolders(null, []);
  assert.deepEqual([...derivedRoots.map((folder) => folder.path)].sort(), ['K:\\music', 'L:\\incoming']);

  const [typesSource, mainSource, preloadSource, apiSource, appSource, sidebarSource, foldersViewSource, packageSource] =
    await Promise.all([
      readText('../shared/types.ts'),
      readText('../electron/main.ts'),
      readText('../electron/preload.ts'),
      readText('../src/lib/api.ts'),
      readText('../src/App.tsx'),
      readText('../src/components/Sidebar.tsx'),
      readText('../src/components/views/FoldersView.tsx'),
      readText('../package.json'),
    ]);
  assert.match(typesSource, /FolderSummary/, 'shared types should expose folder summaries');
  assert.match(typesSource, /getFolderTracks/, 'NewAmpAPI should expose folder track lookup');
  assert.match(typesSource, /getFolderTrackIds/, 'NewAmpAPI should expose folder track id lookup');
  assert.match(mainSource, /library:get-folders/, 'main process should register folder IPC');
  assert.match(preloadSource, /library:get-folder-tracks/, 'preload should bridge folder tracks');
  assert.match(preloadSource, /library:get-folder-track-ids/, 'preload should bridge folder track ids');
  assert.match(apiSource, /getFolders: async/, 'browser stub should include folder APIs');
  assert.match(appSource, /FoldersView/, 'App should route to the Folders view');
  assert.match(sidebarSource, /Folders/, 'Sidebar should include Folders navigation');
  assert.match(foldersViewSource, /PLAY FOLDER/, 'Folders view should play whole folders');
  assert.match(foldersViewSource, /ADD FOLDER TO PLAYLIST/, 'Folders view should append folders to saved playlists');
  assert.match(foldersViewSource, /api\.getFolderTrackIds/, 'Folders view should append large folders by id instead of full track rows');
  const librarySource = await readText('../electron/library.ts');
  assert.match(librarySource, /queryFolderTrackRows/, 'folder track lookup should share a bounded query path');
  assert.match(librarySource, /WHERE lower\(replace\(path, '\/', '\\\\'\)\) LIKE \?/, 'folder track lookup should prefilter by normalized path in SQL');
  assert.doesNotMatch(librarySource, /getFolderTracks[\s\S]+SELECT \* FROM tracks`\)[\s\S]+filter\(\(row\) => trackPathIsInFolder/, 'folder track lookup should not scan every track before filtering');
  assert.match(packageSource, /smoke:folders/, 'package scripts should expose folder browser smoke');

  console.log(JSON.stringify({
    ok: true,
    roots: roots.length,
    rootTracks: roots[0].totalTrackCount,
    childFolders: children.length,
    recursiveArtistTracks: recursiveArtistTracks.length,
    recursiveArtistTrackIds: recursiveArtistTrackIds.length,
  }, null, 2));
} finally {
  library.close();
}

function fixture(path, title, trackNo, art) {
  return {
    path,
    title,
    artist: path.includes('Artist B') ? 'Artist B' : 'Artist A',
    album: path.includes('Album A') ? 'Album A' : 'Singles',
    albumArtist: path.includes('Artist B') ? 'Artist B' : 'Artist A',
    trackNo,
    discNo: null,
    year: 2026,
    genre: 'Smoke',
    duration: 60 * trackNo,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1000 + trackNo,
    mtime: 2000 + trackNo,
    art,
  };
}

async function readText(relativePath) {
  return import('node:fs/promises').then((fs) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8'));
}
