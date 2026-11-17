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
const windowListeners = new Map();
globalThis.window = {
  location: { search: '' },
  setTimeout: setTimer,
  clearTimeout: clearTimer,
  requestAnimationFrame: (run) => setTimer(() => run(time.now), 16),
  cancelAnimationFrame: clearTimer,
  addEventListener(name, callback) { windowListeners.set(name, callback); },
  removeEventListener(name) { windowListeners.delete(name); },
  localStorage: globalThis.localStorage,
};
globalThis.document = { querySelector: () => null };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

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
      export { getToasts, clearToasts } from './src/lib/toast';
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
    this.pageDelay = 0;
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
        if (offset > 0 && lib.pageDelay) await new Promise((resolve) => setTimer(resolve, lib.pageDelay));
        time.work += lib.queryMs;
        if (lib.failTracks && offset > 0) throw new Error('disk busy');
        return lib.ordered(search).slice(offset, offset + limit).map((track) => ({ ...track }));
      },
      async getTrackIds({ search, limit, offset }) {
        lib.calls.push({ kind: 'ids', search, limit, offset });
        await new Promise((resolve) => setTimer(resolve, 5));
        return lib.ordered(search).slice(offset, offset + limit).map((track) => track.id);
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
    slot.run = run;
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
    const tree = this;
    let scrollTop = 0;
    this.scroller = {
      get scrollTop() { return scrollTop; },
      set scrollTop(value) {
        if (scrollTop === value) return;
        scrollTop = value;
        setTimer(() => {
          const pane = find(tree.child?.output, (el) => !!el.props?.['data-newamp-library-scroll']);
          pane?.props.onScroll({ currentTarget: tree.scroller });
        }, 0);
      },
      clientHeight: 600,
      getBoundingClientRect: () => ({ top: 0 }),
      querySelector: (selector) => selector === 'table' ? {
        tBodies: [{ getBoundingClientRect: () => ({ top: 80 - this.scroller.scrollTop }) }],
        tHead: { getBoundingClientRect: () => ({ height: 32 }) },
      } : null,
    };
  }

  instance(fn) {
    return { fn, hooks: [], cursor: 0, pending: [], slots: new Set(), tree: this, output: null, props: null };
  }

  schedule() {
    if (this.queued) return;
    this.queued = true;
    setImmediate(() => {
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
      const scroller = find(this.child.output, (el) => !!el.props?.['data-newamp-library-scroll']);
      const ref = scroller?.ref;
      if (this.attachedRef !== ref) {
        if (this.attachedRef) {
          this.attachedRef.current = null;
          this.scroller.scrollTop = 0; // A replacement DOM node really loses its scroll position.
        }
        this.attachedRef = ref;
      }
      if (ref) ref.current = this.scroller;
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
    // React drops updates to an unmounted tree; so does this one.
    this.schedule = () => {};
    for (const instance of [this.child, this.root]) {
      if (!instance) continue;
      for (const slot of instance.slots) slot.cleanup?.();
    }
  }

  /** What StrictMode does in development: every effect is torn down and run again. */
  remountEffects() {
    const instances = [this.child, this.root].filter(Boolean);
    for (const instance of instances) for (const slot of instance.slots) slot.cleanup?.();
    for (const instance of instances) for (const slot of instance.slots) slot.cleanup = slot.run() ?? undefined;
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
    { searchQuery: '', current: null, fullscreenViz: false, compactMode: false },
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
  tree.scroller.scrollTop = Math.max(0, tree.pane.tracks.length - 17) * 36;
  scroller.props.onScroll({ currentTarget: tree.scroller });
  await advance(16);
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
  assert.equal(tree.history[0].loading, true, 'the first render waits for the first page instead of showing the empty-library screen');
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
  assert.equal(tree.pane.tracks.length, 5000, 'background pages fill an ordinary library without scrolling');

  await scrollToEnd(tree);
  assert.equal(lib.loads(600).length, 1, 'near the end of the loaded rows the next page is read');
  assert.equal(lib.loads(600)[0].limit, 2000);
  assert.equal(tree.pane.tracks.length, 5000);

  let guard = 0;
  while (tree.pane.hasMoreTracks && guard++ < 10) await scrollToEnd(tree);
  assert.deepEqual(lib.loads().map((call) => call.offset), [0, 600, 2600, 4600], 'a 5,000 track library takes four reads, not nine presses of Load more');
  assert.equal(tree.pane.hasMoreTracks, false);
  assert.deepEqual(tree.pane.tracks.map((t) => t.id), lib.ordered('').map((t) => t.id), 'every track once, in order');
  await advance(2000);
  assert.equal(lib.loads().length, 4, 'and it stops at the end');
  tree.unmount();
}

// ── bounded loading and following the playing track ────────────────────────
{
  const lib = new FakeLibrary();
  lib.add(63000);
  const tree = await mountLibrary(lib);
  await advance(2000);
  assert.equal(tree.pane.tracks.length, 20000, 'background loading stops exactly at the shared cap');
  const table = () => find(tree.child.output, (el) => typeof el.props?.onSelectionChange === 'function');
  const scrollPane = () => find(tree.child.output, (el) => !!el.props?.['data-newamp-library-scroll']);
  tree.scroller.scrollTop = 1800 * 36;
  await advance(1000);

  harness.player.current = lib.tracks[400];
  tree.render();
  await advance(300);
  const first = tree.scroller.scrollTop;
  harness.player.current = lib.tracks[100];
  tree.render();
  await advance(300);
  assert.ok(tree.scroller.scrollTop < first, 'Next twice within 900 ms follows twice despite native scroll events');

  scrollPane().props.onWheelCapture();
  const beforeIdle = tree.scroller.scrollTop;
  harness.player.current = lib.tracks[500];
  tree.render();
  await advance(899);
  assert.equal(tree.scroller.scrollTop, beforeIdle, 'user scrolling defers follow');
  await advance(40);
  assert.ok(tree.scroller.scrollTop > beforeIdle, 'the pending follow resumes on idle');

  table().props.onSelectionChange(true);
  await settle();
  const selected = tree.scroller.scrollTop;
  harness.player.current = lib.tracks[1000];
  tree.render();
  await advance(1000);
  table().props.onSelectionChange(false);
  await advance(1000);
  assert.equal(tree.scroller.scrollTop, selected, 'selection suppresses follow even after clearing it');

  // A click elsewhere in the window, such as Next in the transport, ends with a
  // pointerup that never began in the list; it must not hold the follow.
  windowListeners.get('pointerup')();
  harness.player.current = lib.tracks[5000];
  tree.render();
  await advance(100);
  assert.ok(tree.scroller.scrollTop > 4900 * 36 && tree.scroller.scrollTop < 5100 * 36, 'a pointerup outside the list does not delay the follow');
  scrollPane().props.onPointerDownCapture({ button: 0 });
  windowListeners.get('pointerup')();
  const released = tree.scroller.scrollTop;
  harness.player.current = lib.tracks[9000];
  tree.render();
  await advance(100);
  assert.equal(tree.scroller.scrollTop, released, 'a press that began in the list still holds it');
  await advance(900);
  assert.ok(tree.scroller.scrollTop > 8900 * 36, 'until the list has been left alone');
  // A right-click's release goes to the native menu, so nothing would end the hold.
  scrollPane().props.onPointerDownCapture({ button: 2 });
  await advance(1000);
  harness.player.current = lib.tracks[3000];
  tree.render();
  await advance(100);
  assert.ok(tree.scroller.scrollTop > 2900 * 36 && tree.scroller.scrollTop < 3100 * 36, 'a right-click does not leave the follow held');

  // Radio and podcast items are not library tracks; looking them up reads the whole list's ids.
  const idsBefore = lib.calls.filter((call) => call.kind === 'ids').length;
  harness.player.current = { id: -42 };
  tree.render();
  await advance(1000);
  assert.equal(lib.calls.filter((call) => call.kind === 'ids').length, idsBefore, 'an item that cannot be in the library is not looked for');

  const beforeCap = tree.scroller.scrollTop;
  harness.player.current = lib.tracks[61000];
  tree.render();
  await advance(2000);
  assert.equal(tree.pane.tracks.length, 20000, 'follow cannot load past 20,000 rows');
  assert.equal(tree.scroller.scrollTop, beforeCap);
  harness.player.current = { id: 999999 };
  tree.render();
  await advance(1000);
  const idsReads = lib.calls.filter((call) => call.kind === 'ids').length;
  harness.player.current = { id: 999998 };
  tree.render();
  await advance(1000);
  assert.equal(lib.calls.filter((call) => call.kind === 'ids').length, idsReads, 'successive misses reuse one index');
  windowListeners.get('newamp:library-play-recorded')();
  harness.player.current = { id: 999997 };
  tree.render();
  await advance(1000);
  assert.equal(lib.calls.filter((call) => call.kind === 'ids').length, idsReads + 1, 'a recorded play invalidates the index; a track change alone does not');
  assert.ok(table().props.virtualWindow.endIndex - table().props.virtualWindow.startIndex < 35);
  tree.unmount();
}
{
  const lib = new FakeLibrary();
  lib.add(63000);
  const tree = await mountLibrary(lib);
  // A new Recent/Rating/Added row moves above the already-read offset.
  const id = lib.nextId++;
  lib.tracks.push({ id, title: 'Shifted', artist: 'Artist 000000A', path: '/shifted.flac', loved: 0 });
  harness.player.current = { id };
  tree.render();
  await advance(3000);
  assert.ok(tree.pane.tracks.some((row) => row.id === id), 'a shifted playing row is re-read from the loaded window');
  assert.equal(lib.calls.filter((call) => call.kind === 'ids').length, 1, 'delayed IPC and macrotask rendering do not create a retry loop');
  tree.unmount();
}
{
  const lib = new FakeLibrary();
  lib.add(63000);
  const tree = await mountLibrary(lib);
  lib.failTracks = true;
  m.clearToasts();
  harness.player.current = lib.tracks[2000];
  tree.render();
  await advance(10);
  assert.equal(tree.pane.loadMoreFailed, false, 'a failed follow does not poison paging');
  assert.equal(m.getToasts().length, 0, 'a failed follow emits no toast');
  assert.equal(tree.pane.tracks.length, 600);
  tree.unmount();
}
{
  // Leaving the Library unmounts it, mid-fill or not, and coming back is a
  // fresh first page for whatever search is set by then.
  const lib = new FakeLibrary();
  lib.add(63000);
  lib.pageDelay = 200;
  const tree = await mountLibrary(lib);
  await advance(450);
  assert.equal(lib.loads(600).length, 1, 'a background page is in flight');
  tree.unmount();
  const left = lib.calls.length;
  await advance(3000);
  assert.equal(lib.calls.length, left, 'an unmounted Library reads nothing more');
  harness.player.searchQuery = 'Song 7';
  const back = new Tree(m.LibraryView, {}, 'LibraryTrackPane');
  back.render();
  await settle();
  const reads = lib.calls.slice(left).filter((call) => call.kind === 'tracks');
  assert.deepEqual(reads.map((call) => [call.search, call.offset, call.limit]), [['Song 7', 0, 600]], 'the first read is the new search\'s first page');
  assert.ok(back.pane.tracks.length && back.pane.tracks.every((row) => row.title.includes('Song 7')), 'with no other list shown first');
  back.unmount();
}
{
  // StrictMode tears down and reruns every effect on mount in development.
  const lib = new FakeLibrary();
  lib.add(3000);
  setUp(lib);
  const tree = new Tree(m.LibraryView, {}, 'LibraryTrackPane');
  tree.render();
  tree.remountEffects();
  await settle();
  assert.equal(tree.pane.loading, false, 'a first page cut off by the remount is asked for again');
  assert.equal(tree.pane.tracks.length, 600);
  tree.unmount();
}
{
  // A refetch overtaken by a newer read of the list leaves that newer list as it is.
  const lib = new FakeLibrary();
  lib.add(5000);
  const tree = await mountLibrary(lib);
  await advance(1000);
  const health = harness.api.getLibraryHealth;
  harness.api.getLibraryHealth = async () => { await new Promise((resolve) => setTimer(resolve, 500)); return health(); };
  for (const listener of lib.removedListeners) listener([]);
  await search(tree, 'Song 1');
  await advance(1000);
  assert.equal(tree.pane.loadingMore, false, 'the list is not left on "Loading..."');
  await advance(2000);
  assert.equal(tree.pane.tracks.length, lib.ordered('Song 1').length, 'and the background fill goes on');
  assert.ok(tree.pane.tracks.every((row) => row.title.includes('Song 1')));
  tree.unmount();
}
{
  // A follow cut off by a scan's reload of the list is tried again, and the
  // page read it held up does not stop the background fill.
  const lib = new FakeLibrary();
  lib.add(63000);
  const tree = await mountLibrary(lib);
  const ids = harness.api.getTrackIds;
  harness.api.getTrackIds = async (options) => { await new Promise((resolve) => setTimer(resolve, 1000)); return ids(options); };
  harness.player.current = lib.tracks[5000];
  tree.render();
  await settle();
  lib.emitScan({ scanned: 1, total: 1, done: true });
  await advance(6000);
  assert.ok(tree.scroller.scrollTop > 4900 * 36 && tree.scroller.scrollTop < 5100 * 36, 'the playing track is followed');
  assert.equal(tree.pane.tracks.length, 20000, 'and the background fill went on');
  tree.unmount();
}
{
  // Rows scrolled in past the automatic-loading cap are followed like any other.
  const lib = new FakeLibrary();
  lib.add(23000);
  const tree = await mountLibrary(lib);
  await advance(2000);
  assert.equal(tree.pane.tracks.length, 20000);
  await scrollToEnd(tree);
  assert.equal(tree.pane.tracks.length, 22000);
  await advance(1000);
  harness.player.current = lib.tracks[21000];
  tree.render();
  await advance(100);
  assert.ok(tree.scroller.scrollTop > 20900 * 36 && tree.scroller.scrollTop < 21100 * 36, 'a loaded row past 20,000 is scrolled to');
  tree.unmount();
}
{
  // The selection goes with the table while a search loads; a track that
  // changes then is followed in the new list.
  const lib = new FakeLibrary();
  lib.add(5000);
  const tree = await mountLibrary(lib);
  await advance(1000);
  find(tree.child.output, (el) => typeof el.props?.onSelectionChange === 'function').props.onSelectionChange(true);
  await settle();
  const count = harness.api.getTrackCount;
  harness.api.getTrackCount = async (options) => {
    if (options.search) await new Promise((resolve) => setTimer(resolve, 300));
    return count(options);
  };
  await search(tree, 'Song 4');
  await advance(200);
  assert.equal(tree.pane.loading, true);
  const target = lib.ordered('Song 4').at(-1);
  harness.player.current = target;
  tree.render();
  await advance(2000);
  const index = tree.pane.tracks.findIndex((row) => row.id === target.id);
  assert.ok(index > 600, 'the playing row was read in');
  assert.ok(Math.abs(tree.scroller.scrollTop - index * 36) < 400, 'and scrolled to');
  tree.unmount();
}
{
  // A search that lands in the same render as a track change: the follow waits
  // for the new list instead of scrolling the one being replaced, and the rows
  // selected in that one no longer hold it.
  const lib = new FakeLibrary();
  lib.add(5000);
  const tree = await mountLibrary(lib);
  await advance(1000);
  find(tree.child.output, (el) => typeof el.props?.onSelectionChange === 'function').props.onSelectionChange(true);
  await settle();
  const count = harness.api.getTrackCount;
  harness.api.getTrackCount = async (options) => {
    if (options.search) await new Promise((resolve) => setTimer(resolve, 300));
    return count(options);
  };
  await search(tree, 'Song 4');
  const target = lib.ordered('Song 4').at(-1);
  harness.player.current = target;
  await advance(2000);
  const index = tree.pane.tracks.findIndex((row) => row.id === target.id);
  assert.ok(tree.pane.tracks.every((row) => row.title.includes('Song 4')) && index > 0);
  assert.ok(Math.abs(tree.scroller.scrollTop - index * 36) < 400, 'the playing row is followed in the new list');
  tree.unmount();
}
{
  // Nothing is read for a search still being typed, and the first background
  // page waits out a pause in the typing.
  const lib = new FakeLibrary();
  lib.add(63000);
  const tree = await mountLibrary(lib);
  await advance(300);
  assert.equal(lib.loads(600).length, 0, 'the first background page waits');
  await advance(150);
  assert.equal(lib.loads(600).length, 1);
  harness.player.searchQuery = 'Song 1';
  tree.render();
  const typed = lib.loads().length;
  await advance(50);
  assert.equal(lib.loads().length, typed, 'no page of the old list is read while the new search is typed');
  await advance(3000);
  assert.equal(tree.pane.tracks.length, lib.ordered('Song 1').length);
  assert.ok(tree.pane.tracks.every((row) => row.title.includes('Song 1')));
  tree.unmount();
}
{
  const lib = new FakeLibrary();
  lib.add(5484);
  const tree = await mountLibrary(lib);
  await advance(2000);
  assert.equal(tree.pane.tracks.length, 5484, 'all 5,484 rows are there without scrolling');
  assert.equal(tree.pane.hasMoreTracks, false);
  await search(tree, 'Song 54');
  await advance(2000);
  assert.ok(tree.pane.tracks.every((row) => row.title.includes('Song 54')), 'a list-key change restarts background loading with the new query');
  tree.unmount();
}

{
  const lib = new FakeLibrary();
  lib.add(63000);
  lib.pageDelay = 200;
  const tree = await mountLibrary(lib);
  await advance(425); // The old list's background page is genuinely in flight.
  await search(tree, 'Song 1');
  await advance(3000);
  assert.equal(tree.pane.tracks.length, lib.ordered('Song 1').length);
  assert.ok(tree.pane.tracks.every((row) => row.title.includes('Song 1')), 'a delayed old background page is discarded on a list-key change');
  tree.unmount();
}
{
  const lib = new FakeLibrary();
  lib.add(63000);
  const tree = await mountLibrary(lib);
  const id = lib.nextId++;
  lib.tracks.push({ id, title: 'Gone during read', artist: 'Artist 000000A', path: '/gone.flac', loved: 0 });
  const getPage = harness.api.getTracks;
  harness.api.getTracks = async (options) => (await getPage(options)).filter((row) => row.id !== id);
  harness.player.current = { id };
  tree.render();
  await advance(3000);
  assert.equal(lib.calls.filter((call) => call.kind === 'ids').length, 1, 'a failed shifted-window read is never retried on loadingMore flips');
  assert.equal(tree.pane.loadMoreFailed, false);
  tree.unmount();
}

{
  // Leaving the Library while a finished scan reads every loaded row again
  // stops that read.
  const lib = new FakeLibrary();
  lib.add(30000);
  const tree = await mountLibrary(lib);
  await advance(3000);
  assert.equal(tree.pane.tracks.length, 20000);
  lib.pageDelay = 100;
  lib.emitScan({ scanned: 1, total: 1, parsed: 1, done: true });
  await advance(250);
  const reading = lib.loads().length;
  assert.equal(lib.loads(2000).length, 1, 'the loaded rows are being read again');
  tree.unmount();
  await advance(3000);
  assert.equal(lib.loads().length, reading, 'an unmounted Library reads no further page');
}
{
  // A refetch of the first page lands while a background page further down is
  // in flight: that page was asked for at the old offset and is dropped.
  const lib = new FakeLibrary();
  lib.add(9000);
  const tree = await mountLibrary(lib);
  lib.pageDelay = 300;
  await advance(1100);
  assert.equal(lib.loads(4600).length, 1, 'a background page is in flight');
  for (const listener of lib.removedListeners) listener([]);
  await advance(5000);
  assert.deepEqual(tree.pane.tracks.map((t) => t.id), lib.ordered('').map((t) => t.id), 'every track once, in order, with no gap');
  tree.unmount();
}
{
  // Two scans that finish close together: the list ends up as the library
  // stands after both, not as the first scan's reload read it.
  const lib = new FakeLibrary();
  lib.add(30000);
  const tree = await mountLibrary(lib);
  await advance(3000);
  assert.equal(tree.pane.tracks.length, 20000);
  lib.pageDelay = 100;
  const front = (n) => `A ${String(n).padStart(6, '0')}`;
  lib.add(50, { artist: front });
  lib.emitScan({ scanned: 50, total: 50, parsed: 50, done: true });
  await advance(250);
  lib.add(50, { artist: front });
  lib.emitScan({ scanned: 50, total: 50, parsed: 50, done: true });
  await advance(5000);
  const ids = tree.pane.tracks.map((t) => t.id);
  assert.equal(ids.length, 20000);
  assert.deepEqual(ids, lib.ordered('').slice(0, ids.length).map((t) => t.id), 'the library\'s first rows, in order, both scans\' tracks included');
  assert.equal(tree.pane.loadingMore, false);
  tree.unmount();
}
{
  // A background page armed in the render where the search changes fires
  // before the "Loading..." render: it must not read the new search at the old
  // list's offset.
  const lib = new FakeLibrary();
  lib.add(63000);
  const tree = await mountLibrary(lib);
  await advance(410);
  assert.equal(tree.pane.tracks.length, 2600);
  lib.pageDelay = 200;
  const getPage = harness.api.getTracks;
  harness.api.getTracks = async (options) => {
    if (options.search && options.offset === 0) await new Promise((resolve) => setTimer(resolve, 50));
    return getPage(options);
  };
  harness.player.searchQuery = 'Song 1';
  tree.render();
  await settle();
  // A busy renderer: the timers run before React's next render.
  tree.schedule = () => {};
  await advance(200);
  tree.render();
  await advance(30);
  delete tree.schedule;
  tree.render();
  await advance(5000);
  assert.deepEqual(tree.pane.tracks.map((t) => t.id), lib.ordered('Song 1').map((t) => t.id), 'every match once, in order, with no gap');
  tree.unmount();
}
{
  // A page the scroll asks for in the same render as a follow: the follow waits
  // for that page, then reads the playing track in.
  const lib = new FakeLibrary();
  lib.add(63000);
  const tree = await mountLibrary(lib);
  lib.pageDelay = 1000;
  await advance(450);
  tree.scroller.scrollTop = 4590 * 36;
  await advance(20);
  const target = lib.tracks[15000];
  harness.player.current = target;
  tree.render();
  await advance(20000);
  const index = tree.pane.tracks.findIndex((row) => row.id === target.id);
  assert.ok(index > 0, 'the playing row was read in');
  assert.ok(Math.abs(tree.scroller.scrollTop - index * 36) < 400, 'and scrolled to');
  tree.unmount();
}
{
  // A cleanup that finishes after the search changed refreshes the list then
  // shown, not the one it started from.
  const lib = new FakeLibrary();
  lib.add(5000);
  const tree = await mountLibrary(lib);
  await advance(1000);
  harness.player.queue = [];
  harness.api.getTracksByIds = async () => [];
  harness.api.resetAdoptedMetadata = async () => { await new Promise((resolve) => setTimer(resolve, 1000)); return 0; };
  const panel = () => find(tree.root.output, (el) => typeof el.props?.onResetAdoptedEdits === 'function');
  panel().props.onResetAdoptedEdits();
  await search(tree, 'Song 12');
  await advance(500);
  const matches = lib.ordered('Song 12').map((t) => t.id);
  assert.deepEqual(tree.pane.tracks.map((t) => t.id), matches);
  await advance(1000);
  assert.deepEqual(tree.pane.tracks.map((t) => t.id), matches, 'the reset reads the search now shown again');
  assert.equal(tree.pane.matchingTrackCount, matches.length);

  const gone = lib.ordered('Song 12')[0].id;
  harness.api.pruneMissingTracks = async () => {
    await new Promise((resolve) => setTimer(resolve, 1000));
    lib.tracks = lib.tracks.filter((track) => track.id !== gone);
    return { removed: 1, removedIds: [gone], offline: 0, backupPath: '' };
  };
  panel().props.onConfirmPrune();
  await search(tree, 'Song 13');
  await advance(2000);
  assert.ok(tree.pane.tracks.every((row) => row.title.includes('Song 13')));
  assert.equal(tree.pane.matchingTrackCount, lib.ordered('Song 13').length, 'the count is the new search\'s');
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

console.log('[library-live-list-test] ok: scan, scroll paging, playback follow and cancellation, adaptive search');
