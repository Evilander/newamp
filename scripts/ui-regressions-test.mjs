import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transform, build } from 'esbuild';
import { EventEmitter } from 'node:events';

const tick = () => new Promise((resolve) => setImmediate(resolve));
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
  let executed = 0, prevented = 0, closed = 0;
  const ctx = await methods('src/components/QuickPlayPalette.tsx', ['onPaletteKeyDown'], {
    inputRef: { current: input }, executeSelected: () => { executed++; }, onClose: () => { closed++; },
  });
  for (const label of ['Close', 'NEXT', '+']) {
    ctx.onPaletteKeyDown({ key: 'Enter', nativeEvent: {}, target: { tagName: 'BUTTON', textContent: label }, preventDefault() { prevented++; } });
  }
  assert.equal(executed, 0);
  assert.equal(prevented, 0);
  ctx.onPaletteKeyDown({ key: 'Enter', nativeEvent: {}, target: input, preventDefault() { prevented++; } });
  assert.equal(executed, 1);
  assert.equal(prevented, 1);
  // The Enter that confirms an IME composition belongs to the input method.
  ctx.onPaletteKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, target: input, preventDefault() { prevented++; } });
  ctx.onPaletteKeyDown({ key: 'Enter', keyCode: 229, nativeEvent: {}, target: input, preventDefault() { prevented++; } });
  assert.equal(executed, 1);
  assert.equal(prevented, 1);
  // Escape that cancels a composition belongs to the input method too; any other Escape closes.
  ctx.onPaletteKeyDown({ key: 'Escape', nativeEvent: { isComposing: true }, target: input, preventDefault() { prevented++; } });
  ctx.onPaletteKeyDown({ key: 'Escape', keyCode: 229, nativeEvent: {}, target: input, preventDefault() { prevented++; } });
  assert.equal(closed, 0);
  ctx.onPaletteKeyDown({ key: 'Escape', nativeEvent: {}, target: input, preventDefault() { prevented++; } });
  assert.equal(closed, 1);
}

// Playing a row queues the list it came from: the search's tracks, or the whole Ask answer for a row from that section.
{
  const played = [];
  const askTracks = [{ id: 7 }, { id: 8 }, { id: 9 }];
  const trackQueueContext = [{ id: 1 }, { id: 2 }];
  const ctx = await methods('src/components/QuickPlayPalette.tsx', ['executeItem'], {
    askTracks, trackQueueContext, setView() {}, onClose() {},
    playQueue: async (tracks, index) => { played.push([Array.from(tracks, (track) => track.id), index]); },
  });
  const row = (id, ask) => ({ kind: 'track', ask, track: { id } });
  await ctx.executeItem(row(8, true));
  await ctx.executeItem(row(2, false));
  assert.deepEqual(played, [[[7, 8, 9], 1], [[1, 2], 1]], 'an Ask row plays the whole answer from its place, a search row the search from its own');
  ctx.trackQueueContext = [];
  await ctx.executeItem(row(2, false));
  assert.deepEqual(played.at(-1), [[2], 0], 'with nothing listed the row plays by itself');
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
  const snapshot = { fetched: 1 };
  const ctx = await methods('src/components/views/AlbumsView.tsx', ['loadMoreAlbums'], {
    loadingAlbums: false, albumPageRequestRef: { current: false }, hasMoreAlbums: true,
    albumRequestGeneration: generation, albumQuery: 'old', showMissingArtOnly: false, albumSort: 'artist', randomSeed: 1,
    ALBUM_PAGE_SIZE: 240, albums: ['old query'], api: { getAlbums: () => read.promise },
    albumViewSnapshot: snapshot, appendAlbumPage: (current, page) => [...current, ...page],
    setAlbums(update) { albums = update(albums); }, setHasMoreAlbums(value) { hasMore = value; },
    setLoadingAlbums(value) { loading = value; }, pushToast() {},
  });
  const pending = ctx.loadMoreAlbums(); generation.current++;
  read.resolve(['old page']); await pending;
  assert.deepEqual(albums, ['new query']); assert.equal(loading, true); assert.equal(hasMore, true);
  assert.equal(snapshot.fetched, 1, 'a stale page does not move the next offset');
}

// A scan that finishes while someone is browsing the grid reads it again where it stands; a new query starts over.
{
  const file = source('src/components/views/AlbumsView.tsx');
  const effect = find(file, (node) => ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' && node.arguments[0]?.getText(file).includes('hydratedSnapshotRef.current'));
  assert.ok(effect, 'the album list effect is found');
  const library = Array.from({ length: 2000 }, (_, i) => ({ albumKey: `k${i}` }));
  const reads = [], resets = [];
  let shown = [], more = null;
  const ctx = vm.createContext({
    albumQuery: '', showMissingArtOnly: false, albumSort: 'artist', randomSeed: 1,
    listedKeyRef: { current: null }, hydratedSnapshotRef: { current: false }, catalogStale: false,
    albumRequestGeneration: { current: 0 }, albumPageRequestRef: { current: true },
    albumScrollTopRef: { current: 0 }, albumViewSnapshot: { scrollTop: 0, fetched: 0 },
    albumTracksCache: new Map(), ALBUM_PAGE_SIZE: 240, console,
    setSelected: (value) => resets.push(['selected', value]), setTracks: (rows) => resets.push(['tracks', rows.length]),
    setLoadingAlbums() {}, setAlbums: (rows) => { shown = rows; }, setHasMoreAlbums: (value) => { more = value; }, pushToast() {},
    api: { getAlbums: async (query) => { reads.push(query); return library.slice(query.offset, query.offset + query.limit); } },
  });
  vm.runInContext((await transform(`globalThis.setup = ${effect.arguments[0].getText(file)}`, { loader: 'tsx' })).code, ctx);

  let cleanup = ctx.setup();
  await tick();
  assert.equal(reads[0].limit, 241, 'a first load reads one page');
  assert.equal(shown.length, 240);
  assert.equal(more, true);

  // Scrolled three pages in, and the scan finishes: the same effect runs again for the same query.
  ctx.albumViewSnapshot.fetched = 720;
  ctx.albumScrollTopRef.current = 5000;
  ctx.albumViewSnapshot.scrollTop = 5000;
  resets.length = 0;
  cleanup();
  cleanup = ctx.setup();
  await tick();
  assert.equal(reads[1].limit, 721, 'the pages already loaded are read again');
  assert.equal(reads[1].offset, 0);
  assert.equal(shown.length, 720, 'and the grid keeps its length');
  assert.equal(more, true);
  assert.equal(ctx.albumScrollTopRef.current, 5000, 'the scroll position is kept');
  assert.equal(ctx.albumViewSnapshot.scrollTop, 5000);
  assert.deepEqual(resets, [], 'nothing is closed or cleared');

  // A new query is a new list.
  ctx.albumQuery = 'abba';
  cleanup();
  cleanup = ctx.setup();
  await tick();
  assert.equal(reads[2].limit, 241, 'a new query reads one page');
  assert.equal(ctx.albumScrollTopRef.current, 0, 'from the top');
  assert.deepEqual(resets, [['selected', null], ['tracks', 0]]);
  assert.equal(shown.length, 240);
  cleanup();
}

// A queue row dragged out of the drawn window still ends its drag, though its own dragend never arrives.
{
  const bundled = await build({ entryPoints: ['src/components/dragEnd.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { watchDragEnd } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const listeners = new Map();
  const fakeWindow = {
    addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener)),
  };
  const fire = (type) => { for (const listener of listeners.get(type) ?? []) listener({ type }); };
  const attached = () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0);

  const file = source('src/components/views/NowPlayingView.tsx');
  const effect = find(file, (node) => ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' && node.arguments[0]?.getText(file).includes('watchDragEnd'));
  assert.ok(effect, 'the queue watches for the end of a drag');
  const row = { isConnected: true };
  const queried = [];
  let ended = 0;
  const ctx = vm.createContext({
    draggedQueueIndex: 5, window: fakeWindow, watchDragEnd, endQueueDrag: () => { ended += 1; },
    queueListRef: { current: { querySelector: (selector) => { queried.push(selector); return row; } } },
  });
  vm.runInContext((await transform(`globalThis.setup = ${effect.arguments[0].getText(file)}`, { loader: 'tsx' })).code, ctx);

  const stop = ctx.setup();
  assert.deepEqual(queried, ['[data-newamp-queue-row="5"]'], 'it looks for the row being dragged');
  fire('mousemove');
  assert.equal(ended, 0, 'mouse moves leave a drag alone while its row is drawn');
  fire('dragend');
  assert.equal(ended, 1, 'a dragend that reaches the window ends it');
  fire('drop');
  assert.equal(ended, 2, 'so does a drop');
  row.isConnected = false;
  fire('mousemove');
  assert.equal(ended, 3, 'a drag whose row has been scrolled away ends on the next mouse move');
  stop();
  assert.equal(attached(), 0, 'and nothing is left listening');

  ctx.draggedQueueIndex = null;
  assert.equal(ctx.setup(), undefined);
  assert.equal(attached(), 0, 'no drag, no listeners');
}

// Playlist rows and queue rows end a drag the same way when their row is scrolled out of the drawn window.
{
  const bundled = await build({ entryPoints: ['src/components/dragEnd.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { watchDragEnd } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const file = source('src/components/views/PlaylistView.tsx');
  const effects = [];
  const collect = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' && node.arguments[0]?.getText(file).includes('watchDragEnd')) effects.push(node);
    ts.forEachChild(node, collect);
  };
  collect(file);
  assert.equal(effects.length, 2, 'both lists watch for the end of a drag');

  for (const { name, state, setter, windowName, row } of [
    { name: 'saved playlist', state: 'draggedPlaylistTrackIndex', setter: 'setDraggedPlaylistTrackIndex', windowName: 'selectedPlaylistWindow', row: 'data-newamp-playlist-track-row' },
    { name: 'queue', state: 'draggedQueueIndex', setter: 'setDraggedQueueIndex', windowName: 'queueWindow', row: 'data-newamp-queue-track-row' },
  ]) {
    const effect = effects.find((candidate) => candidate.arguments[0].getText(file).includes(state));
    assert.ok(effect, `the ${name} list has its own watch`);
    const listeners = new Map();
    const fakeWindow = {
      addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener)),
    };
    const fire = (type) => { for (const listener of listeners.get(type) ?? []) listener({ type }); };
    const attached = () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0);
    const element = { isConnected: true };
    const queried = [];
    const ended = [];
    const ctx = vm.createContext({
      watchDragEnd, window: fakeWindow,
      [state]: 3,
      [setter]: (value) => ended.push(value),
      [windowName]: { scrollRef: { current: { querySelector: (selector) => { queried.push(selector); return element; } } } },
    });
    vm.runInContext((await transform(`globalThis.setup = ${effect.arguments[0].getText(file)}`, { loader: 'tsx' })).code, ctx);

    const stop = ctx.setup();
    assert.deepEqual(queried, [`[${row}="3"]`], `${name}: it looks for the row being dragged`);
    fire('mousemove');
    assert.deepEqual(ended, [], `${name}: mouse moves leave a drag alone while its row is drawn`);
    fire('dragend');
    assert.deepEqual(ended, [null], `${name}: a dragend that reaches the window clears the drag`);
    element.isConnected = false;
    fire('mousemove');
    assert.deepEqual(ended, [null, null], `${name}: a drag whose row was scrolled away ends on the next mouse move`);
    stop();
    assert.equal(attached(), 0, `${name}: nothing is left listening`);
    ctx[state] = null;
    assert.equal(ctx.setup(), undefined);
    assert.equal(attached(), 0, `${name}: no drag, no listeners`);
  }
}

// Restoring a backup stops this page writing its old session over the restored one.
{
  const calls = [];
  const timers = [];
  const make = async (restore) => {
    calls.length = 0;
    timers.length = 0;
    return methods('src/components/views/SettingsView.tsx', ['restoreBackup'], {
      api: { restoreSupportBackup: restore },
      stopPersistingSession: () => calls.push('stop'),
      setSupportBackupStatus: (value) => calls.push(`status: ${value}`),
      setSupportRestore: () => calls.push('restore'),
      pushToast: () => calls.push('toast'),
      window: { setTimeout: (callback, delay) => { calls.push('reload scheduled'); timers.push(delay); }, location: { reload() {} } },
    });
  };
  let ctx = await make(async () => ({ restored: ['settings.json'] }));
  await ctx.restoreBackup();
  assert.ok(calls.includes('stop'), 'a restore stops the session writes');
  assert.ok(calls.indexOf('stop') < calls.indexOf('reload scheduled'), 'before the reload is scheduled');
  assert.ok(calls.indexOf('stop') < calls.indexOf('restore'), 'as soon as the restore has succeeded');

  ctx = await make(async () => null);
  await ctx.restoreBackup();
  assert.ok(!calls.includes('stop'), 'a cancelled restore changes nothing');

  ctx = await make(async () => { throw new Error('backup is damaged'); });
  await ctx.restoreBackup();
  assert.ok(!calls.includes('stop'), 'nor does one that failed');
  assert.deepEqual(timers, [], 'and neither reloads');
}

// A page requested before a scan finished is not appended to the list the scan's reload built.
{
  const before = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
  const after = [{ id: 100 }, { id: 101 }, ...before];
  const latePage = deferred();
  let library = before, reads = 0, tracks = before.slice(0, 4), hasMore = true;
  const bindings = {
    libraryQuery: '', sort: 'artist', LIBRARY_PAGE_SIZE: 4, LIBRARY_MORE_PAGE_SIZE: 4, console,
    loadGenerationRef: { current: 1 }, rowsReadRef: { current: 4 }, loadMoreInFlightRef: { current: false },
    matchingCountRef: { current: 10 }, hasMoreTracks: true,
    window: { setTimeout: (callback) => setTimeout(callback, 0) },
    api: {
      getTracks: (query) => {
        reads += 1;
        // The first read is the scroll's, still on its way when the scan ends.
        if (reads === 1) return latePage.promise;
        return Promise.resolve(library.slice(query.offset, query.offset + query.limit));
      },
      getTrackCount: async () => library.length,
    },
    appendTrackPage: (current, page) => [...current, ...page],
    setTracks: (update) => { tracks = typeof update === 'function' ? update(tracks) : update; },
    setHasMoreTracks: (value) => { hasMore = value; }, setMatchingTrackCount() {}, setLoadMoreFailed() {}, setLoadingMore() {},
    pushToast() {}, errorText: String,
  };
  const ctx = await methods('src/components/views/LibraryView.tsx', ['loadMoreTracks', 'reloadLoadedRows'], bindings);
  const ids = () => Array.from(tracks, (row) => row.id);

  const scrolling = ctx.loadMoreTracks();
  library = after;
  await ctx.reloadLoadedRows();
  assert.deepEqual(ids(), [100, 101, 1, 2], 'the reload rebuilt the loaded rows from the library as it is now');
  latePage.resolve(before.slice(4, 8));
  await scrolling;
  assert.deepEqual(ids(), [100, 101, 1, 2], 'the page read before the scan is dropped, not appended after them');
  assert.equal(ctx.rowsReadRef.current, 4, 'so the next page starts where the reloaded rows end');

  ctx.loadMoreInFlightRef.current = false;
  await ctx.loadMoreTracks();
  assert.deepEqual(ids(), [100, 101, 1, 2, 3, 4, 5, 6], 'and reads the rows between them');
  assert.equal(hasMore, true);
}

// The exclusive row claims untouched samples where that is checked, and says what a forced bit depth costs.
{
  const React = { Fragment: Symbol('Fragment'), createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const text = (node) => (node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children));
  const render = async (platform, negotiated) => {
    const ctx = await methods('src/components/views/SettingsView.tsx', ['ExclusiveModeRow'], {
      React,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      usePlayerStore: (select) => select({ setBitPerfectExclusive() {}, setBitPerfectExclusiveDevice() {} }),
      engine: { getExclusiveInfo: () => ({ active: !!negotiated, negotiated, fallbackReason: null }) },
      api: { platform },
      exclusiveBackendLabel: () => 'Backend',
      resamplerName: (name) => name,
      reportSettingError() {},
    });
    return text(ctx.ExclusiveModeRow({ settings: { bitPerfectExclusive: true, bitPerfectExclusiveDeviceId: null }, onSettings() {} }));
  };

  assert.match(await render('win32'), /native Backend, untouched samples to the DAC/);
  assert.match(await render('linux'), /untouched samples to the DAC/);
  const mac = await render('darwin');
  assert.doesNotMatch(mac, /untouched samples/);
  assert.match(mac, /native Backend, exclusive device, with the source's rate and depth requested\. macOS can still convert to the device's own format, and NewAmp does not check that\./);

  const reduced = { bitPerfect: false, resampled: false, upmixed: false, channelsUnknown: false, lossless: true, depthPreserved: false, deviceName: 'DAC', format: 'S24', sampleRate: 96000 };
  assert.match(await render('win32', reduced), /bit depth reduced \(no dither\)/);

  // The status line and the Playback notice claim bit-perfect samples only where that is checked.
  const exact = { ...reduced, bitPerfect: true, depthPreserved: true };
  assert.match(await render('win32', exact), /S24 @ 96\.0 kHz · bit-perfect/);
  assert.match(await render('linux', exact), / · bit-perfect/);
  const macStatus = await render('darwin', exact);
  assert.match(macStatus, /S24 @ 96\.0 kHz · exclusive/);
  assert.doesNotMatch(macStatus, /· bit-perfect/);
  assert.match(macStatus, /Bit-Perfect Exclusive/, 'the feature keeps its name');

  const notice = async (platform) => {
    const ctx = await methods('src/components/views/SettingsView.tsx', ['DspBypassedNotice'], { React, api: { platform } });
    return text(ctx.DspBypassedNotice());
  };
  const rest = 'Bit-Perfect Exclusive is on — crossfade, ReplayGain, limiter, preamp, EQ and software volume are';
  assert.equal(await notice('win32'), `${rest} bypassed so the DAC receives untouched samples. Use your device's own volume.`);
  assert.equal(await notice('linux'), `${rest} bypassed so the DAC receives untouched samples. Use your device's own volume.`);
  assert.equal(await notice('darwin'), `${rest} bypassed; the device is held exclusively at the source's rate. Use your device's own volume.`);
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

// Saving one service's credentials leaves the other's unsaved text alone, and text typed while a save is in flight survives it.
{
  const drafts = await build({ entryPoints: ['src/components/views/settingsDrafts.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { mergeSavedSettings } = await import('data:text/javascript;base64,' + Buffer.from(drafts.outputFiles[0].text).toString('base64'));
  const stored = { lastfmApiKey: null, lastfmSharedSecret: null, openaiApiKey: null, openaiModel: 'gpt-5', textScale: 1 };
  const credentials = (settings) => ({
    lastfmApiKey: settings.lastfmApiKey, lastfmSharedSecret: settings.lastfmSharedSecret,
    openaiApiKey: settings.openaiApiKey, openaiModel: settings.openaiModel,
  });

  // Runs the page's own save handler against a settings writer that answers when told to, and
  // returns what the page then shows: the saved settings merged with the draft on screen.
  async function save(handler, shown, whileSaving = () => {}) {
    const gate = deferred();
    const accepted = [];
    const ctx = await methods('src/components/views/SettingsView.tsx', ['saveLastfmCredentials', 'saveOpenAiSettings'], {
      settings: shown,
      DEFAULT_SETTINGS: { openaiModel: 'gpt-5' },
      saveSettings: async (patch) => { await gate.promise; return { ...stored, ...patch }; },
      acceptSettings: (saved, written) => accepted.push({ saved, written }),
      setLastfmStatus() {}, setOpenAiStatus() {},
    });
    const pending = ctx[handler]();
    await Promise.resolve();
    const stillShown = whileSaving(shown) ?? shown;
    gate.resolve();
    await pending;
    assert.equal(accepted.length, 1);
    const { saved, written } = accepted[0];
    return mergeSavedSettings(saved, stillShown, credentials(stored), written ? plain(written) : undefined);
  }
  const plain = (value) => JSON.parse(JSON.stringify(value));

  const typed = { ...stored, lastfmApiKey: ' lf-key ', lastfmSharedSecret: 'lf-secret', openaiApiKey: 'sk-typed', openaiModel: 'gpt-5-mini' };

  const afterLastfm = await save('saveLastfmCredentials', typed);
  assert.equal(afterLastfm.lastfmApiKey, 'lf-key', 'the saved Last.fm key replaces the text it came from');
  assert.equal(afterLastfm.openaiApiKey, 'sk-typed', 'an unsaved OpenAI key survives a Last.fm save');
  assert.equal(afterLastfm.openaiModel, 'gpt-5-mini');

  const afterOpenAi = await save('saveOpenAiSettings', typed);
  assert.equal(afterOpenAi.openaiApiKey, 'sk-typed');
  assert.equal(afterOpenAi.openaiModel, 'gpt-5-mini');
  assert.equal(afterOpenAi.lastfmApiKey, ' lf-key ', 'an unsaved Last.fm key survives an OpenAI save');
  assert.equal(afterOpenAi.lastfmSharedSecret, 'lf-secret');

  const edited = await save('saveLastfmCredentials', typed, (shown) => ({ ...shown, lastfmApiKey: 'lf-key-edited' }));
  assert.equal(edited.lastfmApiKey, 'lf-key-edited', 'text typed while the save was in flight is not thrown away');
  assert.equal(edited.lastfmSharedSecret, 'lf-secret');

  // Any other save keeps every unsaved credential, as before.
  assert.equal(mergeSavedSettings({ ...stored, textScale: 1.2 }, typed, credentials(stored)).openaiApiKey, 'sk-typed');
  assert.equal(mergeSavedSettings({ ...stored, textScale: 1.2 }, typed, credentials(stored)).textScale, 1.2);
  assert.deepEqual(mergeSavedSettings(stored, null, null), stored, 'with nothing on screen yet the saved settings are shown');
}

// A text-size save that fails says so, instead of the thumb snapping back with no word.
{
  const toasts = [];
  const accepted = [];
  const ctx = await methods('src/components/views/SettingsView.tsx', ['changeTextScale'], {
    saveSettings: async (patch) => { if (patch.textScale > 1.3) throw new Error('settings file is read-only'); return patch; },
    acceptSettings: (saved) => accepted.push(saved),
    reportSettingError: (title, err) => toasts.push({ title, detail: err.message }),
  });
  await ctx.changeTextScale(1.1);
  assert.deepEqual(accepted.map((saved) => saved.textScale), [1.1]);
  await ctx.changeTextScale(1.35);
  assert.deepEqual(toasts, [{ title: 'Could not change the text size', detail: 'settings file is read-only' }]);
  assert.equal(accepted.length, 1, 'a failed save is not shown as saved');
}

// Enter and the blur after it save a port or an Auto DJ target once.
{
  const saves = [];
  let settleSave;
  const port = await methods('src/components/views/SettingsView.tsx', ['commitPort'], {
    portDraft: '8080', port: 7000, savingPort: { current: null }, setPortError() {},
    change: (patch) => { saves.push(patch); return new Promise((resolve) => { settleSave = resolve; }); },
  });
  port.commitPort();
  port.commitPort();
  assert.equal(saves.length, 1, 'the blur after Enter does not save the port again');
  settleSave(false);
  await tick();
  port.commitPort();
  assert.equal(saves.length, 2, 'a save that failed can be tried again');
  port.portDraft = '9090';
  port.commitPort();
  assert.equal(saves.length, 3, 'a different value typed meanwhile is not held back');

  const targets = [];
  let settleTarget;
  const bindings = {
    autoDjTargetDraft: '24', autoDjTarget: 12, normalizeAutoDjTarget: (value) => value, setAutoDjTargetDraft() {},
    savingAutoDjTarget: { current: null },
    setAutoDjTarget: (value) => { targets.push(value); return new Promise((resolve) => { settleTarget = resolve; }); },
  };
  const autoDj = await methods('src/components/views/PlaylistView.tsx', ['commitAutoDjTarget'], bindings);
  autoDj.commitAutoDjTarget();
  autoDj.commitAutoDjTarget();
  assert.deepEqual(targets, [24], 'the blur after Enter does not refill the queue twice');
  settleTarget();
  await tick();
  autoDj.autoDjTarget = 24;
  autoDj.commitAutoDjTarget();
  assert.deepEqual(targets, [24], 'and the saved value is not saved again');
}

// Library folders compare equal across Unicode forms only where the file system does.
{
  const composed = '/Music/Caf\u00e9';
  const decomposed = '/Music/Cafe\u0301';
  for (const [platform, same] of [['darwin', true], ['linux', false], ['win32', false]]) {
    const ctx = await methods('src/components/views/SettingsView.tsx', ['folderIsSameOrInside'], { api: { platform } });
    assert.equal(ctx.folderIsSameOrInside(decomposed, composed), same, `${platform}: two spellings of an accented folder`);
    assert.equal(ctx.folderIsSameOrInside(`${composed}/Live`, composed), true, `${platform}: a folder inside the same spelling`);
  }
}

console.log('PASS: palette button activation and composition keys; Quick Play queue contexts; playlist selection/edit races; artist response order; album page invalidation; album grid reload in place; Library reload against a page in flight; queue drag end; remote revocation; shared settings; unsaved credentials; port and target saves; folder spellings');
