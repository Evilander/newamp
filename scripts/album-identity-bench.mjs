// Times the album and artist queries on a copy of a real library.db, and the
// regroup pass when the build has one. Never opens the original: the copy is
// made here, and anything the open writes lands on the copy.
// Run: node scripts/album-identity-bench.mjs [path-to-library.db] [--json out.json] [--probe tags.jsonl] [--dist dir]
//   --dist: the compiled electron folder to measure (default dist-electron), to run the same
//   numbers against another build of the library.
//   --probe: a JSONL of tags read from the files (id, aa, cmp, ...), applied
//   before the regroup so the pass runs on tag-aware data without reading the
//   music folders. Without it the pass runs on what the database already holds.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const source = args.find((a) => a.endsWith('.db')) ?? resolve('tmp/real-library.db');
const jsonOut = flag('--json');
const probePath = flag('--probe');
const dist = resolve(flag('--dist') ?? 'dist-electron');

const work = resolve('tmp/album-identity-bench');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const dbPath = join(work, 'library.db');
copyFileSync(source, dbPath);

const { LibraryStore } = await import(pathToFileURL(join(dist, 'electron/library.js')).href);

const t0 = performance.now();
const library = await LibraryStore.open(dbPath);
const openMs = performance.now() - t0;

const rows = (sql) => library.db.exec(sql)[0]?.values ?? [];
const results = { source, openMs: Math.round(openMs) };
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function time(label, fn, runs = Number(flag('--runs') ?? 7)) {
  const samples = [];
  let last;
  fn();
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    last = fn();
    samples.push(performance.now() - s);
  }
  results[label] = { medianMs: Number(median(samples).toFixed(1)), minMs: Number(Math.min(...samples).toFixed(1)), rows: Array.isArray(last) ? last.length : last };
  console.log(label.padEnd(34), String(results[label].medianMs).padStart(8), 'ms median', ' rows:', results[label].rows);
}

if (typeof library.regroupAlbumsSync === 'function') {
  if (probePath) {
    const lines = readFileSync(probePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const applied = library.applyTagBackfill(
      lines
        .filter((r) => !r.err)
        .map((r) => ({
          id: r.id,
          albumArtistTag: r.aa ?? null,
          compilation: !!r.cmp,
          albumArtistSort: r.aas ?? null,
          artistSort: null,
          discTotal: r.dof ?? null,
          trackTotal: r.tof ?? null,
          discSubtitle: r.dst ?? null,
          mbReleaseGroupId: r.mbg ?? null,
          originalYear: null,
          artists: r.ars ?? null,
          genres: r.gen && r.gen.length > 1 ? r.gen : null,
        })),
    );
    console.log('applied probe tags to', applied, 'rows');
  }
  const r0 = performance.now();
  const summary = library.regroupAlbumsSync();
  results.regroupSync = { ms: Math.round(performance.now() - r0), ...summary };
  console.log('regroup (sync, first run)'.padEnd(34), results.regroupSync.ms, 'ms', JSON.stringify(summary));
  const r1 = performance.now();
  const again = library.regroupAlbumsSync();
  results.regroupSyncAgain = { ms: Math.round(performance.now() - r1), ...again };
  console.log('regroup (sync, nothing changed)'.padEnd(34), results.regroupSyncAgain.ms, 'ms', JSON.stringify(again));
  if (typeof library.regroupAlbums === 'function') {
    // The yielding driver: longest stretch it holds the thread without giving it back.
    let longest = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 1);
    library.markAlbumsStale?.();
    const a0 = performance.now();
    await library.regroupAlbums({ force: true });
    clearInterval(probe);
    results.regroupAsync = { ms: Math.round(performance.now() - a0), longestBlockMs: Math.round(longest) };
    console.log('regroup (yielding)'.padEnd(34), results.regroupAsync.ms, 'ms; longest gap between timer ticks', results.regroupAsync.longestBlockMs, 'ms');
  }
}

time('getStats', () => library.getStats());
for (const sort of ['artist', 'album', 'year-desc', 'recent', 'plays', 'tracks']) {
  time(`getAlbums sort=${sort} (240)`, () => library.getAlbums({ sort, limit: 240, offset: 0 }));
}
time('getAlbums deep page (offset 4800)', () => library.getAlbums({ sort: 'artist', limit: 240, offset: 4800 }));
time('getAlbums search "love"', () => library.getAlbums({ search: 'love', limit: 240 }));
time('getAlbums missingArtOnly', () => library.getAlbums({ missingArtOnly: true, limit: 240 }));
time('getAlbums all (limit 100000)', () => library.getAlbums({ sort: 'artist', limit: 100000 }));
time('getTracks sort=artist (500)', () => library.getTracks({ sort: 'artist', limit: 500, offset: 20000 }));
time('getTracks search "love" (500)', () => library.getTracks({ search: 'love', limit: 500 }));
const someIds = rows('SELECT id FROM tracks WHERE id % 100 = 0 LIMIT 500').map((r) => r[0]);
time('getTracksByIds (500)', () => library.getTracksByIdsInOrder(someIds));
{
  // The first call builds the list; later ones may be answered from a cache, so it is timed alone.
  const s = performance.now();
  const first = library.getArtists({ limit: 100000 });
  results['getArtists all (first call)'] = { medianMs: Number((performance.now() - s).toFixed(1)), rows: first.length };
  console.log('getArtists all (first call)'.padEnd(34), results['getArtists all (first call)'].medianMs, 'ms');
}
time('getArtists all (repeat)', () => library.getArtists({ limit: 100000 }));
time('getArtists search "the"', () => library.getArtists({ search: 'the', limit: 100000 }));

// The same 40 largest albums and 200 largest artists, by the pair of strings the
// old grouping used, whichever build is measured.
const oldPairs = rows(`SELECT COALESCE(NULLIF(album_artist,''), artist), album, COUNT(*) AS n FROM tracks
                        WHERE album != '' GROUP BY album, COALESCE(NULLIF(album_artist,''), artist)
                        ORDER BY n DESC LIMIT 40`).map((r) => [r[0], r[1]]);
time('getAlbumTracks(pair) x40', () => {
  let total = 0;
  for (const [artist, album] of oldPairs) total += library.getAlbumTracks(artist, album).length;
  return total;
});
if (typeof library.getAlbumTracksByKey === 'function') {
  const keys = library.getAlbums({ sort: 'tracks', limit: 40 }).map((a) => a.albumKey);
  time('getAlbumTracksByKey x40', () => {
    let total = 0;
    for (const key of keys) total += library.getAlbumTracksByKey(key).length;
    return total;
  });
}
const oldArtists = rows(`SELECT artist, COUNT(*) AS n FROM tracks WHERE artist != '' GROUP BY artist ORDER BY n DESC LIMIT 200`).map((r) => r[0]);
time('getArtistTracks x200', () => {
  let total = 0;
  for (const artist of oldArtists) total += library.getArtistTracks(artist).length;
  return total;
});

const final = library.getStats();
results.stats = final;
console.log('stats', JSON.stringify(final));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
library.close();
rmSync(work, { recursive: true, force: true });
