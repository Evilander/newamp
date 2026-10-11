// What the sidebar draws for a saved layout (src/components/Sidebar.tsx with the
// real layout store): the Streaming group starts collapsed, hidden items stay
// out, the order follows the layout, and the view you are on is never lost.
// Also what the Customise menu shows for the same layout.
//
// Run: node scripts/sidebar-render-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

Error.prepareStackTrace = (error, frames) => [`${error.name}: ${error.message}`, ...frames.slice(0, 6).map((frame) => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`)].join('\n');
const deadline = setTimeout(() => { console.error('Sidebar render test timed out'); process.exit(1); }, 60000);
deadline.unref();

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const posix = (path) => path.replace(/\\/g, '/');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }, data };
}
function useStorage(storage) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
}

// The sidebar's neighbours (the player store, the platform labels, the
// projector hook, the library lookups) are replaced; the layout store is real.
const stubs = {
  'store/usePlayerStore': `
    const noop = () => {};
    export const usePlayerStore = (selector) => selector({
      view: globalThis.__view, setView: noop, setFullscreenViz: noop, setCompactMode: noop, toggleEq: noop, showEq: false,
    });
  `,
  './useDetachedVisualizer': 'export function useDetachedVisualizer() { return { available: false, isOpen: false, busy: false, open() {}, close() {} }; }',
  'lib/format': "export const deckModeShortcutLabel = () => 'Deck chord'; export const shortcutLabel = () => 'Quick chord';",
  'hooks/useStreamingPresence': 'export function useStreamingPresence() {}',
};
// The menu draws through a portal, which the server renderer cannot do; here it just returns what it was given.
const menuStubs = { 'react-dom': 'export const createPortal = (children) => children;' };
const stubPlugin = {
  name: 'sidebar-stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind !== 'import-statement' && args.kind !== 'dynamic-import') return null;
      const importer = args.importer.replace(/\\/g, '/');
      if (importer.endsWith('src/components/SidebarCustomizeMenu.tsx') && args.path in menuStubs) return { path: args.path, namespace: 'sidebar-menu-stub' };
      if (!importer.endsWith('src/components/Sidebar.tsx')) return null;
      const hit = Object.keys(stubs).find((key) => args.path.endsWith(key));
      return hit ? { path: hit, namespace: 'sidebar-stub' } : null;
    });
    b.onLoad({ filter: /.*/, namespace: 'sidebar-stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
    b.onLoad({ filter: /.*/, namespace: 'sidebar-menu-stub' }, (args) => ({ contents: menuStubs[args.path], loader: 'js' }));
  },
};

useStorage(memoryStorage());
globalThis.window = { innerWidth: 1280, innerHeight: 800 };
const bundled = await build({
  stdin: {
    contents: `
      export { Sidebar } from './src/components/Sidebar';
      export { SidebarCustomizeMenu, SIDEBAR_MENU_OPENER_SELECTOR } from './src/components/SidebarCustomizeMenu';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', jsx: 'automatic', logLevel: 'silent',
  alias: { '@shared': `${posix(repoRoot)}shared` },
  plugins: [stubPlugin],
  banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire('${pathToFileURL(repoRoot).href}');` },
});
let copies = 0;
// Each copy reads localStorage when it loads, so a layout is set by loading a fresh one.
async function render(layout, view = 'library') {
  useStorage(memoryStorage(layout ? { 'newamp:sidebar-layout:v1': JSON.stringify(layout) } : {}));
  globalThis.__view = view;
  const m = await import(`data:text/javascript;base64,${Buffer.from(`${bundled.outputFiles[0].text}\n// copy ${copies++}`).toString('base64')}`);
  const original = console.error;
  console.error = () => {};
  try { return m.renderToStaticMarkup(m.createElement(m.Sidebar)); } finally { console.error = original; }
}
let opener = '';
async function renderMenu(groups, layout) {
  useStorage(memoryStorage(layout ? { 'newamp:sidebar-layout:v1': JSON.stringify(layout) } : {}));
  globalThis.document = { body: {} };
  const m = await import(`data:text/javascript;base64,${Buffer.from(`${bundled.outputFiles[0].text}\n// copy ${copies++}`).toString('base64')}`);
  opener = m.SIDEBAR_MENU_OPENER_SELECTOR;
  const original = console.error;
  console.error = () => {};
  try { return m.renderToStaticMarkup(m.createElement(m.SidebarCustomizeMenu, { at: { x: 220, y: 120 }, groups, onClose() {} })); } finally { console.error = original; }
}
const labels = (html) => [...html.matchAll(/<button class="nav-item[^"]*"[^>]*>.*?<span>([^<]+)<\/span><\/button>/g)].map((match) => match[1]);
const heads = (html) => [...html.matchAll(/<button type="button" class="sidebar-group-head"[^>]*><svg[^>]*>.*?<\/svg><span>([^<]+)<\/span>/g)].map((match) => match[1]);

// ── a fresh install ────────────────────────────────────────────────────────
{
  const html = await render(null);
  assert.deepEqual(heads(html), ['Main', 'Explore', 'Discovery', 'Yours', 'Streaming', 'App'], 'every group has a heading you can click');
  assert.equal(labels(html).length, 16, 'the first-run sidebar is 16 rows: Streaming starts collapsed');
  for (const hidden of ['Music Servers', 'Podcasts', 'Radio']) assert.ok(!labels(html).includes(hidden), `${hidden} waits behind the collapsed group`);
  assert.deepEqual(labels(html).slice(0, 3), ['Home', 'Library', 'Now Playing'], 'the default order is the sidebar\'s own');
  assert.match(html, /data-newamp-sidebar-group="streaming"[^>]*><button[^>]*aria-expanded="false"/);
  assert.match(html, /data-newamp-sidebar-group="main"[^>]*><button[^>]*aria-expanded="true"/);
  assert.match(html, /aria-controls="sidebar-group-streaming"/);
  assert.match(html, /id="sidebar-group-streaming"/, 'the list a heading controls is always in the page');
  assert.match(html, /data-newamp-sidebar-customise-open/, 'a Customise entry');
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /w-\[200px\]/, 'the sidebar keeps its width');
  assert.match(html, /nav-item active/, 'the current view is marked');
  assert.equal(labels(html).includes('Settings'), true);
}

// ── Streaming opens once there is something in it ──────────────────────────
{
  const html = await render({ v: 1, streamingUsed: true });
  assert.equal(labels(html).length, 19);
  assert.match(html, /data-newamp-sidebar-group="streaming"[^>]*><button[^>]*aria-expanded="true"/);
  const closedByHand = await render({ v: 1, streamingUsed: true, collapsed: { streaming: true } });
  assert.equal(labels(closedByHand).length, 16, 'a group closed by hand stays closed');
  const openedByHand = await render({ v: 1, collapsed: { streaming: false } });
  assert.equal(labels(openedByHand).length, 19, 'and one opened by hand stays open');
}

// ── the person's layout ────────────────────────────────────────────────────
{
  const html = await render({
    v: 1,
    streamingUsed: true,
    hidden: ['wrapped', 'radio', 'settings'],
    order: { main: ['now-playing', 'home'] },
    collapsed: { explore: true },
  });
  const rows = labels(html);
  assert.deepEqual(rows.slice(0, 3), ['Now Playing', 'Home', 'Library'], 'the saved order leads, the rest follow');
  assert.ok(!rows.includes('Wrapped') && !rows.includes('Radio'), 'hidden items are not drawn');
  assert.ok(rows.includes('Settings'), 'Settings cannot be hidden');
  assert.ok(!rows.includes('Albums') && !rows.includes('Artists'), 'a collapsed group lists nothing');
  assert.match(html, /data-newamp-sidebar-group="explore"[^>]*><button[^>]*aria-expanded="false"/);
  assert.ok(heads(html).includes('Explore'), 'but keeps its heading');

  const wiped = await render({ v: 1, hidden: ['home', 'library', 'now-playing'] }, 'albums');
  assert.ok(!heads(wiped).includes('Main'), 'a group with everything hidden has no heading either');

  const junk = await render({ v: 9, hidden: ['home'] });
  assert.ok(labels(junk).includes('Home'), 'an unknown version is ignored');
}

// ── you are never lost ─────────────────────────────────────────────────────
{
  const onHidden = await render({ v: 1, hidden: ['library'] }, 'library');
  assert.ok(labels(onHidden).includes('Library'), 'a hidden view you are on still shows');
  assert.match(onHidden, /nav-item active/);
  const inCollapsed = await render(null, 'radio');
  assert.ok(labels(inCollapsed).includes('Radio'), 'a view in the collapsed group (from Quick Play) shows');
  assert.ok(!labels(inCollapsed).includes('Podcasts'), 'and only that one');
  assert.match(inCollapsed, /data-newamp-sidebar-group="streaming"[^>]*><button[^>]*aria-expanded="false"/);
}

// ── Settings stays reachable ───────────────────────────────────────────────
{
  const html = await render({ v: 1, collapsed: { app: true } }, 'home');
  assert.deepEqual(labels(html).slice(-1), ['Settings'], 'collapsing the App group keeps Settings');
  assert.ok(!labels(html).includes('About'), 'and drops the rest of it');
  assert.match(html, /data-newamp-sidebar-group="app"[^>]*><button[^>]*aria-expanded="false"/);
}

// ── the Customise menu ─────────────────────────────────────────────────────
{
  const groups = [
    { id: 'main', label: 'Main', items: [
      { id: 'home', label: 'Home', hidden: false },
      { id: 'library', label: 'Library', hidden: true },
      { id: 'now-playing', label: 'Now Playing', hidden: false },
    ] },
    { id: 'app', label: 'App', items: [
      { id: 'about', label: 'About', hidden: false },
      { id: 'settings', label: 'Settings', hidden: false },
    ] },
  ];
  const html = await renderMenu(groups, null);
  assert.match(html, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Customise sidebar"|aria-label="Customise sidebar"[^>]*role="dialog"/, 'a modal dialog with a name');
  assert.match(html, /data-newamp-sidebar-menu(?!-)/);
  assert.match(html, /left:\d+px;top:\d+px;width:252px|top:\d+px;width:252px/, 'placed in the window');
  assert.deepEqual([...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1]), ['Main', 'App'], 'grouped as the sidebar is');

  const rows = Object.fromEntries([...html.matchAll(/<li data-newamp-sidebar-menu-row="([^"]+)">(.*?)<\/li>/g)].map((match) => [match[1], match[2]]));
  assert.deepEqual(Object.keys(rows), ['home', 'library', 'now-playing', 'about', 'settings'], 'every item, hidden ones too, in the order given');
  const checked = (row) => /<input[^>]*checked=""/.test(row);
  const disabledInput = (row) => /<input[^>]*disabled=""/.test(row);
  assert.equal(checked(rows.home), true, 'a shown item is ticked');
  assert.equal(checked(rows.library), false, 'a hidden one is not');
  assert.equal(disabledInput(rows.home), false);
  assert.equal(disabledInput(rows.settings), true, 'Settings cannot be unticked');
  assert.match(rows.settings, /title="Settings always stays in the sidebar"/);
  assert.doesNotMatch(rows.about, /title="Settings always/);

  const up = (row) => /<button[^>]*data-newamp-sidebar-menu-up/.exec(row)?.[0] ?? '';
  const down = (row) => /<button[^>]*data-newamp-sidebar-menu-down/.exec(row)?.[0] ?? '';
  assert.match(up(rows.home), /disabled=""/, 'the first item cannot move up');
  assert.doesNotMatch(down(rows.home), /disabled=""/);
  assert.doesNotMatch(up(rows.library), /disabled=""/, 'the middle one moves either way');
  assert.doesNotMatch(down(rows.library), /disabled=""/);
  assert.match(down(rows['now-playing']), /disabled=""/, 'the last cannot move down');
  assert.doesNotMatch(up(rows['now-playing']), /disabled=""/);
  assert.match(up(rows.about), /disabled=""/, 'each group has its own ends');
  assert.match(down(rows.settings), /disabled=""/);
  assert.match(up(rows.library), /aria-label="Move Library up"/);
  assert.match(down(rows.library), /aria-label="Move Library down"/);

  assert.match(html, /<button[^>]*data-newamp-sidebar-menu-reset[^>]*>Reset<\/button>/, 'a way back to the default');
  assert.match(html, />Done<\/button>/);
  assert.equal(opener, '[data-newamp-sidebar-customise-open]', 'the opener mark the menu treats as a toggle');
}

// ── the menu's handlers, in the source ─────────────────────────────────────
{
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const menu = await read('../src/components/SidebarCustomizeMenu.tsx');
  const sidebar = await read('../src/components/Sidebar.tsx');
  assert.match(menu, /onChange=\{\(event\) => setHidden\(item\.id, !event\.currentTarget\.checked\)\}/, 'ticking an item shows or hides it');
  assert.match(menu, /onClick=\{\(\) => move\(group, item\.id, -1\)\}/);
  assert.match(menu, /onClick=\{\(\) => move\(group, item\.id, 1\)\}/);
  assert.match(menu, /onClick=\{reset\} data-newamp-sidebar-menu-reset/, 'Reset goes through the store');
  assert.match(menu, /moveItem\(group\.id, group\.items\.map\(\(item\) => item\.id\), itemId, delta\)/, 'a move starts from the order on screen');
  assert.match(menu, /\(same && !same\.disabled \? same : other\)\?\.focus\(\)/, 'focus goes back to the arrow just used, or the other at an end');
  assert.match(menu, /SIDEBAR_MENU_OPENER_SELECTOR\)\) return;/, 'a press on the opener is left to its click, so it toggles');
  assert.match(menu, /const SIDEBAR_MENU_OPENER_SELECTOR|export const SIDEBAR_MENU_OPENER_SELECTOR = '\[data-newamp-sidebar-customise-open\]'/);
  assert.match(sidebar, /data-newamp-sidebar-customise-open/, 'the button carries the opener mark');
  assert.match(sidebar, /setMenuAt\(\(current\) => \(current \? null : \{ x: box\.right \+ 8, y: box\.top \}\)\)/, 'the button opens the menu, and closes it when open');
  assert.match(sidebar, /onContextMenu=\{\(event\) => \{\s*event\.preventDefault\(\);\s*setMenuAt\(menuPointOf\(event\)\);/, 'a right-click on the list opens it too');
}

console.log(JSON.stringify({ ok: true }, null, 2));
