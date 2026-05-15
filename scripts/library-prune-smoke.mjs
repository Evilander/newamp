import assert from 'node:assert/strict';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';

const smokeRoot = resolve('tmp', 'library-prune-smoke');
const musicRoot = join(smokeRoot, 'music');
const outsideRoot = join(smokeRoot, 'outside');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });
await mkdir(outsideRoot, { recursive: true });

const keepPath = join(musicRoot, '01-keep.mp3');
const missingPath = join(musicRoot, '02-missing.mp3');
const outsideMissingPath = join(outsideRoot, '03-outside-missing.mp3');
await writeFile(keepPath, 'keep');
await writeFile(missingPath, 'missing');
await writeFile(outsideMissingPath, 'outside missing');

const library = await LibraryStore.open(dbPath);
library.upsertTracks([
  incoming(keepPath, 'Keep'),
  incoming(missingPath, 'Missing'),
  incoming(outsideMissingPath, 'Outside Missing'),
]);
assert.equal(library.getStats().tracks, 3);

await unlink(missingPath);
await unlink(outsideMissingPath);

const targeted = library.pruneMissingTracks([musicRoot]);
assert.deepEqual(
  targeted,
  { checked: 2, removed: 1 },
  'targeted prune should remove only missing files below the requested root',
);
assert.equal(library.getStats().tracks, 2);
assert.equal(library.getTracksByPaths([keepPath]).length, 1);
assert.equal(library.getTracksByPaths([missingPath]).length, 0);
assert.equal(library.getTracksByPaths([outsideMissingPath]).length, 1);

const global = library.pruneMissingTracks();
assert.deepEqual(global, { checked: 2, removed: 1 });
assert.equal(library.getStats().tracks, 1);
library.close();

const [typesSource, librarySource, mainSource, preloadSource, apiSource, viewSource, watcherSource, packageSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../electron/library-watcher.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /LibraryPruneMissingResult/, 'shared types should expose prune result');
assert.match(typesSource, /pruneMissingTracks/, 'renderer API should type stale-track cleanup');
assert.match(librarySource, /pruneMissingTracks/, 'LibraryStore should remove missing track rows');
assert.match(mainSource, /library:prune-missing/, 'main process should expose prune IPC');
assert.match(mainSource, /pruneMissingTracks\(targets\)/, 'auto-watch should prune stale watched targets');
assert.match(preloadSource, /pruneMissingTracks/, 'preload should expose prune API');
assert.match(apiSource, /pruneMissingTracks/, 'browser-safe API should expose prune stub');
assert.match(viewSource, /Clean missing files/, 'Library Health UI should expose stale file cleanup');
assert.match(watcherSource, /resolveLibraryWatchTarget/, 'watcher should target deleted audio paths for cleanup');
assert.match(packageSource, /"smoke:library-prune"/, 'package.json should expose stale-track cleanup smoke');

console.log(JSON.stringify({ ok: true, targeted, global }, null, 2));

function incoming(path, title) {
  return {
    path,
    title,
    artist: 'Prune Smoke',
    album: 'Cleanup',
    albumArtist: 'Prune Smoke',
    trackNo: null,
    discNo: null,
    year: 2026,
    genre: 'Smoke',
    duration: 1,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1,
    mtime: Date.now(),
    art: null,
  };
}
