import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'library-paging-smoke');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });

const library = await LibraryStore.open(dbPath);
try {
  const total = 5012;
  library.upsertTracks(
    Array.from({ length: total }, (_, i) => ({
      path: join(smokeRoot, 'music', `${String(i + 1).padStart(5, '0')}.mp3`),
      title: `Paging Track ${String(i + 1).padStart(5, '0')}`,
      artist: `Paging Smoke Artist ${String(i + 1).padStart(5, '0')}`,
      album: `Large Library ${String(i + 1).padStart(5, '0')}`,
      albumArtist: `Paging Smoke Artist ${String(i + 1).padStart(5, '0')}`,
      trackNo: i + 1,
      discNo: null,
      year: 2026,
      genre: 'Smoke',
      duration: 60,
      bitrate: null,
      sampleRate: null,
      bpm: null,
      key: null,
      replayGainTrackDb: null,
      replayGainAlbumDb: null,
      size: 100 + i,
      mtime: 1000 + i,
      art: null,
    })),
  );

  const firstPage = library.getTracks({ sort: 'album', limit: 5000, offset: 0 });
  const secondPage = library.getTracks({ sort: 'album', limit: 5000, offset: firstPage.length });
  const exactTotal = library.getTrackCount({ search: 'Paging Smoke', sort: 'artist' });
  const albumFirstPage = library.getAlbums({ search: 'Large Library', limit: 5000, offset: 0 });
  const albumSecondPage = library.getAlbums({ search: 'Large Library', limit: 5000, offset: albumFirstPage.length });
  const missingArtAlbums = library.getAlbums({ search: 'Large Library', missingArtOnly: true, limit: 10, offset: 0 });
  const artistFirstPage = library.getArtists({ search: 'Paging Smoke Artist', limit: 5000, offset: 0 });
  const artistSecondPage = library.getArtists({ search: 'Paging Smoke Artist', limit: 5000, offset: artistFirstPage.length });
  const titleSorted = library.getTracks({ sort: 'title', limit: 3, offset: 0 });
  const newest = library.getTracks({ sort: 'added', limit: 1, offset: 0 })[0];
  const longest = library.getTracks({ sort: 'duration', limit: 1, offset: 0 })[0];
  assert.equal(firstPage.length, 5000, 'first large-library page should respect the UI page size');
  assert.equal(secondPage.length, 12, 'second large-library page should expose tracks beyond the first 5000');
  assert.equal(new Set([...firstPage, ...secondPage].map((track) => track.id)).size, total, 'paged results should not duplicate tracks');
  assert.equal(exactTotal, total, 'large-library search should expose an exact filtered total');
  assert.equal(albumFirstPage.length, 5000, 'album summaries should support large-library paging');
  assert.equal(albumSecondPage.length, 12, 'album summaries should expose later pages');
  assert.equal(missingArtAlbums.length, 10, 'album summaries should support server-side missing-art filtering');
  assert.equal(artistFirstPage.length, 5000, 'artist summaries should support large-library paging');
  assert.equal(artistSecondPage.length, 12, 'artist summaries should expose later pages');
  assert.equal(titleSorted[0]?.title, 'Paging Track 00001', 'title sort should be available for direct track lookup');
  assert.equal(newest?.title, 'Paging Track 05012', 'added sort should expose newest imports first');
  assert.equal(longest?.title, 'Paging Track 00001', 'duration sort should be deterministic when durations match');

  for (const track of library.getTracks({ sort: 'album', limit: total, offset: 0 })) library.toggleLove(track.id);
  const lovedFirstPage = library.getTracks({ sort: 'loved', limit: 600, offset: 0 });
  const lovedSecondPage = library.getTracks({ sort: 'loved', limit: 600, offset: lovedFirstPage.length });
  assert.equal(lovedFirstPage.length, 600, 'loved track view should be able to page large favorite sets');
  assert.equal(lovedSecondPage.length, 600, 'loved track view should expose later favorite pages');
  assert.equal(library.getTrackCount({ sort: 'loved' }), total, 'loved track view should expose an exact favorite count');

  const [libraryViewSource, albumsViewSource, artistsViewSource, lovedViewSource, typesSource, librarySource, packageSource] = await Promise.all([
    readText('../src/components/views/LibraryView.tsx'),
    readText('../src/components/views/AlbumsView.tsx'),
    readText('../src/components/views/ArtistsView.tsx'),
    readText('../src/components/views/LovedView.tsx'),
    readText('../shared/types.ts'),
    readText('../electron/library.ts'),
    readText('../package.json'),
  ]);
  assert.match(libraryViewSource, /LIBRARY_PAGE_SIZE/, 'LibraryView should centralize the large-library page size');
  const pageSizeMatch = libraryViewSource.match(/const LIBRARY_PAGE_SIZE = (\d+)/);
  assert.ok(pageSizeMatch, 'LibraryView should declare a numeric page size');
  assert.ok(Number(pageSizeMatch[1]) <= 800, 'LibraryView should keep initial DOM row count light for huge libraries');
  assert.match(libraryViewSource, /useDebouncedValue\(search, LIBRARY_SEARCH_DEBOUNCE_MS\)/, 'LibraryView should debounce large-library search before querying the catalog');
  assert.match(libraryViewSource, /search: libraryQuery/, 'LibraryView should run catalog paging against the debounced search query');
  assert.match(libraryViewSource, /offset: tracks\.length/, 'LibraryView should request subsequent pages by loaded row count');
  assert.match(libraryViewSource, /Load more/, 'LibraryView should expose a load-more control');
  assert.match(libraryViewSource, /hasMoreTracks/, 'LibraryView should track whether more catalog rows are available');
  assert.match(libraryViewSource, /getTrackCount/, 'LibraryView should fetch exact filtered totals');
  assert.match(libraryViewSource, /summaryRefreshKey/, 'LibraryView should refresh heavy library summary data explicitly');
  assert.doesNotMatch(libraryViewSource, /\[tracks\.length\]/, 'LibraryView should not recompute library health when loading more rows');
  for (const sortId of ['title', 'added', 'year', 'genre', 'duration']) {
    assert.match(libraryViewSource, new RegExp(`id: '${sortId}'`), `LibraryView should expose ${sortId} sort`);
  }
  assert.match(typesSource, /missingArtOnly\?: boolean/, 'catalog summary queries should expose server-side missing-art filtering');
  assert.match(librarySource, /opts\.missingArtOnly === true/, 'album summary query should filter missing art in SQL');
  assert.match(albumsViewSource, /const ALBUM_PAGE_SIZE = (\d+)/, 'AlbumsView should centralize the album page size');
  const albumPageSizeMatch = albumsViewSource.match(/const ALBUM_PAGE_SIZE = (\d+)/);
  assert.ok(Number(albumPageSizeMatch?.[1] ?? 9999) <= 320, 'AlbumsView should keep initial album cards light for huge libraries');
  assert.match(albumsViewSource, /useDebouncedValue\(filter, CATALOG_SEARCH_DEBOUNCE_MS\)/, 'AlbumsView should debounce album search');
  assert.match(albumsViewSource, /search: albumQuery/, 'AlbumsView should query album summaries with the debounced search');
  assert.match(albumsViewSource, /missingArtOnly: showMissingArtOnly/, 'AlbumsView should preserve missing-art filtering server-side');
  assert.match(albumsViewSource, /offset: albums\.length/, 'AlbumsView should request later album pages by loaded row count');
  assert.match(albumsViewSource, /Load more albums/, 'AlbumsView should expose explicit album pagination');
  assert.match(albumsViewSource, /data-newamp-albums-load-more/, 'AlbumsView should expose a stable load-more marker');
  assert.doesNotMatch(albumsViewSource, /api\.getAlbums\(\)\.then\(setAlbums\)/, 'AlbumsView should not load every album on mount');
  assert.match(artistsViewSource, /const ARTIST_PAGE_SIZE = (\d+)/, 'ArtistsView should centralize the artist page size');
  const artistPageSizeMatch = artistsViewSource.match(/const ARTIST_PAGE_SIZE = (\d+)/);
  assert.ok(Number(artistPageSizeMatch?.[1] ?? 9999) <= 400, 'ArtistsView should keep initial artist rows light for huge libraries');
  assert.match(artistsViewSource, /useDebouncedValue\(filter, CATALOG_SEARCH_DEBOUNCE_MS\)/, 'ArtistsView should debounce artist search');
  assert.match(artistsViewSource, /search: artistQuery/, 'ArtistsView should query artist summaries with the debounced search');
  assert.match(artistsViewSource, /offset: artists\.length/, 'ArtistsView should request later artist pages by loaded row count');
  assert.match(artistsViewSource, /Load more artists/, 'ArtistsView should expose explicit artist pagination');
  assert.match(artistsViewSource, /data-newamp-artists-load-more/, 'ArtistsView should expose a stable load-more marker');
  assert.doesNotMatch(artistsViewSource, /api\.getArtists\(\)\.then\(setArtists\)/, 'ArtistsView should not load every artist on mount');
  assert.match(lovedViewSource, /const LOVED_PAGE_SIZE = 600/, 'LovedView should centralize the loved-track page size');
  assert.match(lovedViewSource, /getTrackCount\(\{ sort: 'loved' \}\)/, 'LovedView should fetch exact favorite totals');
  assert.match(lovedViewSource, /const offset = tracks\.length/, 'LovedView should page favorites by loaded row count');
  assert.match(lovedViewSource, /Load more loved/, 'LovedView should expose explicit favorite pagination');
  assert.match(lovedViewSource, /onToggleLove=\{toggleLove\}/, 'LovedView should remove rows when tracks are un-loved there');
  assert.doesNotMatch(lovedViewSource, /limit: 5000/, 'LovedView should not cap favorites at one hard-coded 5000 row batch');
  assert.match(packageSource, /smoke:library-paging/, 'package scripts should expose library paging smoke');

  console.log(
    JSON.stringify(
      {
        ok: true,
        firstPage: firstPage.length,
        secondPage: secondPage.length,
        albumFirstPage: albumFirstPage.length,
        albumSecondPage: albumSecondPage.length,
        artistFirstPage: artistFirstPage.length,
        artistSecondPage: artistSecondPage.length,
        lovedFirstPage: lovedFirstPage.length,
        lovedSecondPage: lovedSecondPage.length,
        exactTotal,
      },
      null,
      2,
    ),
  );
} finally {
  library.close();
}

async function readText(relativePath) {
  return import('node:fs/promises').then((fs) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8'));
}
