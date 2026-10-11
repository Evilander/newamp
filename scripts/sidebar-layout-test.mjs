// The sidebar's saved layout (src/store/useSidebarLayout.ts): collapsed groups,
// hidden items and per-group order. Checks the reader of saved data (junk,
// other versions, unknown ids), what the sidebar draws from it, the Streaming
// default, and the store that keeps it in localStorage.
//
// Run: node scripts/sidebar-layout-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Sidebar layout test timed out'); process.exit(1); }, 30000);
deadline.unref();

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    data,
  };
}
function useStorage(storage) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
}

const bundled = await build({
  stdin: { contents: "export * from './src/store/useSidebarLayout';", resolveDir: repoRoot, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
// The store reads localStorage once when it loads, so each import is its own copy.
let copies = 0;
const load = () => import(`data:text/javascript;base64,${Buffer.from(`${bundled.outputFiles[0].text}\n// copy ${copies++}`).toString('base64')}`);

const KEY = 'newamp:sidebar-layout:v1';
const catalog = [
  { id: 'main', items: ['home', 'library', 'now-playing'] },
  { id: 'streaming', items: ['music-servers', 'podcasts', 'radio'] },
  { id: 'app', items: ['about', 'settings'] },
];

useStorage(memoryStorage());
const m = await load();
const layout = (patch = {}) => ({ ...m.defaultSidebarLayout(), ...patch });
const byId = (groups, id) => groups.find((group) => group.id === id);
const ids = (items) => items.map((item) => item.id);

// ── the catalog in Sidebar.tsx matches what the layout code assumes ────────
{
  const source = await readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8');
  const groups = [...source.replace(/\r\n/g, '\n').matchAll(/label: '([^']+)',\n    items: \[([\s\S]*?)\n    \],/g)]
    .map((match) => ({ id: match[1].toLowerCase(), items: [...match[2].matchAll(/\bid: '([^']+)'/g)].map((item) => item[1]) }));
  assert.ok(groups.length >= 6, 'found the sidebar groups in the source');
  const all = groups.flatMap((group) => group.items);
  assert.equal(new Set(all).size, all.length, 'no item is listed twice');
  assert.ok(groups.some((group) => group.id === m.SIDEBAR_STREAMING_GROUP), 'the sidebar has the Streaming group');
  assert.deepEqual(groups.find((group) => group.id === 'streaming').items, ['music-servers', 'podcasts', 'radio']);
  for (const pinned of m.SIDEBAR_PINNED_ITEMS) assert.ok(all.includes(pinned), `${pinned} is a sidebar item`);
  for (const id of [...all, ...groups.map((group) => group.id)]) assert.match(id, /^[a-z][a-z0-9-]{0,39}$/, `${id} is a valid layout id`);
}

// ── reading saved data ─────────────────────────────────────────────────────
{
  assert.deepEqual(m.normalizeSidebarLayout(null), m.defaultSidebarLayout());
  for (const junk of [undefined, 'text', 42, true, [], () => 1]) {
    assert.deepEqual(m.normalizeSidebarLayout(junk), m.defaultSidebarLayout(), `unreadable input (${typeof junk}) gives the default`);
  }
  assert.deepEqual(m.normalizeSidebarLayout({ collapsed: { main: true } }), m.defaultSidebarLayout(), 'a record with no version is not trusted');
  assert.deepEqual(m.normalizeSidebarLayout({ v: 2, collapsed: { main: true }, hidden: ['radio'] }), m.defaultSidebarLayout(), 'an unknown version resets');
  assert.deepEqual(m.normalizeSidebarLayout({ v: 1 }), m.defaultSidebarLayout());

  const read = m.normalizeSidebarLayout({
    v: 1,
    collapsed: { main: true, streaming: false, bad: 'yes', 'Not-An-Id': true, __proto__: true },
    hidden: ['radio', 'radio', 'settings', 'Podcasts', 7, null, 'x'.repeat(60), 'about'],
    order: { main: ['library', 'home', 'library', 5], app: [], '__bad': ['home'], streaming: 'nope' },
    streamingUsed: true,
  });
  assert.deepEqual(read.collapsed, { main: true, streaming: false }, 'only boolean choices under valid group ids');
  assert.deepEqual(read.hidden, ['radio', 'about'], 'repeats, junk and Settings are dropped');
  assert.deepEqual(read.order, { main: ['library', 'home'] }, 'empty and malformed orders are dropped');
  assert.equal(read.streamingUsed, true);
  const hostile = m.normalizeSidebarLayout(JSON.parse('{"v":1,"collapsed":{"__proto__":true,"constructor":true,"main":true},"order":{"__proto__":["home"]},"hidden":["__proto__"]}'));
  assert.deepEqual(hostile.collapsed, { main: true }, 'keys like __proto__ do not reach the maps');
  assert.deepEqual(hostile.order, {});
  assert.deepEqual(hostile.hidden, []);
  assert.equal(Object.getPrototypeOf(hostile.collapsed), Object.prototype);

  assert.equal(m.normalizeSidebarLayout({ v: 1, streamingUsed: 'true' }).streamingUsed, false, 'only a real true counts');
  const many = m.normalizeSidebarLayout({ v: 1, hidden: Array.from({ length: 200 }, (_, i) => `item-${i}`) });
  assert.equal(many.hidden.length, 64, 'hidden is capped');
  const big = m.normalizeSidebarLayout({ v: 1, order: { main: Array.from({ length: 200 }, (_, i) => `item-${i}`) } });
  assert.equal(big.order.main.length, 32, 'an order is capped');
  const wide = m.normalizeSidebarLayout({ v: 1, collapsed: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`group-${i}`, true])) });
  assert.equal(Object.keys(wide.collapsed).length, 16, 'groups are capped');

  const again = m.normalizeSidebarLayout(JSON.parse(JSON.stringify(read)));
  assert.deepEqual(again, read, 'a normalised layout is its own fixed point');
}

// ── what the sidebar draws ─────────────────────────────────────────────────
{
  const fresh = m.resolveSidebar(catalog, layout());
  assert.deepEqual(fresh.map((group) => group.id), ['main', 'streaming', 'app']);
  assert.deepEqual(ids(byId(fresh, 'main').items), ['home', 'library', 'now-playing'], 'the catalog order is the default');
  assert.equal(byId(fresh, 'main').collapsed, false);
  assert.equal(byId(fresh, 'streaming').collapsed, true, 'Streaming starts collapsed with no server or feed');
  assert.equal(byId(fresh, 'app').collapsed, false);

  assert.equal(byId(m.resolveSidebar(catalog, layout({ streamingUsed: true })), 'streaming').collapsed, false, 'a server or feed opens it');
  assert.equal(byId(m.resolveSidebar(catalog, layout({ collapsed: { streaming: false } })), 'streaming').collapsed, false, 'opening it by hand sticks');
  assert.equal(byId(m.resolveSidebar(catalog, layout({ streamingUsed: true, collapsed: { streaming: true } })), 'streaming').collapsed, true, 'closing it by hand beats the default');
  assert.equal(byId(m.resolveSidebar(catalog, layout({ collapsed: { main: true } })), 'main').collapsed, true);

  const custom = m.resolveSidebar(catalog, layout({
    order: { main: ['now-playing', 'ghost', 'home'], nowhere: ['x'] },
    hidden: ['radio', 'settings', 'ghost'],
  }));
  assert.deepEqual(ids(byId(custom, 'main').items), ['now-playing', 'home', 'library'], 'the saved order leads, unknown ids are ignored, unplaced items follow');
  assert.deepEqual(byId(custom, 'streaming').items.map((item) => [item.id, item.hidden]), [['music-servers', false], ['podcasts', false], ['radio', true]]);
  assert.equal(byId(custom, 'app').items.find((item) => item.id === 'settings').hidden, false, 'Settings is never hidden');

  // A view added in a later version shows up at the end of its group.
  const later = m.resolveSidebar([{ id: 'main', items: ['home', 'library', 'now-playing', 'brand-new'] }], layout({ order: { main: ['library', 'home'] } }));
  assert.deepEqual(ids(later[0].items), ['library', 'home', 'now-playing', 'brand-new']);
}

// ── which items are drawn ──────────────────────────────────────────────────
{
  const groups = m.resolveSidebar(catalog, layout({ hidden: ['home', 'radio'], streamingUsed: true }));
  const main = byId(groups, 'main');
  assert.deepEqual(ids(m.visibleSidebarItems(main, 'library')), ['library', 'now-playing'], 'hidden items are not drawn');
  assert.deepEqual(ids(m.visibleSidebarItems(main, 'home')), ['home', 'library', 'now-playing'], 'but the view you are on always is');
  assert.equal(m.sidebarGroupShown(main, undefined), true);

  const closed = m.resolveSidebar(catalog, layout({ collapsed: { main: true } }));
  assert.deepEqual(ids(m.visibleSidebarItems(byId(closed, 'main'), 'library')), ['library'], 'a collapsed group still shows where you are');
  assert.deepEqual(m.visibleSidebarItems(byId(closed, 'main'), 'about'), [], 'and nothing else');
  assert.deepEqual(ids(m.visibleSidebarItems(byId(closed, 'streaming'), 'radio')), ['radio'], 'reaching a hidden-away view from Quick Play does not lose it');

  // Settings is how the rest of the app is reached: collapsing its group keeps it.
  const appClosed = byId(m.resolveSidebar(catalog, layout({ collapsed: { app: true } })), 'app');
  assert.deepEqual(ids(m.visibleSidebarItems(appClosed, 'home')), ['settings'], 'a collapsed group keeps its pinned item and drops the rest');
  assert.deepEqual(ids(m.visibleSidebarItems(appClosed, 'about')), ['about', 'settings'], 'and the view you are on');
  assert.equal(m.sidebarGroupShown(appClosed, 'home'), true);
  const settingsHidden = byId(m.resolveSidebar(catalog, layout({ hidden: ['settings'], collapsed: { app: true } })), 'app');
  assert.deepEqual(ids(m.visibleSidebarItems(settingsHidden, 'home')), ['settings'], 'even with a hand-edited layout that hides it');

  const gone = m.resolveSidebar(catalog, layout({ hidden: ['home', 'library', 'now-playing'] }));
  assert.equal(m.sidebarGroupShown(byId(gone, 'main'), 'about'), false, 'a group with every item hidden leaves no heading');
  assert.equal(m.sidebarGroupShown(byId(gone, 'main'), 'library'), true, 'unless you are on one of them');
  assert.equal(m.sidebarGroupShown(byId(m.resolveSidebar(catalog, layout({ collapsed: { main: true } })), 'main'), undefined), true, 'a collapsed group keeps its heading');
}

// ── where servers, feeds and stations are added ────────────────────────────
{
  for (const view of ['music-servers', 'podcasts', 'radio']) assert.equal(m.isStreamingView(view), true, `${view} is a streaming view`);
  for (const view of ['home', 'library', 'settings', 'playlist', '']) assert.equal(m.isStreamingView(view), false, `${view || 'an empty id'} is not`);
}

// ── reordering ─────────────────────────────────────────────────────────────
{
  assert.deepEqual(m.moveSidebarItem(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(m.moveSidebarItem(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(m.moveSidebarItem(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c'], 'stops at the top');
  assert.deepEqual(m.moveSidebarItem(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c'], 'and the bottom');
  assert.deepEqual(m.moveSidebarItem(['a', 'b', 'c'], 'a', 9), ['b', 'c', 'a'], 'a long move lands at the end');
  assert.deepEqual(m.moveSidebarItem(['a', 'b', 'c'], 'zzz', 1), ['a', 'b', 'c'], 'an unknown id changes nothing');
  assert.deepEqual(m.moveSidebarItem(['a', 'b', 'c'], 'b', 0.9), ['a', 'b', 'c'], 'a fraction is not a place');
}

// ── Streaming default from the library ─────────────────────────────────────
{
  const source = (servers, feeds) => ({
    getMusicServers: async () => servers,
    listPodcastSubscriptions: async () => feeds,
  });
  assert.equal(await m.hasStreamingSources(source([], [])), false);
  assert.equal(await m.hasStreamingSources(source([{ id: 's' }], [])), true, 'a server counts');
  assert.equal(await m.hasStreamingSources(source([], [{ id: 'f' }])), true, 'so does a feed');
  assert.equal(await m.hasStreamingSources({ getMusicServers: async () => { throw new Error('ipc'); }, listPodcastSubscriptions: async () => [{ id: 'f' }] }), true, 'one lookup failing does not hide the other');
  assert.equal(await m.hasStreamingSources({ getMusicServers: async () => { throw new Error('ipc'); }, listPodcastSubscriptions: async () => { throw new Error('ipc'); } }), false, 'both failing is none');
  assert.equal(await m.hasStreamingSources(source(null, undefined)), false, 'a non-list answer is none');
  let owner = null;
  await m.hasStreamingSources({
    getMusicServers() { owner = this; return Promise.resolve([]); },
    listPodcastSubscriptions: async () => [],
  });
  assert.ok(owner && typeof owner.getMusicServers === 'function', 'methods are called on their object');
}

// ── the store ──────────────────────────────────────────────────────────────
{
  const storage = memoryStorage();
  useStorage(storage);
  const store = (await load()).useSidebarLayout;
  const state = () => store.getState();
  assert.deepEqual({ ...state(), setCollapsed: undefined, setHidden: undefined, moveItem: undefined, markStreamingUsed: undefined, reset: undefined },
    { ...m.defaultSidebarLayout(), setCollapsed: undefined, setHidden: undefined, moveItem: undefined, markStreamingUsed: undefined, reset: undefined }, 'a fresh install starts from the default');
  assert.equal(storage.data.has(KEY), false, 'and writes nothing until something changes');

  state().setCollapsed('main', true);
  state().setHidden('radio', true);
  state().setHidden('settings', true);
  state().moveItem('main', ['home', 'library', 'now-playing'], 'now-playing', -2);
  assert.deepEqual(state().collapsed, { main: true });
  assert.deepEqual(state().hidden, ['radio'], 'Settings cannot be hidden');
  assert.deepEqual(state().order, { main: ['now-playing', 'home', 'library'] });
  const saved = JSON.parse(storage.data.get(KEY));
  assert.equal(saved.v, 1, 'what is saved carries its version');
  assert.deepEqual(saved.hidden, ['radio']);

  state().setHidden('radio', false);
  assert.deepEqual(state().hidden, [], 'an item comes back');
  state().setHidden('bad id', true);
  state().setCollapsed('__proto__', true);
  state().moveItem('Bad', ['a', 'b'], 'a', 1);
  assert.deepEqual(state().hidden, []);
  assert.deepEqual(state().collapsed, { main: true }, 'ids that are not ids are refused');
  assert.deepEqual(state().order, { main: ['now-playing', 'home', 'library'] });

  // It comes back after a restart.
  const reloaded = (await load()).useSidebarLayout.getState();
  assert.deepEqual(reloaded.collapsed, { main: true });
  assert.deepEqual(reloaded.order, { main: ['now-playing', 'home', 'library'] });

  state().markStreamingUsed();
  assert.equal(state().streamingUsed, true);
  const writes = storage.data.get(KEY);
  state().markStreamingUsed();
  assert.equal(storage.data.get(KEY), writes, 'noting it again changes nothing');

  state().reset();
  assert.deepEqual(state().collapsed, {});
  assert.deepEqual(state().hidden, []);
  assert.deepEqual(state().order, {});
  assert.equal(state().streamingUsed, true, 'reset puts the preferences back, not what the library holds');
}
{
  // Broken or blocked storage never stops the sidebar.
  useStorage(memoryStorage({ [KEY]: '{not json' }));
  assert.deepEqual((await load()).useSidebarLayout.getState().hidden, []);
  useStorage(memoryStorage({ [KEY]: JSON.stringify({ v: 1, hidden: ['radio', 'settings'], collapsed: { app: true } }) }));
  const kept = (await load()).useSidebarLayout.getState();
  assert.deepEqual(kept.hidden, ['radio']);
  assert.deepEqual(kept.collapsed, { app: true });
  useStorage({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } });
  const blocked = (await load()).useSidebarLayout;
  assert.doesNotThrow(() => blocked.getState().setHidden('radio', true));
  assert.deepEqual(blocked.getState().hidden, ['radio'], 'the choice still holds for this session');
  useStorage(undefined);
  const noStorage = (await load()).useSidebarLayout;
  assert.doesNotThrow(() => noStorage.getState().setCollapsed('main', true));
  assert.deepEqual(noStorage.getState().collapsed, { main: true }, 'with no storage at all it still works for the session');
}

console.log(JSON.stringify({ ok: true }, null, 2));
