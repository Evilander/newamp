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
      artist: 'Paging Smoke',
      album: 'Large Library',
      albumArtist: 'Paging Smoke',
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
  const titleSorted = library.getTracks({ sort: 'title', limit: 3, offset: 0 });
  const newest = library.getTracks({ sort: 'added', limit: 1, offset: 0 })[0];
  const longest = library.getTracks({ sort: 'duration', limit: 1, offset: 0 })[0];
  assert.equal(firstPage.length, 5000, 'first large-library page should respect the UI page size');
  assert.equal(secondPage.length, 12, 'second large-library page should expose tracks beyond the first 5000');
  assert.equal(new Set([...firstPage, ...secondPage].map((track) => track.id)).size, total, 'paged results should not duplicate tracks');
  assert.equal(exactTotal, total, 'large-library search should expose an exact filtered total');
  assert.equal(titleSorted[0]?.title, 'Paging Track 00001', 'title sort should be available for direct track lookup');
  assert.equal(newest?.title, 'Paging Track 05012', 'added sort should expose newest imports first');
  assert.equal(longest?.title, 'Paging Track 00001', 'duration sort should be deterministic when durations match');

  const [libraryViewSource, packageSource] = await Promise.all([
    readText('../src/components/views/LibraryView.tsx'),
    readText('../package.json'),
  ]);
  assert.match(libraryViewSource, /LIBRARY_PAGE_SIZE/, 'LibraryView should centralize the large-library page size');
  assert.match(libraryViewSource, /offset: tracks\.length/, 'LibraryView should request subsequent pages by loaded row count');
  assert.match(libraryViewSource, /Load more/, 'LibraryView should expose a load-more control');
  assert.match(libraryViewSource, /hasMoreTracks/, 'LibraryView should track whether more catalog rows are available');
  assert.match(libraryViewSource, /getTrackCount/, 'LibraryView should fetch exact filtered totals');
  for (const sortId of ['title', 'added', 'year', 'genre', 'duration']) {
    assert.match(libraryViewSource, new RegExp(`id: '${sortId}'`), `LibraryView should expose ${sortId} sort`);
  }
  assert.match(packageSource, /smoke:library-paging/, 'package scripts should expose library paging smoke');

  console.log(
    JSON.stringify(
      { ok: true, firstPage: firstPage.length, secondPage: secondPage.length, exactTotal },
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
