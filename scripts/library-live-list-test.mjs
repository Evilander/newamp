// The Library list as it behaves while the library changes under it: filled by
// a scan started from the empty-library screen, paged by scrolling, searched
// with a wait that follows what a query costs. LibraryView runs for real, with
// its hooks executed by a small hand-written dispatcher instead of a DOM; the
// app's api is a fake library that grows, and time is stepped by hand. Child
// components other than the track pane are left unrendered.
// Run: node scripts/library-live-list-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Library live list test timed out'); process.exit(1); }, 90000);
deadline.unref();

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── hand-stepped time ──────────────────────────────────────────────────────
// `work` is time the fake library spends answering: it moves the clock a query
// is timed with but not the timers, so a query never reorders them.
const time = { now: 1_000_000, work: 0, nextId: 1, timers: new Map() };
const setTimer = (run, ms = 0) => {
  const id = time.nextId++;
  time.timers.set(id, { at: time.now + ms, run });
  return id;
};
const clearTimer = (id) => { time.timers.delete(id); };
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 4; i += 1) await turn();
}
async function advance(ms) {
  const end = time.now + ms;
  for (;;) {
    await settle();
    const due = [...time.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    time.now = Math.max(time.now, due[1].at);
    time.timers.delete(due[0]);
    due[1].run();
  }
  time.now = end;
  await settle();
}

Date.now = () => time.now;
Object.defineProperty(globalThis, 'performance', { configurable: true, writable: true, value: { now: () => time.now + time.work } });
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: { getItem: () => null, setItem() {}, removeItem() {} },
});
globalThis.window = {
  setTimeout: setTimer,
  clearTimeout: clearTimer,
  requestAnimationFrame: (run) => setTimer(() => run(time.now), 16),
  cancelAnimationFrame: clearTimer,
  addEventListener() {},
  removeEventListener() {},
  localStorage: globalThis.localStorage,
};
globalThis.document = { querySelector: () => null };

// ── the fake library and the app singletons it stands in for ───────────────
const harness = { api: null, player: null };
globalThis.__libraryLiveTest = harness;
const stubSingletons = {
  name: 'stub-app-singletons',
  setup(b) {
    b.onLoad({ filter: /[\\/]store[\\/]usePlayerStore\.ts$/ }, () => ({
      loader: 'js',
      contents: `
        const harness = globalThis.__libraryLiveTest;
        export const usePlayerStore = Object.assign((selector) => selector(harness.player), {
          getState: () => harness.player, setState() {}, subscribe: () => () => {},
        });
      `,
    }));
    b.onLoad({ filter: /[\\/]src[\\/]lib[\\/]api\.ts$/ }, () => ({
      loader: 'js',
      contents: `
        export const api = new Proxy({}, { get: (_, key) => globalThis.__libraryLiveTest.api[key] });
        export const inElectron = true;
        export const winctl = undefined;
      `,
    }));
  },
};

const bundled = await build({
  stdin: {
    contents: `
      export { LibraryView, LIBRARY_SCAN_REFRESH_MS, appendTrackPage, createScanRefreshGate, searchDebounceMs, wantsNextTrackPage } from './src/components/views/LibraryView';
      export { EmptyLibrary } from './src/components/views/EmptyLibrary';
      export { buildArchiveCompass } from './shared/archive-compass';
      export * as React from 'react';
    `,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', jsx: 'automatic', logLevel: 'silent',
  plugins: [stubSingletons],
  loader: { '.webp': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl' },
  define: { 'import.meta.env.DEV': 'false' },
});
const m = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

class FakeLibrary {
  constructor() {
    this.tracks = [];
    this.calls = [];
    this.queryMs = 5;
    this.failTracks = false;
    this.scanListeners = new Set();
    this.removedListeners = new Set();
    this.nextId = 1;
  }

  add(count, { artist = (n) => `Artist ${String(n).padStart(6, '0')}` } = {}) {
    for (let i = 0; i < count; i += 1) {
      const id = this.nextId++;
      this.tracks.push({ id, path: `/music/${id}.flac`, title: `Song ${id}`, artist: artist(id), album: `Album ${id}`, loved: 0 });
    }
  }

  ordered(search) {
    const needle = (search ?? '').toLowerCase();
    return this.tracks
      .filter((track) => !needle || `${track.title} ${track.artist}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.artist < b.artist ? -1 : a.artist > b.artist ? 1 : a.id - b.id));
  }

  remove(ids) {
    const gone = new Set(ids);
    this.tracks = this.tracks.filter((track) => !gone.has(track.id));
    for (const listener of this.removedListeners) listener(ids);
  }

  emitScan(progress) {
    for (const listener of this.scanListeners) listener({ current: '', startedAt: 0, ...progress });
  }

  loads(offset) {
    return this.calls.filter((call) => call.kind === 'tracks' && (offset === undefined || call.offset === offset));
  }

  api() {
    const lib = this;
    return {
      platform: 'win32',
      async getTracks({ search, sort, limit, offset }) {
        lib.calls.push({ kind: 'tracks', search, sort, limit, offset });
        time.work += lib.queryMs;
        if (lib.failTracks && offset > 0) throw new Error('disk busy');
        return lib.ordered(search).slice(offset, offset + limit).map((track) => ({ ...track }));
      },
      async getTrackCount({ search }) {
        lib.calls.push({ kind: 'count', search });
        time.work += lib.queryMs;
        return lib.ordered(search).length;
      },
      async getStats() {
        lib.calls.push({ kind: 'stats' });
        return { tracks: lib.tracks.length, albums: lib.tracks.length, artists: lib.tracks.length, duration: lib.tracks.length * 200 };
      },
      async getLibraryHealth() {
        lib.calls.push({ kind: 'health' });
        return {
          totals: { tracks: lib.tracks.length, albums: 0, artists: 0, duration: 0 },
          missing: { artist: 0, album: 0, year: 0, art: 0, duration: 0 },
          quality: { lossless: 0, lossy: 0, hiRes: 0, dsd: 0, ffmpegFallback: 0, lowBitrate: 0, replayGainReady: 0, replayGainMissing: 0, unknown: 0 },
          duplicateGroups: [], legacyFormats: [], recentlyAdded: [], adoptedEdits: 0, generatedAt: 0,
        };
      },
      onScanProgress(listener) {
        lib.scanListeners.add(listener);
        return () => lib.scanListeners.delete(listener);
      },
      onTracksRemoved(listener) {
        lib.removedListeners.add(listener);
        return () => lib.removedListeners.delete(listener);
      },
    };
  }
}

// ── a dispatcher in place of a DOM ─────────────────────────────────────────
const internals = m.React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
let rendering = null;
const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

const dispatcher = {
  useState(initial) {
    const instance = rendering;
    const slot = (instance.hooks[instance.cursor] ??= (() => {
      const created = { value: typeof initial === 'function' ? initial() : initial };
      created.set = (next) => {
        const value = typeof next === 'function' ? next(created.value) : next;
        if (Object.is(value, created.value)) return;
        created.value = value;
        instance.tree.schedule();
      };
      return created;
    })());
    instance.cursor += 1;
    return [slot.value, slot.set];
  },
  useRef(initial) {
    const instance = rendering;
    const slot = (instance.hooks[instance.cursor] ??= { current: initial });
    instance.cursor += 1;
    return slot;
  },
  useMemo(make, deps) {
    const instance = rendering;
    const held = instance.hooks[instance.cursor];
    instance.cursor += 1;
    if (held && sameDeps(held.deps, deps)) return held.value;
    const slot = { deps, value: make() };
    instance.hooks[instance.cursor - 1] = slot;
    return slot.value;
  },
  useCallback(callback, deps) {
    return dispatcher.useMemo(() => callback, deps);
  },
  useEffect(run, deps) {
    const instance = rendering;
    const slot = (instance.hooks[instance.cursor] ??= { deps: undefined, cleanup: undefined, ran: false });
    instance.cursor += 1;
    if (slot.ran && deps && sameDeps(slot.deps, deps)) return;
    slot.deps = deps;
    instance.pending.push(() => {
      slot.cleanup?.();
      slot.cleanup = run() ?? undefined;
      slot.ran = true;
    });
    instance.slots.add(slot);
  },
  useLayoutEffect(run, deps) { return dispatcher.useEffect(run, deps); },
  useContext() { return undefined; },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  useId() { return 'id'; },
  useDeferredValue(value) { return value; },
  useImperativeHandle() {},
};

/** Runs a tree whose root and (optionally) one named child are really rendered. */
class Tree {
  constructor(rootFn, rootProps, childName) {
    this.root = this.instance(rootFn);
    this.rootProps = rootProps;
    this.childName = childName;
    this.child = null;
    this.queued = false;
    this.renders = 0;
    this.history = [];
  }

  instance(fn) {
    return { fn, hooks: [], cursor: 0, pending: [], slots: new Set(), tree: this, output: null, props: null };
  }

  schedule() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.render();
    });
  }

  run(instance, props) {
    instance.cursor = 0;
    instance.props = props;
    const before = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcher;
    rendering = instance;
    try {
      instance.output = instance.fn(props);
    } finally {
      rendering = null;
      internals.ReactCurrentDispatcher.current = before;
    }
  }

  render() {
    this.renders += 1;
    assert.ok(this.renders < 2000, 'the view keeps re-rendering: a load loop');
    this.run(this.root, this.rootProps);
    const paneElement = this.childName ? find(this.root.output, (el) => typeof el.type === 'function' && el.type.name.startsWith(this.childName)) : null;
    if (paneElement) {
      this.child ??= this.instance(paneElement.type);
      this.run(this.child, paneElement.props);
      this.history.push({ loading: paneElement.props.loading, shown: paneElement.props.tracks.length });
    }
    // Children's effects run before their parent's, as React's do.
    for (const instance of [this.child, this.root]) {
      if (!instance) continue;
      const queue = instance.pending;
      instance.pending = [];
      for (const effect of queue) effect();
    }
  }

  get pane() { return this.child.props; }

  unmount() {
    for (const instance of [this.child, this.root]) {
      if (!instance) continue;
      for (const slot of instance.slots) slot.cleanup?.();
    }
  }
}

function find(node, test) {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = find(item, test);
      if (hit) return hit;
    }
    return null;
  }
  if (node.$$typeof && test(node)) return node;
  return find(node.props?.children, test);
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

function setUp(lib) {
  harness.api = lib.api();
  harness.player = new Proxy(
    { searchQuery: '', current: null, fullscreenViz: false },
    { get: (target, key) => (key in target ? target[key] : () => undefined) },
  );
  time.timers.clear();
}

async function mountLibrary(lib) {
  setUp(lib);
  const tree = new Tree(m.LibraryView, {}, 'LibraryTrackPane');
  tree.render();
  await settle();
  return tree;
}

async function search(tree, text) {
  harness.player.searchQuery = text;
  tree.render();
  await settle();
}

/** Scrolls the track pane to its last loaded row, the way the list's scroll event does. */
async function scrollToEnd(tree) {
  const scroller = find(tree.child.output, (el) => typeof el.props?.onScroll === 'function');
  scroller.props.onScroll({ currentTarget: { scrollTop: Math.max(0, tree.pane.tracks.length - 17) * 36, clientHeight: 600 } });
  await advance(40);
}

// ── the pure rules ─────────────────────────────────────────────────────────
{
  const row = (id) => ({ id });
  const shown = [row(1), row(2), row(3)];
  assert.equal(m.appendTrackPage(shown, [row(2), row(3)]), shown, 'a page of repeats leaves the list as it was');
  assert.deepEqual(m.appendTrackPage(shown, [row(3), row(4), row(4), row(5)]).map((t) => t.id), [1, 2, 3, 4, 5], 'repeats, within the page or against the list, are dropped');

  const near = { endIndex: 560, loaded: 600, hasMore: true, busy: false, failed: false };
  assert.equal(m.wantsNextTrackPage(near), true, 'near the last loaded row it wants the next page');
  assert.equal(m.wantsNextTrackPage({ ...near, endIndex: 22 }), false, 'at the top it does not');
  assert.equal(m.wantsNextTrackPage({ ...near, hasMore: false }), false, 'nothing is asked for past the end');
  assert.equal(m.wantsNextTrackPage({ ...near, busy: true }), false, 'one page at a time');
  assert.equal(m.wantsNextTrackPage({ ...near, failed: true }), false, 'a failed page is not asked for again by scrolling');
  assert.equal(m.wantsNextTrackPage({ ...near, loaded: 0, endIndex: -1 }), false, 'an empty list asks for nothing');

  assert.equal(m.searchDebounceMs(null), 180, 'before a query has been timed the wait is the long one');
  assert.equal(m.searchDebounceMs(4), 60, 'a query that answers at once waits the least');
  assert.equal(m.searchDebounceMs(40), 80, 'otherwise twice what a query cost');
  assert.equal(m.searchDebounceMs(400), 180, 'and never more than the long wait');
  assert.equal(m.searchDebounceMs(Number.NaN), 180);
}

// ── scan events to list refreshes ──────────────────────────────────────────
{
  const clock = { now: 0, id: 0, timers: new Map() };
  const fakeClock = {
    now: () => clock.now,
    setTimeout: (run, ms) => { clock.timers.set(++clock.id, { at: clock.now + ms, run }); return clock.id; },
    clearTimeout: (id) => { clock.timers.delete(id); },
  };
  const tick = (ms) => {
    const end = clock.now + ms;
    for (const [id, timer] of [...clock.timers]) {
      if (timer.at <= end) { clock.now = timer.at; clock.timers.delete(id); timer.run(); }
    }
    clock.now = end;
  };
  const fired = [];
  const gate = m.createScanRefreshGate((finished) => fired.push(finished), 1500, fakeClock);
  const event = (extra) => ({ scanned: 0, total: 900, current: '', done: false, startedAt: 0, ...extra });

  gate.push(event({ scanned: 0, parsed: 0 }));
  gate.push(event({ scanned: 0, parsed: 0 }));
  assert.deepEqual(fired, [], 'the folder walk has nothing to show yet');
  gate.push(event({ scanned: 100, parsed: 100 }));
  assert.deepEqual(fired, [false], 'the first tracks are shown at once');
  gate.push(event({ scanned: 200, parsed: 200 }));
  gate.push(event({ scanned: 300, parsed: 300 }));
  assert.equal(fired.length, 1, 'then at most one refresh per interval');
  tick(1499);
  assert.equal(fired.length, 1);
  tick(1);
  assert.deepEqual(fired, [false, false], 'the last event of a burst is not lost');
  gate.push(event({ scanned: 500, parsed: 300, skipped: 200 }));
  tick(5000);
  assert.equal(fired.length, 2, 'files skipped as unchanged add nothing to show');
  gate.push(event({ scanned: 600, parsed: 350 }));
  assert.equal(fired.length, 3, 'after a quiet spell new tracks show at once');
  gate.push(event({ scanned: 700, parsed: 380 }));
  gate.push(event({ scanned: 900, total: 900, done: true, parsed: 400 }));
  assert.deepEqual(fired, [false, false, false, true], 'the end refreshes at once');
  tick(5000);
  assert.equal(fired.length, 4, 'and takes the pending refresh with it');
  gate.push(event({ scanned: 0, parsed: 0 }));
  assert.equal(fired.length, 4, 'the next scan starts from the folder walk again');
  gate.push(event({ scanned: 50, parsed: 50 }));
  gate.push(event({ scanned: 80, parsed: 80 }));
  assert.equal(fired.length, 5);
  gate.dispose();
  tick(5000);
  assert.equal(fired.length, 5, 'a disposed gate fires nothing more');
}

// ── a scan started from the empty-library screen fills the Library ─────────
{
  const lib = new FakeLibrary();
  const tree = await mountLibrary(lib);
  assert.equal(tree.pane.tracks.length, 0, 'nothing to show before the scan');
  assert.equal(tree.pane.hasLibrary, false, 'so the empty-library screen is up');
  assert.equal(lib.scanListeners.size, 1, 'the view listens for scan progress');
  const quiet = tree.history.length;

  lib.add(40);
  lib.emitScan({ scanned: 40, total: 5000, parsed: 40 });
  await settle();
  assert.equal(tree.pane.tracks.length, 40, 'the first tracks appear while the scan is still running');
  assert.equal(tree.pane.hasLibrary, true, 'and the empty-library screen gives way');
  assert.equal(tree.pane.matchingTrackCount, 40);
  assert.equal(lib.calls.some((call) => call.kind === 'health'), true, 'the health report was read once the library had tracks');
  const healthReads = lib.calls.filter((call) => call.kind === 'health').length;

  lib.add(30);
  lib.emitScan({ scanned: 70, total: 5000, parsed: 70 });
  await advance(1000);
  assert.equal(tree.pane.tracks.length, 40, 'refreshes are spaced out');
  await advance(500);
  assert.equal(tree.pane.tracks.length, 70, 'the list catches up at the next interval');
  assert.equal(lib.calls.filter((call) => call.kind === 'health').length, healthReads, 'the health report is not read again while the scan runs');

  lib.add(10);
  lib.emitScan({ scanned: 5000, total: 5000, parsed: 80, done: true });
  await settle();
  assert.equal(tree.pane.tracks.length, 80, 'the finished scan settles the list at once');
  assert.ok(lib.calls.filter((call) => call.kind === 'health').length > healthReads, 'and refreshes the health report');
  assert.equal(tree.history.slice(quiet).every((entry) => entry.loading === false), true, 'the list was never blanked for "Loading..." along the way');
  tree.unmount();
  assert.equal(lib.scanListeners.size, 0, 'the listener goes with the view');
}

// ── a scan on a library that already fills the first page ──────────────────
{
  const lib = new FakeLibrary();
  lib.add(1300);
  const tree = await mountLibrary(lib);
  assert.equal(tree.pane.tracks.length, 600);
  const loaded = tree.pane.tracks;

  lib.add(200);
  lib.emitScan({ scanned: 200, total: 500, parsed: 200 });
  await settle();
  assert.equal(tree.pane.matchingTrackCount, 1500, 'the count follows the scan');
  assert.equal(tree.pane.hasMoreTracks, true);
  assert.equal(tree.pane.tracks, loaded, 'the loaded rows, and with them the scroll position, are left alone');
  assert.equal(lib.loads(0).length, 1, 'the first page was not read again mid-scan');

  lib.emitScan({ scanned: 500, total: 500, parsed: 200, done: true });
  await settle();
  assert.equal(lib.loads(0).length, 2, 'the finished scan reads the first page again');
  assert.notEqual(tree.pane.tracks, loaded);
  assert.deepEqual(tree.pane.tracks.map((t) => t.id), lib.ordered('').slice(0, 600).map((t) => t.id), 'in the library\'s order');
  tree.unmount();
}

// ── scrolling loads the next page ──────────────────────────────────────────
{
  const lib = new FakeLibrary();
  lib.add(5000);
  const tree = await mountLibrary(lib);
  assert.equal(tree.pane.tracks.length, 600);
  await advance(2000);
  assert.equal(lib.loads().length, 1, 'nothing more is read until the list is scrolled');

  await scrollToEnd(tree);
  assert.equal(lib.loads(600).length, 1, 'near the end of the loaded rows the next page is read');
  assert.equal(lib.loads(600)[0].limit, 2000);
  assert.equal(tree.pane.tracks.length, 2600);

  let guard = 0;
  while (tree.pane.hasMoreTracks && guard++ < 10) await scrollToEnd(tree);
  assert.deepEqual(lib.loads().map((call) => call.offset), [0, 600, 2600, 4600], 'a 5,000 track library takes four reads, not nine presses of Load more');
  assert.equal(tree.pane.hasMoreTracks, false);
  assert.deepEqual(tree.pane.tracks.map((t) => t.id), lib.ordered('').map((t) => t.id), 'every track once, in order');
  await advance(2000);
  assert.equal(lib.loads().length, 4, 'and it stops at the end');
  tree.unmount();
}

// ── paging by rows read ────────────────────────────────────────────────────
{
  // Tracks arriving above the loaded rows push them down. The pages that follow
  // repeat some; none of the original tracks may be skipped or shown twice.
  const lib = new FakeLibrary();
  lib.add(1000, { artist: (n) => `M ${String(n).padStart(6, '0')}` });
  const tree = await mountLibrary(lib);
  const original = lib.ordered('').map((t) => t.id);
  lib.add(2500, { artist: (n) => `A ${String(n).padStart(6, '0')}` });
  await scrollToEnd(tree);
  let guard = 0;
  while (tree.pane.hasMoreTracks && guard++ < 10) await scrollToEnd(tree);
  const ids = tree.pane.tracks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'no track is shown twice');
  for (const id of original) assert.ok(ids.includes(id), `track ${id} was skipped`);
  assert.equal(tree.pane.hasMoreTracks, false, 'paging reached the end');
  tree.unmount();
}
{
  // A burst bigger than a page between two reads: the next page is nothing but
  // tracks already shown. The offset has to move on past them regardless.
  const lib = new FakeLibrary();
  lib.add(3000, { artist: (n) => `M ${String(n).padStart(6, '0')}` });
  const tree = await mountLibrary(lib);
  await scrollToEnd(tree);
  assert.equal(tree.pane.tracks.length, 2600);
  const original = tree.pane.tracks.map((t) => t.id);
  lib.add(2500, { artist: (n) => `A ${String(n).padStart(6, '0')}` });
  let guard = 0;
  while (tree.pane.hasMoreTracks && guard++ < 10) await scrollToEnd(tree);
  const ids = tree.pane.tracks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'no track is shown twice');
  for (const id of original) assert.ok(ids.includes(id), `track ${id} was dropped`);
  assert.ok(ids.includes(3000), 'the tracks past the repeats are reached');
  assert.equal(tree.pane.hasMoreTracks, false, 'paging did not stall on a page of repeats');
  tree.unmount();
}
{
  // Rows that leave the loaded list take their place in the library's order
  // with them, so the next page starts right after the last row kept.
  const lib = new FakeLibrary();
  lib.add(3000);
  const tree = await mountLibrary(lib);
  const gone = tree.pane.tracks.slice(10, 13).map((t) => t.id);
  lib.remove(gone);
  await settle();
  assert.equal(tree.pane.tracks.length, 597, 'the removed rows leave the list');
  await scrollToEnd(tree);
  assert.equal(lib.loads().at(-1).offset, 597, 'the next page starts after the rows still loaded');
  let guard = 0;
  while (tree.pane.hasMoreTracks && guard++ < 10) await scrollToEnd(tree);
  assert.deepEqual(tree.pane.tracks.map((t) => t.id), lib.ordered('').map((t) => t.id), 'no track after the removed ones is skipped');
  tree.unmount();
}

// ── a page that fails ──────────────────────────────────────────────────────
{
  const lib = new FakeLibrary();
  lib.add(3000);
  const tree = await mountLibrary(lib);
  lib.failTracks = true;
  await scrollToEnd(tree);
  await advance(10000);
  assert.equal(lib.loads(600).length, 1, 'scrolling does not ask again for a page that failed');
  assert.equal(tree.pane.loadMoreFailed, true);
  assert.equal(tree.pane.tracks.length, 600);
  lib.failTracks = false;
  tree.pane.onLoadMore();
  await settle();
  assert.equal(tree.pane.tracks.length, 2600, 'the Load more button tries again');
  assert.equal(tree.pane.loadMoreFailed, false);
  tree.unmount();
}

// ── the wait before a search follows what a query costs ────────────────────
{
  const lib = new FakeLibrary();
  lib.add(300);
  lib.queryMs = 2;
  const tree = await mountLibrary(lib);
  await search(tree, 'ab');
  await advance(59);
  assert.equal(lib.calls.some((call) => call.kind === 'tracks' && call.search === 'ab'), false, 'not before the wait is up');
  await advance(1);
  assert.equal(lib.calls.some((call) => call.kind === 'tracks' && call.search === 'ab'), true, 'a library that answers at once waits 60 ms');

  lib.queryMs = 60;
  await search(tree, 'abc');
  await advance(60);
  assert.equal(lib.calls.some((call) => call.kind === 'tracks' && call.search === 'abc'), true);
  await search(tree, 'abcd');
  await advance(179);
  assert.equal(lib.calls.some((call) => call.kind === 'tracks' && call.search === 'abcd'), false, 'a slow query is given the longer wait');
  await advance(1);
  assert.equal(lib.calls.some((call) => call.kind === 'tracks' && call.search === 'abcd'), true);
  tree.unmount();
}

// ── the empty-library screen says when a scan found nothing ────────────────
{
  const lib = new FakeLibrary();
  setUp(lib);
  Object.assign(harness.api, {
    getSuggestedMusicFolders: async () => [],
    getSettings: async () => ({ libraryRoots: [] }),
    setSettings: async () => undefined,
    scanLibrary: async () => undefined,
  });
  const tree = new Tree(m.EmptyLibrary, {}, null);
  tree.render();
  await settle();
  const scanButton = () => find(tree.root.output, (el) => el.type === 'button' && /Scan (Default Music Folder|ning)/.test(textOf(el)));
  scanButton().props.onClick();
  await settle();
  assert.match(textOf(tree.root.output), /Nothing was added\. Try a folder with music in it\./, 'a scan that found no tracks says so');
  assert.doesNotMatch(textOf(tree.root.output), /Scan started/, 'it no longer claims a finished scan has only started');

  lib.add(3);
  scanButton().props.onClick();
  await settle();
  assert.doesNotMatch(textOf(tree.root.output), /Nothing was added/, 'but not when it found some');
}

// ── ...and which folder it scanned, with a way to choose another ───────────
{
  const lib = new FakeLibrary();
  setUp(lib);
  const scanned = [];
  Object.assign(harness.api, {
    getSuggestedMusicFolders: async () => [{ path: 'D:/Tunes', label: 'Music', reason: 'test' }],
    getSettings: async () => ({ libraryRoots: [] }),
    setSettings: async () => undefined,
    scanLibrary: async (roots) => { scanned.push(roots); },
    pickFolder: async () => 'E:/Other',
  });
  const tree = new Tree(m.EmptyLibrary, {}, null);
  tree.render();
  await settle();
  const button = (pattern) => find(tree.root.output, (el) => el.type === 'button' && pattern.test(textOf(el)));
  button(/Scan Default Music Folder/).props.onClick();
  await settle();
  assert.deepEqual(scanned, [['D:/Tunes']], 'the default scan takes the folder the screen suggests');
  assert.match(textOf(tree.root.output), /Nothing was added from D:\/Tunes\. Try a folder with music in it\./, 'it names the folder it scanned');
  button(/Choose another folder/).props.onClick();
  await settle();
  assert.deepEqual(scanned.at(-1), ['E:/Other'], 'the offer opens the picker and scans the choice');
  assert.match(textOf(tree.root.output), /Nothing was added from E:\/Other\./, 'and the message follows the new folder');
}

// ── the report no longer grades the collection ─────────────────────────────
{
  const health = {
    totals: { tracks: 4, albums: 2, artists: 2, duration: 800 },
    missing: { artist: 0, album: 1, year: 3, art: 4, duration: 0 },
    quality: { lossless: 0, lossy: 4, hiRes: 0, dsd: 0, ffmpegFallback: 0, lowBitrate: 4, replayGainReady: 0, replayGainMissing: 4, unknown: 0 },
    duplicateGroups: [], legacyFormats: [], recentlyAdded: [], adoptedEdits: 0, generatedAt: 0,
  };
  const compass = m.buildArchiveCompass(health);
  for (const key of ['score', 'grade', 'profile']) assert.equal(key in compass, false, `no ${key}`);
  const art = compass.moves.find((move) => move.label === 'Find cover art');
  assert.ok(art, 'cover art is its own move');
  assert.match(art.detail, /^4 tracks have no cover art/);
  assert.equal(art.query, 'missing:art');
  const tags = compass.moves.find((move) => move.label === 'Fix missing tags');
  assert.ok(tags, 'and so are the other tags');
  assert.match(tags.detail, /^4 tags are missing, mostly years/);
  assert.equal(tags.query, 'missing:year', 'a move opens the tracks it counts');
  assert.equal(compass.moves.some((move) => /tags and art/.test(move.label)), false);
  const clean = m.buildArchiveCompass({ ...health, missing: { artist: 0, album: 0, year: 0, art: 0, duration: 0 } });
  assert.equal(clean.moves.some((move) => move.label === 'Find cover art' || move.label === 'Fix missing tags'), false, 'nothing missing, nothing to fix');

  for (const path of ['src/components/views/LibraryView.tsx', 'src/components/views/HomeView.tsx']) {
    const source = await read(path);
    assert.doesNotMatch(source, /compass\.(grade|score|profile)|Archive score|library-overview-grade/, `${path} shows no grade`);
  }
}

console.log('[library-live-list-test] ok: scan fills the list, scroll pages it, search waits by cost, no grade');
