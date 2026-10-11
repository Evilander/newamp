// The track table's column layout and widths: what a fresh install shows, how
// saved widths from older versions load, and the menu's placement rules. The
// defaults have to leave Time and Love on screen in the default 1280 px window.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Track columns test timed out'); process.exit(1); }, 30000);
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
  stdin: {
    contents: `
      export * from './src/store/useTrackColumns';
      export { isColumnsOpener, placeColumnsMenu, COLUMNS_OPENER_SELECTOR } from './src/components/TrackColumnsMenu';
    `,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', jsx: 'automatic', logLevel: 'silent',
});
// Each import gets its own copy of the store, which reads localStorage once when it loads.
let copies = 0;
const load = () => import(`data:text/javascript;base64,${Buffer.from(`${bundled.outputFiles[0].text}\n// copy ${copies++}`).toString('base64')}`);

// ── what a fresh install shows ─────────────────────────────────────────────
useStorage(memoryStorage());
const columns = await load();
{
  const { normalizeLayout, TRACK_COLUMN_ORDER_DEFAULT, TRACK_COLUMNS_FIXED } = columns;
  const fresh = normalizeLayout(null);
  assert.deepEqual(fresh.hidden, ['playlist', 'mix', 'tag'], 'a fresh install hides Playlist, Mix and Tag');
  assert.deepEqual([...fresh.order].sort(), [...TRACK_COLUMN_ORDER_DEFAULT].sort(), 'every column is still in the order');
  assert.deepEqual(fresh.order.slice(0, TRACK_COLUMNS_FIXED.length), [...TRACK_COLUMNS_FIXED], 'the fixed columns come first');
  assert.deepEqual(columns.useTrackColumns.getState().hidden, ['playlist', 'mix', 'tag'], 'the store starts from the same defaults');

  // A layout someone saved is theirs: nothing is hidden for them that they did not hide.
  assert.deepEqual(normalizeLayout({ order: [], hidden: [] }).hidden, [], 'a saved layout that hides nothing stays that way');
  assert.deepEqual(normalizeLayout({ order: [], hidden: ['year', 'year', 'bogus', 'play'] }).hidden, ['year'], 'saved hidden columns are cleaned, not replaced');
  assert.deepEqual(normalizeLayout({ order: ['love', 'title', 'nope', 'love'] }).order.slice(2, 4), ['love', 'title'], 'saved order is kept, unknown keys dropped');
  for (const junk of [undefined, 'text', 42, true]) {
    assert.deepEqual(normalizeLayout(junk).hidden, ['playlist', 'mix', 'tag'], `unreadable input (${String(junk)}) falls back to the defaults`);
  }
}

// ── the defaults fit the default window ────────────────────────────────────
{
  const { normalizeLayout, TRACK_COLUMN_WIDTH_DEFAULTS, TRACK_COLUMN_WIDTH_MINS, trackTableMinWidth } = columns;
  const fresh = normalizeLayout(null);
  const shown = fresh.order.filter((key) => !fresh.hidden.includes(key));
  assert.ok(shown.includes('time') && shown.includes('love'), 'Time and Love are shown by default');

  const WINDOW = 1280; // the window the app opens at
  const SIDEBAR = 200;
  const SCROLLBAR = 8;
  const FRAME = 16; // a framed window's border takes some of the 1280
  const pane = WINDOW - SIDEBAR - SCROLLBAR - FRAME;
  const total = trackTableMinWidth(shown, TRACK_COLUMN_WIDTH_DEFAULTS);
  assert.ok(total <= pane, `default columns total ${total}px; the Library pane is about ${pane}px wide at the default window size`);

  const everything = trackTableMinWidth(fresh.order, TRACK_COLUMN_WIDTH_DEFAULTS);
  assert.ok(everything > pane, 'showing every column does overflow, which is why three are hidden to begin with');

  for (const key of Object.keys(TRACK_COLUMN_WIDTH_DEFAULTS)) {
    assert.ok(TRACK_COLUMN_WIDTH_MINS[key] <= TRACK_COLUMN_WIDTH_DEFAULTS[key], `${key}: the default is not below the minimum`);
  }
}

// ── saved widths ───────────────────────────────────────────────────────────
{
  const { normalizeTrackColumnWidths, changedTrackColumnWidths, clampTrackColumnWidth, TRACK_COLUMN_WIDTH_DEFAULTS: defaults } = columns;
  // The widths every older version saved: all fifteen columns at once.
  const legacy = { play: 34, select: 34, queue: 74, playlist: 154, number: 44, title: 340, artist: 210, album: 220, year: 62, time: 70, plays: 62, rating: 96, mix: 70, tag: 56, love: 44 };

  assert.deepEqual(normalizeTrackColumnWidths(null), defaults, 'nothing saved gives the defaults');
  assert.deepEqual(normalizeTrackColumnWidths('junk'), defaults, 'junk gives the defaults');
  assert.deepEqual(normalizeTrackColumnWidths(legacy), defaults, 'a record of untouched old defaults is read as untouched');

  const resized = normalizeTrackColumnWidths({ ...legacy, title: 520 });
  assert.equal(resized.title, 520, 'a width someone chose still loads');
  assert.equal(resized.artist, defaults.artist, 'the columns they left alone follow the new defaults');

  const sparse = normalizeTrackColumnWidths({ album: 300 });
  assert.equal(sparse.album, 300, 'a record holding only the changed widths loads');
  assert.equal(sparse.title, defaults.title);

  assert.equal(normalizeTrackColumnWidths({ title: 10 }).title, columns.TRACK_COLUMN_WIDTH_MINS.title, 'widths are held to the minimum');
  assert.equal(normalizeTrackColumnWidths({ title: 9999 }).title, columns.TRACK_COLUMN_WIDTH_MAX, 'and to the maximum');
  assert.equal(normalizeTrackColumnWidths({ title: 'wide', artist: null, album: NaN }).title, defaults.title, 'unreadable values are ignored');
  assert.equal(normalizeTrackColumnWidths({ artist: null }).artist, defaults.artist, 'null is not read as zero');
  assert.equal(clampTrackColumnWidth('love', 36.6), 37, 'widths are whole pixels');

  assert.deepEqual(changedTrackColumnWidths(defaults), {}, 'defaults save as nothing');
  assert.deepEqual(changedTrackColumnWidths({ ...defaults, title: 400, love: 50 }), { title: 400, love: 50 }, 'only the changed widths are saved');
  assert.deepEqual(normalizeTrackColumnWidths(changedTrackColumnWidths({ ...defaults, title: 400 })), { ...defaults, title: 400 }, 'what is saved loads back the same');

  // What is stored is tagged, so the old-default rule only ever applies to the old all-columns records.
  const { trackColumnWidthsRecord } = columns;
  assert.deepEqual(trackColumnWidthsRecord({ ...defaults, title: 400 }), { v: 2, widths: { title: 400 } }, 'the record carries a version and the changed widths');
  assert.deepEqual(trackColumnWidthsRecord(defaults), { v: 2, widths: {} }, 'untouched widths save as an empty record');
  assert.deepEqual(normalizeTrackColumnWidths(trackColumnWidthsRecord({ ...defaults, title: 400 })), { ...defaults, title: 400 }, 'a stored record loads back the same');
  const dragged = { ...defaults, ...legacy };
  const through = JSON.parse(JSON.stringify(trackColumnWidthsRecord(dragged)));
  assert.deepEqual(normalizeTrackColumnWidths(through), dragged, 'widths set to the old defaults (Title 340, Artist 210, Album 220, ...) survive a restart');
  assert.equal(normalizeTrackColumnWidths({ title: 340 }).title, defaults.title, 'while the same value in an unversioned record is still read as the old default');
  assert.equal(normalizeTrackColumnWidths({ v: 2, widths: { title: 340 } }).title, 340, 'and in a versioned one it is a choice');
  assert.deepEqual(normalizeTrackColumnWidths({ v: 2 }), defaults, 'a tag with no widths is nothing');
  assert.deepEqual(normalizeTrackColumnWidths({ v: 2, widths: 'wide' }), defaults, 'and so are widths that are not a record');
  assert.equal(normalizeTrackColumnWidths({ v: 2, widths: { title: 9999 } }).title, columns.TRACK_COLUMN_WIDTH_MAX, 'versioned widths are clamped too');
}

// ── a narrow pane squeezes the columns nobody has resized ──────────────────
{
  const { normalizeLayout, fitTrackColumnWidths, trackTableMinWidth, TRACK_COLUMN_WIDTH_DEFAULTS: defaults, TRACK_COLUMN_WIDTH_MINS: mins } = columns;
  const fresh = normalizeLayout(null);
  const shown = fresh.order.filter((key) => !fresh.hidden.includes(key));
  const sum = (widths) => trackTableMinWidth(shown, widths);
  const allMins = sum(mins);
  assert.ok(allMins < 976, `the shown columns need ${allMins}px at their narrowest`);

  const wide = fitTrackColumnWidths(shown, defaults, 1280 - 200 - 8 - 16);
  assert.equal(wide, defaults, 'a pane that holds the columns leaves them as they are');
  assert.equal(fitTrackColumnWidths(shown, defaults, 0), defaults, 'a pane that has not been measured yet leaves them alone');
  assert.equal(fitTrackColumnWidths(shown, defaults, Number.NaN), defaults);

  // The 1200 px window: 1200 less the sidebar, the scrollbar and the frame.
  const pane = 1200 - 200 - 8 - 16;
  assert.ok(sum(defaults) > pane, 'the defaults do not fit a 1200 px window as they are');
  const fitted = fitTrackColumnWidths(shown, defaults, pane);
  assert.ok(sum(fitted) <= pane, `fitted columns total ${sum(fitted)}px, inside the ${pane}px pane, so Love is not pushed out of view`);
  assert.ok(sum(fitted) > pane - shown.length, 'and they use the room rather than shrinking further than needed');
  for (const key of shown) assert.ok(fitted[key] >= mins[key] && fitted[key] <= defaults[key], `${key} stays between its minimum and its default`);
  assert.ok(fitted.title < defaults.title && fitted.title > defaults.rating, 'the wide columns give up the most');
  assert.equal(defaults.title, 240, 'the defaults themselves are not changed');

  const tight = fitTrackColumnWidths(shown, defaults, 700);
  assert.deepEqual(Object.fromEntries(shown.map((key) => [key, tight[key]])), Object.fromEntries(shown.map((key) => [key, mins[key]])), 'below the minimums they stop at the minimums and the table scrolls');

  // A column someone has widened keeps its width; the rest make room.
  const chosen = { ...defaults, title: 300 };
  const around = fitTrackColumnWidths(shown, chosen, pane);
  assert.equal(around.title, 300, 'a resized column is not squeezed');
  assert.ok(sum(around) <= pane, 'the others give up what it took');
  const allChosen = Object.fromEntries(Object.keys(defaults).map((key) => [key, defaults[key] + 1]));
  assert.equal(fitTrackColumnWidths(shown, allChosen, 600), allChosen, 'with every column resized there is nothing to squeeze');
}

// ── keyboard resizing and the table's minimum width ────────────────────────
{
  const { trackColumnResizeStep, trackTableMinWidth, TRACK_COLUMN_WIDTH_DEFAULTS: defaults } = columns;
  assert.equal(trackColumnResizeStep('ArrowRight', false), 8);
  assert.equal(trackColumnResizeStep('ArrowRight', true), 32);
  assert.equal(trackColumnResizeStep('ArrowLeft', false), -8);
  assert.equal(trackColumnResizeStep('ArrowLeft', true), -32);
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'a']) assert.equal(trackColumnResizeStep(key, false), 0, `${key} does not resize`);
  assert.equal(trackTableMinWidth(['title', 'love'], defaults), defaults.title + defaults.love);
  assert.equal(trackTableMinWidth([], defaults), 0);
}

// ── the layout persists, and loads back ────────────────────────────────────
{
  const storage = memoryStorage();
  useStorage(storage);
  const { useTrackColumns } = await load();
  const store = useTrackColumns;
  store.getState().setHidden('year', true);
  store.getState().moveTo('rating', 6);
  const saved = JSON.parse(storage.getItem('newamp:track-table:columns'));
  assert.deepEqual(saved.hidden, ['playlist', 'mix', 'tag', 'year'], 'hiding a column keeps the others hidden');
  assert.equal(saved.order.indexOf('rating'), 6, 'the move is saved');

  store.getState().setHidden('mix', false);
  assert.ok(!store.getState().hidden.includes('mix'), 'a hidden default can be shown');
  store.getState().setHidden('play', true);
  assert.ok(!store.getState().hidden.includes('play'), 'the fixed columns cannot be hidden');

  // A second copy of the store is a fresh start of the app.
  const restarted = (await load()).useTrackColumns.getState();
  assert.deepEqual(restarted.hidden, store.getState().hidden, 'the layout survives a restart');
  assert.deepEqual(restarted.order, store.getState().order);

  store.getState().reset();
  assert.deepEqual(store.getState().hidden, ['playlist', 'mix', 'tag'], 'Reset returns to the defaults, hidden columns included');

  useStorage(memoryStorage({ 'newamp:track-table:columns': '{not json' }));
  assert.deepEqual((await load()).useTrackColumns.getState().hidden, ['playlist', 'mix', 'tag'], 'a corrupt saved layout does not stop the app');
  useStorage(memoryStorage({ 'newamp:track-table:columns': JSON.stringify({ order: [], hidden: [] }) }));
  assert.deepEqual((await load()).useTrackColumns.getState().hidden, [], 'a saved layout that shows everything is respected');
}

// ── the menu's placement and its opener ────────────────────────────────────
{
  const { placeColumnsMenu, isColumnsOpener, COLUMNS_OPENER_SELECTOR } = columns;
  const size = { width: 236, height: 300 };
  const viewport = { width: 1280, height: 720 };
  assert.deepEqual(placeColumnsMenu({ x: 100, y: 100 }, size, viewport), { left: 100, top: 100 }, 'where it fits, it opens at the point');
  assert.deepEqual(placeColumnsMenu({ x: 1270, y: 100 }, size, viewport), { left: 1280 - 236 - 8, top: 100 }, 'it stays inside the right edge');
  assert.deepEqual(placeColumnsMenu({ x: 100, y: 700 }, size, viewport), { left: 100, top: 720 - 300 - 8 }, 'it stays above the bottom edge, by its measured height');
  assert.deepEqual(placeColumnsMenu({ x: -50, y: -50 }, size, viewport), { left: 8, top: 8 }, 'and inside the top left');
  // A tall menu in a short window (large Text size, 640 px high): pinned to the top, scrolls inside.
  assert.equal(placeColumnsMenu({ x: 100, y: 300 }, { width: 236, height: 700 }, { width: 1280, height: 640 }).top, 8, 'a menu taller than the window starts at the top');

  const opener = { closest: (selector) => (selector === COLUMNS_OPENER_SELECTOR ? {} : null) };
  const other = { closest: () => null };
  assert.equal(isColumnsOpener(opener), true, 'a press on an opener (or inside one) is recognised');
  assert.equal(isColumnsOpener(other), false, 'a press elsewhere is not');
  assert.equal(isColumnsOpener(null), false);
  assert.equal(isColumnsOpener({}), false, 'a target that is not an element is not an opener');
  assert.equal(COLUMNS_OPENER_SELECTOR, '[data-newamp-track-columns-open]');
}

// ── the menu is a real dialog ──────────────────────────────────────────────
{
  const menu = await readFile(new URL('../src/components/TrackColumnsMenu.tsx', import.meta.url), 'utf8');
  assert.match(menu, /useModalFocus\(rootRef, firstToggleRef, true\)/, 'focus moves in, is trapped and is restored, through the shared hook');
  assert.match(menu, /role="dialog"\s+aria-modal="true"/, 'the dialog is marked modal');
  assert.match(menu, /ref=\{index === 0 \? firstToggleRef : undefined\}/, 'focus starts on the first column checkbox');
  assert.match(menu, /isColumnsOpener\(event\.target\)/, 'a press on the opener is left to the opener, so the button toggles');
  assert.doesNotMatch(menu, /MENU_HEIGHT\b/, 'the height is measured, not assumed');
  const css = await readFile(new URL('../src/styles/views/library.css', import.meta.url), 'utf8');
  assert.match(css, /\.track-columns-menu \{[^}]*max-height: calc\(100vh - 16px\)/, 'the popover never outgrows the window');
  assert.match(css, /\.track-columns-menu-list \{[^}]*overflow-y: auto/, 'and it is the list that scrolls, so Reset and Done stay in reach');
  assert.match(css, /\.track-columns-menu-move \{\s*width: 24px;\s*height: 24px;/, 'the reorder buttons are 24px targets');
  assert.match(css, /\.track-columns-btn \{[^}]*width: 24px;[^}]*height: 24px;/s, 'so is the header button');
}

console.log('[track-columns-test] ok: defaults fit 1280px, saved widths load, the menu places and opens correctly');
