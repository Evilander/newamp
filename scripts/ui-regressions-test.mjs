import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transform, build } from 'esbuild';
import { EventEmitter } from 'node:events';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const source = (path) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(root, predicate) {
  if (predicate(root)) return root;
  let result;
  ts.forEachChild(root, (node) => { result ??= find(node, predicate); });
  return result;
}
async function methods(path, names, bindings) {
  const file = source(path);
  const text = names.map((name) => {
    const node = find(file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, `Missing ${name}`);
    return node.getText(file);
  }).join('\n');
  const ctx = vm.createContext(bindings);
  vm.runInContext((await transform(text, { loader: 'tsx' })).code, ctx);
  return ctx;
}

// Enter on a native action must retain the browser's normal activation.
{
  const input = {};
  let executed = 0, prevented = 0;
  const ctx = await methods('src/components/QuickPlayPalette.tsx', ['onPaletteKeyDown'], {
    inputRef: { current: input }, executeSelected: () => { executed++; },
  });
  for (const label of ['Close', 'NEXT', '+']) {
    ctx.onPaletteKeyDown({ key: 'Enter', target: { tagName: 'BUTTON', textContent: label }, preventDefault() { prevented++; } });
  }
  assert.equal(executed, 0);
  assert.equal(prevented, 0);
  ctx.onPaletteKeyDown({ key: 'Enter', target: input, preventDefault() { prevented++; } });
  assert.equal(executed, 1);
  assert.equal(prevented, 1);
}

// A refresh from playlist A must not replace B, or undo a later edit to A.
{
  const a = { id: 1, name: 'A', trackCount: 2 };
  const b = { id: 2, name: 'B', trackCount: 1 };
  const reads = [];
  let rows = [{ id: 11 }], saved = [];
  const noop = () => {};
  const bindings = {
    selectedPlaylist: a, selectedPlaylistRef: { current: a }, trackRequestRef: { current: 0 },
    listRequestRef: { current: 0 }, playlistLoadRef: { current: null }, pendingSaves: { current: 0 },
    persistQueue: { current: Promise.resolve() }, openTracks: { current: rows },
    setSelectedPlaylistState(value) { bindings.selectedPlaylist = value; ctx.selectedPlaylist = value; },
    setSelectedPlaylistTracks(value) { rows = value; },
    setPlaylists: noop, setSmartRules: noop, setSelectedSmartRule: noop, setBusy: noop,
    setPlaylistTrackFilter: noop, setPlaylistName: noop, setPlaylistCoverPath: noop, setClearPlaylistCover: noop,
    pushToast: noop, playQueue: async () => {},
    moveQueueItem: (tracks, _index, from, to) => { const copy = [...tracks]; copy.splice(to, 0, ...copy.splice(from, 1)); return { queue: copy }; },
    api: {
      getPlaylists: async () => [a, b], getSmartPlaylistRules: async () => [],
      getPlaylistTracks(id) { const read = { id, ...deferred() }; reads.push(read); return read.promise; },
      savePlaylist: async (value) => { saved.push(value); return value; },
    },
  };
  const ctx = await methods('src/components/views/PlaylistView.tsx', [
    'setSelectedPlaylist', 'refreshPlaylists', 'loadPlaylist', 'moveSelectedPlaylistTrack', 'persistPlaylistTracks', 'closePlaylist',
  ], bindings);
  await ctx.refreshPlaylists();
  const oldA = reads.at(-1);
  const loadB = ctx.loadPlaylist(b, false, true);
  reads.at(-1).resolve([{ id: 21 }]); await loadB;
  oldA.resolve([{ id: 11 }, { id: 12 }]); await Promise.resolve();
  assert.deepEqual(rows.map((r) => r.id), [21]);
  assert.equal(bindings.selectedPlaylistRef.current.id, 2);

  ctx.setSelectedPlaylist(a);
  bindings.openTracks.current = rows = [{ id: 11 }, { id: 12 }];
  a.trackCount = 3;
  await ctx.refreshPlaylists();
  const beforeEdit = reads.at(-1);
  ctx.moveSelectedPlaylistTrack(0, 1);
  beforeEdit.resolve([{ id: 11 }, { id: 12 }, { id: 13 }]);
  await bindings.persistQueue.current;
  assert.deepEqual(rows.map((r) => r.id), [12, 11]);
  assert.equal(saved.at(-1).id, 1);
  assert.deepEqual(Array.from(saved.at(-1).trackIds), [12, 11]);

  const loadA = ctx.loadPlaylist(a, false, true);
  const delayedA = reads.at(-1);
  ctx.closePlaylist();
  delayedA.resolve([{ id: 11 }]); await loadA;
  assert.equal(bindings.selectedPlaylistRef.current, null);
  assert.equal(rows.length, 0);
}

// The old artist's slower response cannot become the new artist's tracks.
{
  const file = source('src/components/views/ArtistsView.tsx');
  const effect = find(file, (node) => ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' && node.arguments[0]?.getText(file).includes('api.getArtistTracks'));
  assert.ok(effect);
  const requests = [], result = [];
  const ctx = vm.createContext({ selected: 'A', setTracks: (rows) => result.push(rows), pushToast() {}, api: {
    getArtistTracks() { const request = deferred(); requests.push(request); return request.promise; },
  } });
  vm.runInContext((await transform(`globalThis.setup = ${effect.arguments[0].getText(file)}`, { loader: 'tsx' })).code, ctx);
  const cancelA = ctx.setup(); cancelA(); ctx.selected = 'B'; const cancelB = ctx.setup();
  requests[1].resolve(['B']); await Promise.resolve();
  requests[0].resolve(['A']); await Promise.resolve();
  assert.deepEqual(result.at(-1), ['B']); cancelB();
}

// Query changes invalidate an in-flight album page, including its finally.
{
  const read = deferred();
  let albums = ['new query'], loading = true, hasMore = true;
  const generation = { current: 1 };
  const ctx = await methods('src/components/views/AlbumsView.tsx', ['loadMoreAlbums'], {
    loadingAlbums: false, albumPageRequestRef: { current: false }, hasMoreAlbums: true,
    albumRequestGeneration: generation, albumQuery: 'old', showMissingArtOnly: false, albumSort: 'artist', randomSeed: 1,
    ALBUM_PAGE_SIZE: 240, albums: ['old query'], api: { getAlbums: () => read.promise },
    setAlbums(update) { albums = update(albums); }, setHasMoreAlbums(value) { hasMore = value; },
    setLoadingAlbums(value) { loading = value; }, pushToast() {},
  });
  const pending = ctx.loadMoreAlbums(); generation.current++;
  read.resolve(['old page']); await pending;
  assert.deepEqual(albums, ['new query']); assert.equal(loading, true); assert.equal(hasMore, true);
}

// Run the actual server handler without a listener or profile.
{
  const bundled = await build({ entryPoints: ['electron/radio-brain.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  const { RadioBrain } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  let token = 'first', listener, off = 0, ended = 0;
  const writes = [];
  const brain = new RadioBrain({ library: {}, port: 17117, getToken: () => token, getNowPlaying: () => null,
    onNowPlaying: (callback) => { listener = callback; return () => { off++; }; }, control: () => true });
  const request = new EventEmitter(); Object.assign(request, { method: 'GET', url: '/now/events?token=first', headers: { host: 'localhost' } });
  const response = { setHeader() {}, flushHeaders() {}, write(value) { writes.push(value); }, end() { ended++; } };
  await brain.handle(request, response);
  token = 'second'; listener({ title: 'must not leak' });
  assert.equal(ended, 1); assert.equal(off, 1); assert.ok(!writes.join('').includes('must not leak'));
  assert.equal(brain.debugConnectionCounts().sseClients, 0);
  request.emit('close');
  assert.equal(off, 1, 'revocation and socket close share one cleanup');
}

// Saved settings reach the shared store in submission order; drafts do not.
{
  const first = deferred();
  const writes = [], snapshots = [];
  let store = { settings: { textScale: 1, performanceTier: 'auto', equalizer: [3, 4] } };
  const ctx = await methods('src/components/views/SettingsView.tsx', ['publishSavedSettings', 'saveSettings'], {
    settingsWrites: Promise.resolve(), usePlayerStore: { setState: (update) => { store = { ...store, ...update(store) }; snapshots.push(store.settings); } },
    api: { setSettings(patch) { writes.push(patch); return writes.length === 1 ? first.promise : Promise.resolve({ textScale: 1.2, performanceTier: 'lite', equalizer: [0, 0] }); } },
  });
  const one = ctx.saveSettings({ textScale: 1.2 });
  const two = ctx.saveSettings({ performanceTier: 'lite' });
  await Promise.resolve();
  assert.equal(writes.length, 1, 'later settings writes wait for the earlier snapshot');
  first.resolve({ textScale: 1.2, performanceTier: 'auto', equalizer: [0, 0] });
  await Promise.all([one, two]);
  assert.equal(snapshots.at(-1).textScale, 1.2);
  assert.equal(snapshots.at(-1).performanceTier, 'lite');
  assert.deepEqual(snapshots.at(-1).equalizer, [3, 4], 'unrelated settings responses preserve optimistic equalizer edits');
}

console.log('PASS: palette button activation; playlist selection/edit races; artist response order; album page invalidation; remote revocation; shared settings');
