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
  assert.deepEqual(
    library.getFolderTracks('K:/music/Artist A/Album A', { recursive: false, limit: 1, offset: 1 }).map((track) => track.title),
    ['Two'],
    'direct folder track paging should honor offsets',
  );

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

  library.upsertTracks([
    fixture('K:\\music\\100% Exact\\01 - Percent Song.mp3', 'Percent Song', 6, null),
    fixture('K:\\music\\100X Exact\\01 - Decoy Song.mp3', 'Decoy Song', 7, null),
  ]);
  assert.deepEqual(
    library.getFolderTracks('K:/music/100% Exact', { recursive: true }).map((track) => track.title),
    ['Percent Song'],
    'folder lookup should treat percent signs as literal path characters',
  );
  assert.deepEqual(
    library.getFolderTrackIds('K:/music/100% Exact', { recursive: true }),
    library.getFolderTracks('K:/music/100% Exact', { recursive: true }).map((track) => track.id),
    'folder id lookup should use the same bounded literal path matching',
  );

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
  assert.match(foldersViewSource, /FOLDER_TRACK_LIMIT/, 'Folders view should centralize direct-track page size');
  const folderTrackLimit = foldersViewSource.match(/const FOLDER_TRACK_LIMIT = (\d+)/);
  assert.ok(Number(folderTrackLimit?.[1] ?? 9999) <= 800, 'Folders view should keep direct-track DOM pages light');
  assert.match(foldersViewSource, /hasMoreDirectTracks/, 'Folders view should track when direct folder tracks are paged');
  assert.match(foldersViewSource, /const offset = tracks\.length/, 'Folders view should page direct folder tracks by loaded row count');
  assert.match(foldersViewSource, /Load more direct tracks/, 'Folders view should expose explicit direct-track pagination');
  const librarySource = await readText('../electron/library.ts');
  assert.match(librarySource, /queryFolderTrackRows/, 'folder track lookup should share a bounded query path');
  assert.match(librarySource, /queryFolderRows/, 'folder track lookup should stream through the shared cursor path');
  assert.match(librarySource, /LIKE \? ESCAPE '\|'/, 'folder track lookup should escape LIKE wildcard characters in paths');
  assert.match(librarySource, /while \(stmt\.step\(\)\)/, 'folder track lookup should stop once a page is filled');
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
