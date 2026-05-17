import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'quick-play-smoke');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });

const library = await LibraryStore.open(dbPath);
try {
  library.upsertTracks([
    fixture('K:\\music\\Radiohead\\OK Computer\\01 - Airbag.mp3', 'Airbag', 'Radiohead', 'OK Computer', 1),
    fixture('K:\\music\\Radiohead\\OK Computer\\02 - Paranoid Android.mp3', 'Paranoid Android', 'Radiohead', 'OK Computer', 2),
    fixture('K:\\music\\Pavement\\Crooked Rain\\01 - Silence Kit.mp3', 'Silence Kit', 'Pavement', 'Crooked Rain', 3),
  ]);

  const titleSearch = library.getTracks({ search: 'paranoid', limit: 10, offset: 0 });
  assert.equal(titleSearch.length, 1, 'quick title search should resolve a playable row');
  assert.equal(titleSearch[0].title, 'Paranoid Android');

  const pathSearch = library.getTracks({ search: 'path:"OK Computer"', limit: 10, offset: 0 });
  assert.equal(pathSearch.length, 2, 'power-search path filters should support quick library narrowing');

  const albumTracks = library.getAlbumTracks('OK Computer', 'Radiohead');
  assert.equal(albumTracks.length, 2, 'quick palette album results should be able to launch album tracks');
  const albumResults = library.getAlbums({ search: 'computer', limit: 4 });
  assert.equal(albumResults.length, 1, 'quick palette album search should filter in the catalog layer');
  assert.equal(albumResults[0].album, 'OK Computer');
  const nearbyAlbums = library.getAlbums({
    year: 1997,
    yearWindow: 0,
    excludeAlbum: 'OK Computer',
    excludeAlbumArtist: 'Radiohead',
    limit: 4,
  });
  assert.deepEqual(
    nearbyAlbums.map((album) => album.album),
    ['Crooked Rain'],
    'album context should fetch nearby releases without reading the full album catalog',
  );

  const artistTracks = library.getArtistTracks('Radiohead');
  assert.equal(artistTracks.length, 2, 'quick palette artist results should be able to launch artist tracks');
  const artistResults = library.getArtists({ search: 'radio', limit: 4 });
  assert.equal(artistResults.length, 1, 'quick palette artist search should filter in the catalog layer');
  assert.equal(artistResults[0].artist, 'Radiohead');

  const playlist = library.savePlaylist({
    name: 'Quick Palette Playlist',
    trackIds: pathSearch.map((track) => track.id),
  });
  assert.equal(library.getPlaylistTracks(playlist.id).length, 2, 'quick palette playlist results should launch saved playlists');

  const smartRule = library.saveSmartPlaylistRule({
    name: 'Quick Palette Smart Rule',
    mood: 'drive',
    count: 2,
    genreQuery: 'Smoke',
  });
  const smartRuleTracks = library.runSmartPlaylistRule(smartRule.id);
  assert.equal(smartRuleTracks.length, 2, 'quick palette smart-rule results should launch dynamic playlists');

  const loved = library.toggleLove(titleSearch[0].id);
  assert.equal(loved, true, 'quick love action should be backed by the catalog toggle');
  assert.equal(library.getTrack(titleSearch[0].id)?.loved, 1);

  const [paletteSource, appSource, packageSource] = await Promise.all([
    readText('../src/components/QuickPlayPalette.tsx'),
    readText('../src/App.tsx'),
    readText('../package.json'),
  ]);

  assert.match(paletteSource, /data-newamp-quick-play/, 'Quick Play overlay should be queryable by smoke/UI tests');
  assert.match(paletteSource, /ctrlKey \|\| event\.metaKey/, 'Quick Play should open from keyboard shortcuts');
  assert.match(paletteSource, /key === 'k' \|\| key === 'j'/, 'Quick Play should support Ctrl+K and Ctrl+J');
  assert.match(paletteSource, /api\.getTracks/, 'Quick Play should search the real catalog API');
  assert.match(paletteSource, /api\.getPlaylists/, 'Quick Play should search saved playlists');
  assert.match(paletteSource, /api\.getSmartPlaylistRules/, 'Quick Play should search saved smart playlist rules');
  assert.match(paletteSource, /api\.getAlbums/, 'Quick Play should search albums');
  assert.match(paletteSource, /api\.getAlbums\(\{ search: trimmedQuery, limit: CATALOG_LIMIT \}\)/, 'Quick Play should not pull every album while searching');
  assert.match(paletteSource, /api\.getArtists/, 'Quick Play should search artists');
  assert.match(paletteSource, /api\.getArtists\(\{ search: trimmedQuery, limit: CATALOG_LIMIT \}\)/, 'Quick Play should not pull every artist while searching');
  assert.match(paletteSource, /api\.getPlaylistTracks/, 'Quick Play should launch saved playlists');
  assert.match(paletteSource, /api\.runSmartPlaylistRule/, 'Quick Play should launch saved smart playlist rules');
  assert.match(paletteSource, /setAutoDjSmartRuleId/, 'Quick Play should arm Auto DJ from saved smart playlist rules');
  assert.match(paletteSource, /startSmartRuleRadio/, 'Quick Play should start continuous Smart Rule Radio');
  assert.match(paletteSource, /api\.getAlbumTracks/, 'Quick Play should launch album results');
  assert.match(paletteSource, /api\.getArtistTracks/, 'Quick Play should launch artist results');
  assert.match(paletteSource, /playQueue/, 'Quick Play should play search results directly');
  assert.match(paletteSource, /queueTrackNext/, 'Quick Play should support play-next');
  assert.match(paletteSource, /addTrackToQueue/, 'Quick Play should support queue append');
  assert.match(paletteSource, /queueTracksNext/, 'Quick Play should support play-next for result sets');
  assert.match(paletteSource, /addTracksToQueue/, 'Quick Play should support queue append for result sets');
  assert.match(paletteSource, /api\.toggleLove/, 'Quick Play should support love toggling');
  assert.match(paletteSource, /Ctrl\+Enter plays next/, 'Quick Play should expose a play-next keyboard chord');
  assert.match(paletteSource, /Shift\+Enter queues/, 'Quick Play should expose a queue keyboard chord');
  assert.match(paletteSource, /Ctrl\+L loves/, 'Quick Play should expose a love keyboard chord');
  assert.match(paletteSource, /Ctrl\+R starts radio/, 'Quick Play should expose a smart-rule radio keyboard chord');
  assert.match(paletteSource, /event\.key === 'Enter' && \(event\.ctrlKey \|\| event\.metaKey\)/, 'Quick Play should route Ctrl+Enter to play-next');
  assert.match(paletteSource, /event\.key === 'Enter' && event\.shiftKey/, 'Quick Play should route Shift+Enter to queue');
  assert.match(paletteSource, /key === 'l' && \(event\.ctrlKey \|\| event\.metaKey\)/, 'Quick Play should route Ctrl+L to love');
  assert.match(paletteSource, /key === 'r' && \(event\.ctrlKey \|\| event\.metaKey\)/, 'Quick Play should route Ctrl+R to smart-rule radio');
  assert.match(paletteSource, /setView\('now-playing'\)/, 'Quick Play should jump to Now Playing after play');
  assert.match(paletteSource, /VIEW_ITEMS/, 'Quick Play should include app views');
  assert.match(paletteSource, /COMMAND_ITEMS/, 'Quick Play should include app commands');
  assert.match(paletteSource, /smart-rule/, 'Quick Play should expose dynamic smart rules as playable results');
  assert.match(paletteSource, /RADIO/, 'Quick Play should expose smart-rule radio actions');
  assert.match(paletteSource, /scanLibrary/, 'Quick Play should expose library scan command');
  assert.match(appSource, /QuickPlayPalette/, 'App should mount Quick Play globally');
  assert.match(packageSource, /smoke:quick-play/, 'package scripts should expose Quick Play smoke');

  console.log(JSON.stringify({
    ok: true,
    titleSearch: titleSearch.length,
    pathSearch: pathSearch.length,
    albumResults: albumResults.length,
    nearbyAlbums: nearbyAlbums.length,
    albumTracks: albumTracks.length,
    artistResults: artistResults.length,
    artistTracks: artistTracks.length,
    playlistTracks: playlist.trackCount,
    smartRuleTracks: smartRuleTracks.length,
    loved,
  }, null, 2));
} finally {
  library.close();
}

function fixture(path, title, artist, album, trackNo) {
  return {
    path,
    title,
    artist,
    album,
    albumArtist: artist,
    trackNo,
    discNo: null,
    year: 1997,
    genre: 'Smoke',
    duration: 240 + trackNo,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1000 + trackNo,
    mtime: 2000 + trackNo,
    art: null,
  };
}

async function readText(relativePath) {
  return import('node:fs/promises').then((fs) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8'));
}
