import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const parent = resolve('tmp/library-close-race');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'run-'));
await build({
  entryPoints: ['electron/library.ts'], outfile: join(root, 'library.mjs'),
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
  plugins: [{ name: 'delay-async-rename', setup(builder) {
    builder.onLoad({ filter: /recovery\.ts$/ }, async ({ path }) => ({
      contents: (await readFile(path, 'utf8')).replace('await fsRename(fromPath, toPath)', 'await globalThis.__delayLibraryRename?.(); await fsRename(fromPath, toPath)'),
      loader: 'ts',
    }));
  } }],
});
const { LibraryStore } = await import(pathToFileURL(join(root, 'library.mjs')));
const path = join(root, 'library.db');
const store = await LibraryStore.open(path);
function track(name) {
  return {
    path: `/fixture/${name}.mp3`,
    title: name,
    artist: 'Fixture',
    album: 'Fixture',
    albumArtist: 'Fixture',
    trackNo: 1,
    discNo: 1,
    year: 2025,
    genre: null,
    duration: 10,
    bitrate: 320000,
    sampleRate: 44100,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 100,
    mtime: 1,
    art: null,
  };
}
store.upsertTracks([track('before')]);
let releaseRename;
let reachedRename;
const gate = new Promise((resolve) => { releaseRename = resolve; });
const reached = new Promise((resolve) => { reachedRename = resolve; });
globalThis.__delayLibraryRename = async () => { reachedRename(); await gate; };
const pending = store.flushAsync();
const pausePoint = await Promise.race([reached.then(() => 'rename-paused'), pending.then(() => 'flush-finished')]);
store.upsertTracks([track('after')]);
store.close();
releaseRename();
await pending;
delete globalThis.__delayLibraryRename;
const reopened = await LibraryStore.open(path);
assert.equal(reopened.getTrackCount(), 2, 'an older pending rename must not replace the final close snapshot');
reopened.close();
const librarySource = await readFile(resolve('electron/library.ts'), 'utf8');
assert.doesNotMatch(librarySource, /await\s+renameOverExistingAsync\(tmp,\s*this\.file\)/, 'library async flush must not await the final replace after its sequence check');
assert.match(librarySource, /renameOverExistingSync\(tmp,\s*this\.file\)/, 'library async flush should use a synchronous final replace after its sequence check');
assert.equal(pausePoint, 'flush-finished', 'fixed library should not hit the delayed async final rename hook');

const collisionPath = join(root, 'case-collision-library.db');
const collisionStore = await LibraryStore.open(collisionPath);
function caseTrack(path, title) {
  return {
    ...track(title),
    path,
    title,
    artist: 'Case Fixture',
    album: 'Case Album',
    albumArtist: 'Case Fixture',
  };
}
// On Windows a scan now treats paths that differ only in case as one file, so
// a case-renamed track keeps its id and history; elsewhere they are two files.
const caseRenameStore = await LibraryStore.open(join(root, 'case-rename-library.db'));
caseRenameStore.upsertTracks([caseTrack('C:/Music/Bar.mp3', 'Before Rename')]);
const renamedFrom = caseRenameStore.getTracks({ limit: 10 })[0].id;
caseRenameStore.upsertTracks([caseTrack('C:/Music/bar.mp3', 'After Rename')]);
const afterRename = caseRenameStore.getTracks({ limit: 10 });
if (process.platform === 'win32') {
  assert.equal(afterRename.length, 1, 'a case-only rename on Windows is the same file');
  assert.equal(afterRename[0].id, renamedFrom, 'a case-only rename on Windows keeps the track id');
} else {
  assert.equal(afterRename.length, 2, 'paths that differ only in case are two files here');
}
caseRenameStore.close();

// Libraries written before that, on any platform, can already hold two rows
// whose paths differ only in case. Seed that directly (a scan can no longer
// produce it on Windows): history import must still prefer an exact path and
// call a case-only match ambiguous.
collisionStore.upsertTracks([
  caseTrack('C:/Music/Foo.mp3', 'Upper Case Path'),
  caseTrack('C:/Music/Placeholder.mp3', 'Lower Case Path'),
]);
collisionStore.db.run(`UPDATE tracks SET path = 'C:/Music/foo.mp3' WHERE path = 'C:/Music/Placeholder.mp3'`);
const exactImport = collisionStore.importListeningHistory([{
  path: 'C:/Music/foo.mp3',
  artist: 'Case Fixture',
  title: 'Lower Case Path',
  album: 'Case Album',
  playedAt: 1_700_000_001_000,
  row: 1,
}]);
assert.equal(exactImport.imported, 1, 'an exact path must win before normalized path matching');
let tracks = collisionStore.getTracks({ limit: 10 });
assert.equal(tracks.find((item) => item.path === 'C:/Music/Foo.mp3')?.playCount, 0);
assert.equal(tracks.find((item) => item.path === 'C:/Music/foo.mp3')?.playCount, 1);
const ambiguousImport = collisionStore.importListeningHistory([{
  path: 'c:/music/foo.mp3',
  artist: 'Case Fixture',
  title: 'Lower Case Path',
  album: 'Case Album',
  playedAt: 1_700_000_002_000,
  row: 2,
}]);
assert.equal(ambiguousImport.imported, 0, 'case-colliding normalized paths must not import through identity fallback');
assert.equal(ambiguousImport.ambiguous, 1, 'case-colliding normalized paths without an exact match must be ambiguous');
tracks = collisionStore.getTracks({ limit: 10 });
assert.equal(tracks.find((item) => item.path === 'C:/Music/foo.mp3')?.playCount, 1);
collisionStore.close();
console.log('Library close and history path collision regressions passed.');
