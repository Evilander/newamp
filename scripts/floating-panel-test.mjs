// The floating panel and the colour editor inside it: where a panel may sit
// and how it remembers that (src/lib/floating-panel.ts), and what the editor's
// rows, readouts and tint controls render for a skin.
//
// Run: node scripts/floating-panel-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// The bundle is imported from a data URL, which would otherwise fill every stack trace.
Error.prepareStackTrace = (error, frames) => [`${error.name}: ${error.message}`, ...frames.slice(0, 6).map((frame) => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`)].join('\n');
const deadline = setTimeout(() => { console.error('Floating panel test timed out'); process.exit(1); }, 60000);
deadline.unref();

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const posix = (path) => path.replace(/\\/g, '/');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }, data };
}

// The editor reads its draft from useSkinDraft, which is wired to the whole
// player store. Here the same draft logic runs against a fake page.
const fakeDraftStore = {
  name: 'fake-skin-draft',
  setup(b) {
    b.onResolve({ filter: /store\/useSkinDraft$/ }, () => ({ path: 'fake-skin-draft', namespace: 'fake' }));
    b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
      loader: 'ts',
      resolveDir: repoRoot,
      contents: `
        import { createSkinDraftStore } from '${posix(repoRoot)}src/lib/skin-draft';
        const store = createSkinDraftStore(globalThis.__skinDraftDeps);
        // A server render reads a store's initial state; this hook reads the current one.
        export const useSkinDraft = Object.assign((selector) => selector(store.getState()), store);
      `,
    }));
  },
};

// The host asks the player store whether the deck window is up, and wraps the
// panel in an error boundary (which the server renderer cannot run); both are
// replaced with stand-ins.
const hostStubs = {
  '../store/usePlayerStore': 'export const usePlayerStore = (selector) => selector({ compactMode: globalThis.__compact === true });',
  './ErrorBoundary': "import { createElement } from 'react'; export const ErrorBoundary = ({ children }) => createElement('div', { 'data-boundary': '' }, children);",
};
const hostStubPlugin = {
  name: 'host-stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (!args.importer.replace(/\\/g, '/').endsWith('src/components/FloatingPanelHost.tsx') || !(args.path in hostStubs)) return null;
      return { path: args.path, namespace: 'host-stub' };
    });
    b.onLoad({ filter: /.*/, namespace: 'host-stub' }, (args) => ({ contents: hostStubs[args.path], loader: 'js', resolveDir: repoRoot }));
  },
};

const PAGE = {
  '--bg': '#0b1014', '--panel': '#11141b', '--panel-2': '#181d27', '--panel-3': '#232936', '--line': '#2a3140',
  '--accent': '#7c5cff', '--accent-dim': '#5a3fd6', '--accent-glow': 'rgba(124, 92, 255, 0.55)', '--on-accent': '#000000',
  '--ink': '#e8ecf3', '--ink-2': '#c0c8d6', '--muted': '#4a5160', '--warn': '#ffb000', '--error': '#ff3d3d',
  '--display-bg': '#0c0f17', '--display-fg': '#00ff66', '--bevel-light': 'rgba(255, 255, 255, 0.06)', '--bevel-dark': 'rgba(0, 0, 0, 0.5)',
  '--radius': '4px', '--radius-card': '8px',
};
globalThis.__skinDraftDeps = {
  settings: () => ({ theme: 'midnight', customSkin: null }),
  readCurrent: () => ({ ...PAGE }),
  preview() {}, restore() {}, save: async () => {}, shelve: () => null,
  onSettingsChange: () => () => {}, schedule: (run) => run(), notify() {}, now: () => 1,
};
globalThis.window = { innerWidth: 1280, innerHeight: 800 };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: memoryStorage() });
// Just enough page for the editor to read the colours it is showing, and to resolve a colour name.
globalThis.document = {
  documentElement: {},
  body: { appendChild() {} },
  createElement: () => ({ style: {}, remove() {} }),
};
globalThis.getComputedStyle = () => ({ color: 'rgb(0, 128, 128)', getPropertyValue: (name) => PAGE[name] ?? '' });

const bundled = await build({
  stdin: {
    contents: `
      export * from './src/lib/floating-panel';
      export { FloatingPanel } from './src/components/FloatingPanel';
      export { ColourRow, ContrastReadout, TintControls, ColourEditorPanel, onAccentNote } from './src/components/ColourEditor';
      export { useSkinDraft } from './src/store/useSkinDraft';
      export { FloatingPanelHost } from './src/components/FloatingPanelHost';
      export { openColourEditor, closeColourEditor, isColourEditorOpen } from './src/lib/colour-editor-open';
      export { keyTargetKind, visualizerTakesKey } from './src/components/visualizer-input';
      export { SKIN_VARIABLE_SECTIONS, SKIN_VARIABLE_HINTS } from './src/lib/skin-hints';
      export { SKIN_VARIABLES } from './shared/custom-skin';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', jsx: 'automatic', logLevel: 'silent',
  alias: { '@shared': `${repoRoot}shared` },
  plugins: [fakeDraftStore, hostStubPlugin],
  // react-dom/server asks for node:stream; give the in-memory module a require.
  banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire('${pathToFileURL(repoRoot).href}');` },
});
const m = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const { createElement: h } = m;
const html = (element) => {
  // React warns that layout effects do nothing on the server; the markup is what is under test.
  const original = console.error;
  console.error = () => {};
  try { return m.renderToStaticMarkup(element); } finally { console.error = original; }
};

// ── staying on screen ──────────────────────────────────────────────────────
{
  const view = { width: 1280, height: 800 };
  const box = { width: 400, height: 500 };
  assert.deepEqual(m.placeInViewport({ left: 100, top: 100 }, box, view), { left: 100, top: 100 }, 'a spot that fits is kept');
  assert.deepEqual(m.placeInViewport({ left: 1200, top: 700 }, box, view), { left: 872, top: 292 }, 'pulled back from the right and bottom edges');
  assert.deepEqual(m.placeInViewport({ left: -300, top: -50 }, box, view), { left: 8, top: 8 }, 'and from the left and top');
  assert.deepEqual(m.placeInViewport({ left: Number.NaN, top: Infinity }, box, view), { left: 8, top: 8 }, 'a number that is not a position lands on the margin');
  assert.deepEqual(m.placeInViewport({ left: 50.6, top: 20.4 }, box, view), { left: 51, top: 20 }, 'whole pixels');
  assert.deepEqual(m.placeInViewport({ left: 400, top: 400 }, { width: 2000, height: 3000 }, view), { left: 8, top: 8 }, 'a panel bigger than the window sits at the margin');
  assert.deepEqual(m.placeInViewport({ left: 0, top: 0 }, box, view, 0), { left: 0, top: 0 }, 'with no margin it can touch the edge');

  // Remembered where it was put, shown where it fits, back when the window grows.
  const put = { left: 700, top: 100 };
  const small = m.placeInViewport(put, box, { width: 800, height: 600 });
  assert.deepEqual(small, { left: 392, top: 92 }, 'a smaller window pulls it in');
  assert.deepEqual(m.placeInViewport(put, box, view), put, 'a larger one lets it return to the spot it was put at');
  assert.ok(small.left + box.width <= 800 - 8 && small.top + box.height <= 600 - 8, 'inside the smaller window');

  // Under the title bar: its buttons stay clear and its drag region is not reached.
  assert.equal(m.PANEL_TOP_LIMIT, 44, 'the 40px title bar and a gap');
  assert.deepEqual(m.placeInViewport({ left: 100, top: 0 }, box, view, m.PANEL_MARGIN, m.PANEL_TOP_LIMIT), { left: 100, top: 44 }, 'dragged to the top it stops under the bar');
  assert.deepEqual(m.placeInViewport({ left: -50, top: -50 }, box, view, m.PANEL_MARGIN, m.PANEL_TOP_LIMIT), { left: 8, top: 44 }, 'the sides keep the margin');
  assert.deepEqual(m.placeInViewport({ left: 100, top: 200 }, box, view, m.PANEL_MARGIN, m.PANEL_TOP_LIMIT), { left: 100, top: 200 }, 'lower down it is untouched');
  assert.deepEqual(m.placeInViewport({ left: 100, top: 790 }, box, view, m.PANEL_MARGIN, m.PANEL_TOP_LIMIT), { left: 100, top: 292 }, 'the bottom edge still holds');
  assert.equal(m.placeInViewport({ left: Number.NaN, top: Infinity }, box, view, m.PANEL_MARGIN, m.PANEL_TOP_LIMIT).top, 44, 'a number that is not a position lands under the bar');

  const first = m.defaultPanelPosition(box, view);
  assert.equal(first.left, 1280 - 400 - 16, 'opens at the right');
  assert.equal(first.top, 52, 'below the title bar');
  const cramped = m.defaultPanelPosition(box, { width: 300, height: 300 });
  assert.deepEqual(cramped, { left: 8, top: 44 }, 'in a tiny window it still starts on screen, under the title bar');
}

// ── remembering the position ───────────────────────────────────────────────
{
  const storage = memoryStorage();
  assert.equal(m.loadPanelPosition('colour-editor', storage), null, 'nothing saved yet');
  m.savePanelPosition('colour-editor', { left: 120.4, top: 64.6 }, storage);
  assert.deepEqual(m.loadPanelPosition('colour-editor', storage), { left: 120, top: 65 });
  assert.equal(m.loadPanelPosition('other-panel', storage), null, 'panels keep separate spots');
  assert.equal(JSON.parse(storage.data.get('newamp:floating-panel:colour-editor')).v, 1, 'the record is versioned');

  const junk = [null, 'text', 3, [], {}, { v: 1 }, { v: 1, left: '1', top: 2 }, { v: 1, left: Number.NaN, top: 2 }, { v: 1, left: 1, top: Infinity }, { v: 2, left: 1, top: 2 }];
  for (const value of junk) assert.equal(m.normalizePanelPosition(value), null, `${JSON.stringify(value)} is not a position`);
  assert.deepEqual(m.normalizePanelPosition({ v: 1, left: -40, top: 9000 }), { left: -40, top: 9000 }, 'far-off values are kept as they are; placing fixes them');

  assert.equal(m.loadPanelPosition('x', memoryStorage({ 'newamp:floating-panel:x': '{broken' })), null);
  assert.equal(m.loadPanelPosition('x', { getItem: () => { throw new Error('blocked'); }, setItem() {} }), null);
  assert.doesNotThrow(() => m.savePanelPosition('x', { left: 1, top: 2 }, { getItem: () => null, setItem: () => { throw new Error('quota'); } }));
  assert.doesNotThrow(() => m.savePanelPosition('x', { left: 1, top: 2 }, null));
  assert.equal(m.loadPanelPosition('x', null), null);
}

// ── moving with the keyboard ───────────────────────────────────────────────
{
  const at = { left: 100, top: 100 };
  assert.deepEqual(m.nudgePanel(at, 'ArrowLeft', false), { left: 92, top: 100 });
  assert.deepEqual(m.nudgePanel(at, 'ArrowRight', false), { left: 108, top: 100 });
  assert.deepEqual(m.nudgePanel(at, 'ArrowUp', false), { left: 100, top: 92 });
  assert.deepEqual(m.nudgePanel(at, 'ArrowDown', false), { left: 100, top: 108 });
  assert.deepEqual(m.nudgePanel(at, 'ArrowDown', true), { left: 100, top: 132 }, 'shift goes further');
  for (const key of ['Enter', 'Tab', ' ', 'a', 'Escape', 'Home']) assert.equal(m.nudgePanel(at, key, false), null, `${key} does not move it`);
}

// ── the panel ──────────────────────────────────────────────────────────────
{
  const out = html(h(m.FloatingPanel, { id: 'demo', title: 'Demo panel', width: 360, onClose() {}, footer: h('span', null, 'foot') }, h('p', null, 'body')));
  assert.match(out, /role="dialog"/);
  assert.match(out, /aria-label="Demo panel"/);
  assert.match(out, /aria-modal="false"/, 'the page behind it stays live');
  assert.match(out, /data-newamp-floating-panel="demo"/);
  assert.match(out, /aria-label="Move Demo panel"/, 'a keyboard handle to move it');
  assert.match(out, /aria-label="Close Demo panel"/);
  assert.match(out, /<div class="floating-panel-body"><p>body<\/p><\/div>/);
  assert.match(out, /<div class="floating-panel-foot"><span>foot<\/span><\/div>/);
  assert.match(out, /width:360px/);
  const left = Number(/left:(\d+)px/.exec(out)[1]);
  const top = Number(/top:(\d+)px/.exec(out)[1]);
  assert.ok(left >= 8 && left + 360 <= 1280, 'first paint is inside the window');
  assert.ok(top >= 8, 'and below its top edge');
  assert.doesNotMatch(html(h(m.FloatingPanel, { id: 'bare', title: 'Bare', onClose() {} }, 'x')), /floating-panel-foot/, 'no footer unless asked for');
}

// ── keys inside the panel ──────────────────────────────────────────────────
{
  // A panel over the fullscreen visualizer: its controls take their own keys,
  // so a letter or arrow on one of its buttons does not drive the presets.
  const target = (selectors) => ({ closest: (selector) => (selectors.some((wanted) => selector.includes(wanted)) ? {} : null) });
  const inPanel = target(['[data-newamp-floating-panel]']);
  assert.equal(m.keyTargetKind(inPanel), 'text', 'a button in the panel');
  assert.equal(m.visualizerTakesKey('preset-next', m.keyTargetKind(inPanel), false), false, 'does not step the presets');
  assert.equal(m.visualizerTakesKey('quality', m.keyTargetKind(inPanel), false), false, 'or toggle quality');
  assert.equal(m.visualizerTakesKey('escape', m.keyTargetKind(inPanel), false), false, 'and Esc is the panel\'s own');
  assert.equal(m.keyTargetKind(target([])), 'other', 'elsewhere nothing changes');
  assert.equal(m.keyTargetKind(null), 'other');

  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const panel = await read('../src/components/FloatingPanel.tsx');
  assert.match(panel, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*put\(next, true\);/, 'the grip keeps its arrows to itself');
  assert.match(panel, /event\.key !== 'Escape' \|\| event\.defaultPrevented\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*onClose\(\);/, 'Esc inside the panel closes it and stops there');
  assert.match(panel, /placeInViewport\(at, size, viewportSize\(\), PANEL_MARGIN, PANEL_TOP_LIMIT\)/, 'every placement keeps clear of the title bar');
  assert.doesNotMatch(panel.replace(/const fitToWindow[\s\S]*?;\n/, ''), /placeInViewport\(/, 'and goes through the one helper');
}

// ── the title bar and the type size ────────────────────────────────────────
{
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const css = await read('../src/styles/components/colour-editor.css');
  const extras = await read('../src/styles/components/chrome-extras.css');
  // The window is frameless and the title bar is a drag region, which ignores stacking.
  assert.match(css, /\n\.floating-panel \{[^}]*-webkit-app-region: no-drag;/, 'the panel is not part of the title bar\'s drag region');
  assert.match(extras, /\n\.sidebar-menu \{[^}]*-webkit-app-region: no-drag;/, 'nor is the Customise menu');
  assert.match(css, /\n\.floating-panel \{[^}]*max-height: calc\(100vh - 52px\);/, 'it fits between the 44px limit and the bottom margin');
  assert.match(extras, /\n\.sidebar-menu \{[^}]*max-height: calc\(100vh - 52px\);/);
  // Text size: nothing in the panel or the menu is a fixed size.
  assert.doesNotMatch(css, /font-size:\s*[\d.]+(px|rem)/, 'the editor\'s type follows Settings > Text size');
  assert.match(css, /--ce-text: calc\(12px \* var\(--newamp-text-scale, 1\)\)/);
  const sidebarRules = [...extras.matchAll(/\n(\.sidebar-(?:group|customise|menu)[^{]*)\{([^}]*)\}/g)];
  assert.ok(sidebarRules.length > 10, 'found the sidebar rules');
  for (const [, selector, body] of sidebarRules) {
    assert.doesNotMatch(body, /font-size:\s*[\d.]+px/, `${selector.trim()} scales with the text size`);
  }
}

// ── the host ───────────────────────────────────────────────────────────────
{
  globalThis.__compact = false;
  assert.equal(m.isColourEditorOpen(), false);
  assert.equal(html(h(m.FloatingPanelHost)), '', 'nothing is mounted while the editor is closed');
  m.openColourEditor();
  assert.match(html(h(m.FloatingPanelHost)), /data-boundary/, 'open: the editor is mounted behind an error boundary');
  globalThis.__compact = true;
  assert.equal(html(h(m.FloatingPanelHost)), '', 'the deck window has no room for it');
  assert.equal(m.isColourEditorOpen(), true, 'but it stays open for when the window comes back');
  globalThis.__compact = false;
  assert.match(html(h(m.FloatingPanelHost)), /data-boundary/);
  m.closeColourEditor();
  assert.equal(html(h(m.FloatingPanelHost)), '');

  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const host = await read('../src/components/FloatingPanelHost.tsx');
  assert.match(host, /<ErrorBoundary fallback=\{<CloseOnError \/>\}>/, 'a panel that throws closes itself');
  assert.match(host, /function CloseOnError\(\): null \{\s*useEffect\(\(\) => closeColourEditor\(\), \[\]\);\s*return null;/);
  const main = await read('../src/main.tsx');
  assert.match(main, /<App \/>\s*<FloatingPanelHost \/>/, 'mounted beside the app, outside its chrome, so it shows over the visualizer');
  const palette = await read('../src/components/QuickPlayPalette.tsx');
  assert.match(palette, /\{ command: 'edit-colours', title: 'Edit Colours'/, 'the palette lists the command');
  assert.match(palette, /command === 'edit-colours'\) \{\s*openColourEditor\(\);\s*onClose\(\);/, 'and runs it');
  const settings = await read('../src/components/views/SettingsView.tsx');
  assert.match(settings, /onClick=\{openColourEditor\} data-newamp-open-colour-editor>Edit over the app/, 'the Workshop opens it too');

  // A save that fails is shown in the footer, ahead of the unsaved mark, until the next edit.
  const editor = await read('../src/components/ColourEditor.tsx');
  assert.match(editor, /const \{ skin, error \} = await runSkinSave\(save\);\s*setSaveError\(error\);/, 'the editor keeps the error from the save');
  assert.match(editor, /editorFooterStatus\(\{ dirty, error: saveError, saved: status \}\)/, 'and the footer reads it');
  assert.match(editor, /useEffect\(\(\) => \{\s*setSaveError\(null\);\s*\}, \[draft, name\]\);/, 'an edit clears it');
  assert.match(editor, /if \(saved\) closeColourEditor\(\); else setAsking\(false\);/, 'a failed save from the close prompt keeps the editor open, on the error');
}

// ── the editor ─────────────────────────────────────────────────────────────
{
  // Sections cover every variable exactly once, in words of the interface.
  const listed = m.SKIN_VARIABLE_SECTIONS.flatMap((section) => section.keys);
  assert.deepEqual([...listed].sort(), [...m.SKIN_VARIABLES].sort(), 'every skin variable has a place in the editor, once');
  for (const key of m.SKIN_VARIABLES) assert.ok(m.SKIN_VARIABLE_HINTS[key]?.label, `${key} has a label`);

  const row = (variable, value, extra = {}) => html(h(m.ColourRow, { variable, value, onChange() {}, ...extra }));
  const accent = row('--accent', '#ff0000');
  assert.match(accent, /type="color"[^>]*value="#ff0000"|value="#ff0000"[^>]*type="color"/, 'a colour picker with the hex');
  assert.match(accent, /aria-label="Accent value"/);
  assert.match(accent, /type="range"/, 'the accent takes an opacity slider');
  assert.match(accent, /aria-label="Accent opacity"/);
  assert.match(accent, /aria-valuetext="100%"/, 'a screen reader hears a percentage');
  assert.match(accent, /Highlights, active controls, lit text/, 'the hint shows on the page rows');
  assert.doesNotMatch(row('--accent', '#ff0000', { compact: true }), /Highlights, active controls/, 'and not in the narrow editor');

  const glow = row('--accent-glow', 'rgba(124, 92, 255, 0.55)');
  assert.match(glow, /type="range"[^>]*value="0\.55"|value="0\.55"[^>]*type="range"/, 'the slider holds the colour\'s alpha');
  assert.match(glow, /value="#7c5cff"/, 'and the picker its hex');
  assert.match(glow, /aria-valuetext="55%"/, 'the opacity is read as a percentage, not 0.55');

  const panel = row('--panel', '#11141b');
  assert.match(panel, /type="color"/);
  assert.doesNotMatch(panel, /type="range"/, 'a solid surface gets no opacity slider');
  assert.match(row('--panel', 'rgba(17, 20, 27, 0.5)'), /type="range"/, 'unless it is already translucent');

  const bad = row('--accent', '#12');
  assert.match(bad, /aria-invalid="true"/, 'a half-typed value is marked');
  assert.doesNotMatch(bad, /type="color"/, 'and gets no picker');
  assert.doesNotMatch(row('--accent', ''), /aria-invalid/, 'an empty field is not an error');

  const radius = row('--radius', '4px');
  assert.doesNotMatch(radius, /type="color"|type="range"|workshop-swatch/, 'a length has no picker, slider or swatch');
  assert.match(row('--radius', '99999px'), /aria-invalid="true"/);
  const named = row('--ink', 'teal');
  assert.match(named, /value="teal"/, 'a name shows as typed');
  assert.match(named, /value="#008080"/, 'and the picker gets what the browser resolves it to');

  // The label colour: say so when the page paints another than the field holds.
  assert.equal(m.onAccentNote('--on-accent', '#000000', { '--on-accent': '#ffffff' }), 'On screen: #ffffff, so it reads on the accent');
  assert.equal(m.onAccentNote('--on-accent', '#000000', { '--on-accent': '#000000' }), undefined, 'nothing to say when they agree');
  assert.equal(m.onAccentNote('--on-accent', '#000', { '--on-accent': ' #000 ' }), undefined, 'spacing does not count');
  assert.equal(m.onAccentNote('--on-accent', '#000000', {}), undefined, 'or when the page has no answer yet');
  assert.equal(m.onAccentNote('--ink', '#000000', { '--ink': '#ffffff' }), undefined, 'only the label follows another colour');
  assert.match(row('--on-accent', '#000000', { note: 'On screen: #ffffff, so it reads on the accent' }), /On screen: #ffffff/);

  const readout = html(h(m.ContrastReadout, { values: { ...PAGE } }));
  assert.equal((readout.match(/<li /g) ?? []).length, 7, 'one line per pair');
  assert.match(readout, /Text on panels/);
  assert.match(readout, /data-state="low"[^>]*><span class="contrast-label">Muted text on panels<\/span>/, 'the dim muted colour is flagged');
  assert.match(readout, /\d+\.\d\d:1 low<\/span><span class="contrast-need">needs 4\.5:1/, 'in words as well as colour, with the bar it missed');
  assert.match(readout, /data-state="ok"[^>]*><span class="contrast-label">Text on panels<\/span><span class="contrast-ratio">\d+\.\d\d:1 ok</);
  assert.match(html(h(m.ContrastReadout, { values: {} })), /not measured/, 'a missing colour is not measured');

  // The whole editor, over a draft that has begun.
  m.useSkinDraft.getState().begin();
  const tint = html(h(m.TintControls));
  assert.equal((tint.match(/type="range"/g) ?? []).length, 3, 'hue, saturation and brightness');
  assert.match(tint, /Hue/);
  assert.match(tint, /Brightness/);
  assert.match(tint, /<button[^>]*disabled=""[^>]*>Reset tint/, 'nothing to reset at neutral');
  m.useSkinDraft.getState().setTint({ hue: 40 });
  const moved = html(h(m.TintControls));
  assert.match(moved, /\+40°/);
  assert.doesNotMatch(moved, /<button[^>]*disabled=""[^>]*>Reset tint/);

  m.useSkinDraft.getState().resetTint();
  const editor = html(h(m.ColourEditorPanel));
  for (const key of m.SKIN_VARIABLES) assert.match(editor, new RegExp(`data-newamp-colour-row="${key}"`), `${key} has a row`);
  assert.match(editor, /aria-label="Colour editor"/);
  assert.match(editor, /Matches the saved skin/, 'clean at the start');
  assert.match(editor, /role="status"[^>]*data-tone="ok"|data-tone="ok"[^>]*role="status"/, 'the footer says so politely');
  assert.match(editor, /Save skin/);
  m.useSkinDraft.getState().setVar('--accent', '#112233');
  const edited = html(h(m.ColourEditorPanel));
  assert.match(edited, /Unsaved changes/, 'an edit shows as unsaved');
  assert.match(edited, /data-tone="dirty"/);
  assert.doesNotMatch(edited, /role="alert"/, 'a failed save is the only alert');
}

console.log(JSON.stringify({ ok: true }, null, 2));
