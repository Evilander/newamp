// A track removed while a sliced library job is between turns must not fail the
// job: the tag recompute and the listening-history import both write rows that
// point at tracks, and a removed track used to fail the foreign key, losing the
// whole tag pass or stranding the batches of a half-applied import.
// Run: node scripts/library-removal-race-test.mjs
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-removal-race-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const outfile = join(root, 'library.mjs');
await build({
  entryPoints: [join(repoRoot, 'electron', 'library.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
});
const { LibraryStore } = await import(pathToFileURL(outfile).href);

const incoming = (n) => ({
  path: `/m/${n}.flac`, title: `Song ${n}`, artist: 'A', album: 'B', albumArtist: 'A', trackNo: null, discNo: null, year: null,
  genre: 'Keeper', duration: 1, bitrate: null, sampleRate: null, replayGainTrackDb: null, replayGainAlbumDb: null, size: 1, mtime: 1, art: null,
});
const COUNT = 3000;
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---- tags
const store = await LibraryStore.open(join(root, 'library.db'));
store.upsertTracks(Array.from({ length: COUNT }, (_, i) => incoming(i)));
store.saveTagRule({ name: 'keeper', body: 'tag(keeper) when genre = "Keeper"' });
const ids = store.getTracksByPaths(Array.from({ length: COUNT }, (_, i) => `/m/${i}.flac`)).map((t) => t.id);
store.db.run('PRAGMA foreign_keys = ON');
const pass = store.recomputeTagsAsync();
await tick();
const doomed = ids.slice(0, 200);
store.removeTracksById(doomed);
const result = await pass;
assert.equal(result.tracksEvaluated > 0, true);
assert.equal(store.getTagSummaries().find((t) => t.name === 'keeper').trackCount, COUNT - doomed.length);
assert.equal(result.tagsAssigned, COUNT - doomed.length, 'tags for removed tracks are not counted');

// ---- history import
const entries = [];
for (let i = 0; i < 2500; i += 1) entries.push({ artist: 'A', title: `Song ${i}`, album: 'B', playedAt: 1000 + i });
const survivors = store.getTracksByPaths(Array.from({ length: COUNT }, (_, i) => `/m/${i}.flac`)).map((t) => t.id);
const imp = store.importListeningHistoryAsync(entries);
await tick();
store.removeTracksById(survivors.slice(2400, 2450));
const report = await imp;
assert.equal(report.imported + report.unmatched + report.duplicates + report.ambiguous + report.invalid, report.total);
assert.equal(report.imported > 0, true);
store.close();

await rm(root, { recursive: true, force: true });
console.log('[library-removal-race-test] ok: tracks removed mid-job do not fail the tag pass or the history import');
