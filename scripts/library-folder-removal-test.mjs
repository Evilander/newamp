import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { SettingsStore } from '../dist-electron/electron/settings.js';
import { IncrementalScanGate } from '../dist-electron/electron/library-watcher.js';
import { caseFoldCachePath } from '../dist-electron/electron/cache-key-casing.js';

const dir = resolve('tmp/library-folder-removal-test');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const library = await LibraryStore.open(join(dir, 'library.db'));
const root = join(dir, 'music');
const child = join(root, 'keep');
const sibling = join(dir, 'music-sibling');
const paths = [join(root, 'gone.mp3'), join(child, 'keep.mp3'), join(sibling, 'sibling.mp3'), join(dir, 'outside.mp3')];
const incoming = path => ({ path, title: path, year: null, genre: null, bitrate: null, sampleRate: null, bpm: null, key: null, replayGainTrackDb: null, replayGainAlbumDb: null, artist: 'Artist', albumArtist: 'Artist', album: 'Album', discNo: 1, trackNo: 1, duration: 180, size: 10, mtime: 1, art: null });
library.upsertTracks(paths.map(incoming));
const ids = paths.map(path => library.getTracksByPaths([path])[0].id);
assert.deepEqual(library.tracksForRemovedFolder(root, [child, sibling]), [ids[0]], 'child overlap and sibling prefix remain');
assert.deepEqual(library.tracksForRemovedFolder(child, [root]), [], 'a remaining parent covers every child track');
assert.deepEqual(library.tracksForRemovedFolder(root + '/', [child]), [ids[0]], 'trailing separators respect boundaries');
if (process.platform === 'darwin') {
  // A Mac hands the same name over as NFC or NFD; a folder saved in one form
  // still covers tracks stored in the other.
  const parent = join(dir, 'nest');
  const nested = join(parent, 'M\u00fasica');
  const stored = join(parent, 'Mu\u0301sica', 'x.mp3');
  library.upsertTracks([incoming(stored)]);
  const id = library.getTracksByPaths([stored])[0].id;
  assert.deepEqual(library.tracksForRemovedFolder(nested, []), [id], 'an NFC folder finds its NFD tracks');
  assert.deepEqual(library.tracksForRemovedFolder(parent, [nested]), [], 'a remaining NFC folder keeps its NFD tracks');
  library.removeTracksById([id]);
}

for (const id of ids.slice(0, 2)) { library.recordPlay(id); library.setTrackRating(id, 5); }
const playlist = library.savePlaylist({ name: 'Keep my playlist', trackIds: ids });
const list = library.saveList({ title: 'Keep my text' });
library.addListItem({ listId: list.id, trackId: ids[0], note: 'My note' });
const review = library.saveReview({ targetType: 'track', targetKey: String(ids[0]), body: 'My review' });
// A Windows checkout may have CRLF line endings; the slices below look for LF.
const main = (await readFile('electron/main.ts', 'utf8')).replaceAll('\r\n', '\n');
const handlers = new Map();
let roots = [root, child, sibling], watching = roots, notified = [], backups = 0, resumed = 0, scans = 0, failBackup = false;
let saved = null, importing = false, importDuringScan = false, importDuringBackup = false, scanBusy = false;
const sent = [];
const start = main.indexOf("  let removingLibraryFolder = false;");
const end = main.indexOf("  ipcMain.handle('library:prune-missing-preview'", start);
const source = await transform(main.slice(start, end), { loader: 'ts', target: 'es2022' });
const sandbox = {
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, library,
  settings: { get: () => ({ libraryRoots: [...roots] }), set: patch => { saved = patch; roots = patch.libraryRoots; } },
  restoreInProgress: false, backupInProgress: 0,
  assertHistoryImportIdle() { if (importing) throw new Error('Wait for the history import to finish or cancel it first.'); },
  quiesceLibraryMutations: async () => {},
  scanner: { get busy() { return scanBusy; }, whenIdle: async work => { scans++; if (importDuringScan) importing = true; return work(); } },
  app: { getPath: () => dir },
  createBackupFromLiveStores: async () => { if (failBackup) throw new Error('backup failed'); if (importDuringBackup) importing = true; backups++; },
  mainWin: { webContents: { send: channel => sent.push(channel) } }, removedUnseenRoots: new Set(),
  syncLibraryWatcher: () => { watching = [...roots]; }, notifyTracksRemoved: ids => { notified = ids; }, notifyPlaylistsChanged() {},
  withAiAssistRuntime: settings => settings, resumeLibraryMutations: () => { resumed++; },
};
vm.runInNewContext(source.code, sandbox);
const preview = handlers.get('library:remove-folder-preview');
const remove = handlers.get('library:remove-folder');
assert.equal(preview(null, root), 1);
failBackup = true;
await assert.rejects(remove(null, root, 1), /backup failed/);
assert.ok(library.getTrack(ids[0]), 'backup failure deletes nothing');
assert.ok(roots.includes(root));
failBackup = false;
// A removal is not parked behind a scan, where it would land later, unseen.
scanBusy = true;
const scansBefore = scans;
await assert.rejects(remove(null, root, 1), /scan is running/);
assert.ok(library.getTrack(ids[0]), 'a running scan refuses the removal');
assert.equal(scans, scansBefore, 'and it does not wait for the scan');
assert.ok(roots.includes(root));
scanBusy = false;
await assert.rejects(remove(null, root, 99), /Preview/);
assert.ok(library.getTrack(ids[0]), 'stale preview deletes nothing');
// A history import started while the removal waited for a scan would write
// plays for tracks it deletes.
importDuringScan = true;
await assert.rejects(remove(null, root, 1), /history import/);
assert.ok(library.getTrack(ids[0]), 'an import that began during the wait deletes nothing');
assert.equal(backups, 0);
importDuringScan = importing = false;
// So would one started while the backup was being written.
importDuringBackup = true;
await assert.rejects(remove(null, root, 1), /history import/);
assert.ok(library.getTrack(ids[0]), 'an import that began during the backup deletes nothing');
assert.ok(roots.includes(root));
importDuringBackup = importing = false;
assert.deepEqual(sent, [], 'a refused removal tells no page the folders changed');
const result = await remove(null, root, 1);
assert.deepEqual(result.libraryRoots, [child, sibling]);
assert.equal(saved.libraryRootsChosen, true, 'the next launch does not seed a default folder over the removal');
assert.deepEqual(watching, [child, sibling], 'watcher stops observing removed root');
assert.deepEqual(sent, ['settings:changed'], 'a Settings page opened during the removal reads the new list');
assert.deepEqual([...sandbox.removedUnseenRoots], [root]);
assert.deepEqual(notified, [ids[0]], 'queue receives exactly removed ids');
assert.equal(backups, 2);
assert.equal(resumed, 5);
assert.equal(scans, 5, 'waits for scans without cancellation');
assert.equal(library.getTrack(ids[0]), null);
assert.deepEqual(ids.slice(1).map(id => library.getTrack(id).id), ids.slice(1));
assert.equal(library.getTrack(ids[1]).playCount, 1, 'retained plays survive');
assert.equal(library.getTrack(ids[1]).rating, 5, 'retained ratings survive');
assert.deepEqual(library.getListeningHistory().map(item => item.track.id), [ids[1]], 'removed track history goes; retained history stays');
assert.deepEqual(library.getPlaylistTracks(playlist.id).map(track => track.id), ids.slice(1), 'playlist stays with surviving memberships');
assert.ok(library.getPlaylists().some(item => item.id === playlist.id));
const item = library.getList(list.id).items[0];
assert.equal(item.trackId, null);
assert.equal(item.note, 'My note');
assert.equal(item.label, paths[0], 'list entry becomes text');
assert.equal(library.getReviewById(review.id).body, 'My review');
// Neither a removal nor subsequent playback reads hide outside files.
assert.equal(library.getTracksByPaths([paths[3]]).length, 1);
// The removal owns the scanner queue until its backup and delete finish.
const scanner = new Scanner(library, () => {});
const events = [];
let endScan, endRemoval;
scanner.runNow = async targets => {
  events.push(targets[0]);
  if (targets[0] === 'active scan') await new Promise(resolve => { endScan = resolve; });
};
const active = scanner.start(['active scan']);
await new Promise(setImmediate);
const removal = scanner.whenIdle(async () => {
  events.push('removing');
  await new Promise(resolve => { endRemoval = resolve; });
});
const later = scanner.start(['later scan']);
assert.deepEqual(events, ['active scan']);
assert.equal(scanner.busy, true, 'a scan running, and one waiting its turn');
endScan();
await new Promise(setImmediate);
assert.deepEqual(events, ['active scan', 'removing']);
endRemoval();
await Promise.all([active, removal, later]);
assert.equal(scanner.busy, false, 'idle once the queue has drained');
assert.deepEqual(events, ['active scan', 'removing', 'later scan']);
library.close();

// A removed folder stays removed: the flag that says so survives a restart,
// and only a real true sets it.
{
  const file = join(dir, 'settings.json');
  const store = new SettingsStore(file);
  assert.equal(store.get().libraryRootsChosen, false, 'a fresh install has not chosen');
  store.set({ libraryRoots: [], libraryRootsChosen: true });
  store.flushSync();
  assert.equal(new SettingsStore(file).get().libraryRootsChosen, true);
  store.set({ libraryRootsChosen: 'yes' });
  store.flushSync();
  assert.equal(new SettingsStore(file).get().libraryRootsChosen, false);
  await writeFile(file, JSON.stringify({ libraryRoots: [], libraryRootsChosen: 'yes' }));
  assert.equal(new SettingsStore(file).get().libraryRootsChosen, false, 'a hand-edited file needs a real true');
}

// A page that read the folder list while the removal ran saves it back with
// the removed folder in it; the save leaves that folder out until the page has
// read the list again.
{
  const slice = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));
  const code = await transform(
    `${slice('const removedUnseenRoots', '// File > Add Folder to Library: the same steps')}\n${slice("ipcMain.handle('settings:get'", '// ---- Bit-Perfect Exclusive output')}\nglobalThis.removed = removedUnseenRoots;`,
    { loader: 'ts', target: 'es2022' },
  );
  const handlers = new Map();
  const written = [];
  const host = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    settings: { get: () => ({ libraryRoots: [child] }), set: patch => written.push(JSON.parse(JSON.stringify(patch))) },
    withAiAssistRuntime: value => value, restoreInProgress: false,
    patchTouchesLibraryWatch: () => false, patchTouchesRadioBrain: () => false,
  };
  vm.runInNewContext(code.code, host);
  const set = handlers.get('settings:set');
  await set(null, { libraryRoots: [root, child] });
  assert.deepEqual(written.pop(), { libraryRoots: [root, child] }, 'nothing is left out before a removal');
  host.removed.add(root);
  await set(null, { libraryRoots: [root, child, sibling] });
  assert.deepEqual(written.pop(), { libraryRoots: [child, sibling] }, 'a stale list does not bring the removed folder back');
  await set(null, { volume: 0.5 });
  assert.deepEqual(written.pop(), { volume: 0.5 }, 'saves without a folder list pass through');
  await handlers.get('settings:get')();
  await set(null, { libraryRoots: [child, root] });
  assert.deepEqual(written.pop(), { libraryRoots: [child, root] }, 'once the page has read the list, the folder can be added again');
}

// A saved root written another way than the watcher's resolved paths, or in
// the other Unicode form on a Mac, still counts as configured.
{
  const grab = (signature) => main.slice(main.indexOf(signature), main.indexOf('\n}\n', main.indexOf(signature)) + 3);
  const code = await transform(`${grab('function isPathInside(')}${grab('function isWatchedLibraryPath(')}globalThis.inside = isWatchedLibraryPath;`, { loader: 'ts', target: 'es2022' });
  const odd = `${root}/../music/./keep//`;
  const host = { caseFoldCachePath, process, resolve, settings: { get: () => ({ libraryRoots: [odd] }) } };
  vm.runInNewContext(code.code, host);
  assert.equal(host.inside(join(child, 'keep.mp3')), true, 'an unresolved spelling of the root');
  assert.equal(host.inside(join(root, 'gone.mp3')), false, 'its parent is not configured');
  if (process.platform === 'darwin') {
    host.settings = { get: () => ({ libraryRoots: [join(dir, 'M\u00fasica')] }) };
    assert.equal(host.inside(join(dir, 'Mu\u0301sica', 'x.mp3')), true, 'an NFC root covers an NFD event');
  }
}

// What the watcher said about the removed folder while the removal held it is
// replayed after the removal, and must not scan the folder back in.
{
  const grab = (signature) => {
    const begin = main.indexOf(signature);
    assert.ok(begin !== -1, signature);
    const close = signature.startsWith('const ') ? '\n});\n' : '\n}\n';
    return main.slice(begin, main.indexOf(close, begin) + close.length);
  };
  const pieces = [
    'let libraryMutationsQuiesced = 1;',
    'let watcherReconcile = Promise.resolve();',
    'let heldWatchPlans = [];',
    'let heldIncrementalRoots = new Set();',
    grab('const incrementalScans = new IncrementalScanGate('),
    grab('function isPathInside('),
    grab('function isWatchedLibraryPath('),
    grab('async function mapBounded<'),
    grab('function reconcileWatchedTargets('),
    grab('function logWatcherScanFailure('),
    grab('function mergeHeldWatchPlans('),
    grab('function resumeLibraryMutations('),
    'globalThis.hold = (plans, walks) => { heldWatchPlans = plans; heldIncrementalRoots = new Set(walks); };',
    'globalThis.resume = resumeLibraryMutations;',
    'globalThis.idle = () => watcherReconcile;',
  ];
  const started = [];
  const host = {
    IncrementalScanGate, caseFoldCachePath, process, resolve, console, setTimeout, Promise, Set, Math, Array,
    MISSING_RECHECK_DELAY_MS: 0, PATH_PROBE_CONCURRENCY: 4,
    probePath: async () => ({ presence: 'present' }),
    settings: { get: () => ({ libraryAutoWatch: true, libraryRoots: [child, sibling] }) },
    library: { markTracksMissingAsync: async () => {} },
    scanner: { start: async (targets, options) => { started.push({ targets: [...targets], force: !!options?.force }); } },
  };
  const code = await transform(pieces.join('\n'), { loader: 'ts', target: 'es2022' });
  vm.runInNewContext(code.code, host);
  const gone = join(root, 'gone.mp3'), kept = join(child, 'keep.mp3');
  host.hold([{ targets: [gone, kept, root], plan: { force: [gone, kept], incremental: [root] } }], [root, sibling]);
  host.resume();
  await host.idle();
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(JSON.stringify(started)).sort((a, b) => a.targets[0].localeCompare(b.targets[0])), [
    { targets: [kept], force: true },
    { targets: [sibling], force: false },
  ].sort((a, b) => a.targets[0].localeCompare(b.targets[0])), 'only the remaining folders are scanned');
}

// A metadata edit reads the file first; a slow read that the removal
// overtakes does not put the removed track back.
{
  const found = main.match(/async function readTrackBeforeMetadataEdit[\s\S]*?\n\}\n/)[0];
  const code = await transform(found + '\nglobalThis.run = readTrackBeforeMetadataEdit;', { loader: 'ts' });
  let present = true, removedDuringRead = false;
  const upserted = [];
  const host = {
    library: { pathNeedingFileRead: () => (present ? '/music/a.mp3' : null), upsertTracks: rows => upserted.push(...rows) },
    readTrackFile: async path => { if (removedDuringRead) present = false; return { path }; },
  };
  vm.runInNewContext(code.code, host);
  await host.run(1);
  assert.equal(upserted.length, 1, 'a track that is still there gets its file values');
  removedDuringRead = true;
  await host.run(1);
  assert.equal(upserted.length, 1, 'a track removed during the read is not re-created');
}

// Exercise the no-argument Scan actions against an empty configured list.
for (const [file, name] of [['AlbumsView', 'scanLibraryNow'], ['ArtistsView', 'scanLibraryNow'], ['FoldersView', 'scanLibraryNow']]) {
  const text = await readFile(`src/components/views/${file}.tsx`, 'utf8');
  const found = text.match(new RegExp(`  async function ${name}\\(\\): Promise<void> \\{[\\s\\S]*?\\n  \\}`));
  assert.ok(found, file);
  let requested = 0;
  const toasts = [];
  const code = await transform(found[0] + `\nglobalThis.run = ${name};`, { loader: 'ts' });
  const host = { api: { getSettings: async () => ({ libraryRoots: [] }), scanLibrary: async () => { requested++; } }, pushToast: toast => toasts.push(toast), setScanBusy() {} };
  vm.runInNewContext(code.code, host);
  await host.run();
  assert.equal(requested, 0, `${file} asks for a folder instead of scanning`);
  assert.ok(toasts.some(t => t.title.includes('Add a music folder')), file);
  assert.ok(!toasts.some(t => t.title === 'Library scan finished'), file);
}
{
  const text = await readFile('src/components/QuickPlayPalette.tsx', 'utf8');
  const found = text.match(/  async function runCommand[\s\S]*?\n  \}/)[0];
  let requested = 0, status = '';
  const host = { api: { getSettings: async () => ({ libraryRoots: [] }), scanLibrary: async () => { requested++; } }, setStatus: value => { status = value; } };
  const code = await transform(found + '\nglobalThis.run = runCommand;', { loader: 'ts' });
  vm.runInNewContext(code.code, host);
  await host.run('scan-library');
  assert.equal(requested, 0);
  assert.match(status, /Add a music folder/);
}
console.log('PASS folder removal: exact scope, overlaps, sibling, NFC/NFD, backup failure, stale preview, history import during the wait and the backup, stale folder lists, root spellings, watcher, held events, queue notification, no re-seed, slow reads, empty Scan actions');
