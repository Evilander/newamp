// The Library list and the shared track table, rendered for real (server-side,
// with the app's singletons stubbed) and checked as markup: one Tab stop for
// the rows, a visible Columns button, ellipsized links, a closed-by-default
// overview. The pure rules behind them, and a few source contracts for things
// markup cannot show (no autofocus, the wheel listener, removal by id).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Library table test timed out'); process.exit(1); }, 60000);
deadline.unref();

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// Node 22.4+ ships a localStorage global that warns on first use; the stores
// under test read it once at load.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: { getItem: () => null, setItem() {}, removeItem() {} },
});

const noopStore = `
  const noop = () => {};
  const state = new Proxy({ searchQuery: '', current: null, fullscreenViz: false }, {
    get: (target, key) => (key in target ? target[key] : noop),
  });
  export const usePlayerStore = Object.assign((selector) => selector(state), { getState: () => state, setState: noop, subscribe: () => noop });
`;
const noopApi = `
  const noop = () => {};
  export const api = new Proxy({ platform: 'win32', getPlaylists: async () => [], onPlaylistsChanged: () => noop, onTracksRemoved: () => noop }, {
    get: (target, key) => (key in target ? target[key] : noop),
  });
  export const inElectron = false;
  export const winctl = undefined;
`;
const stubSingletons = {
  name: 'stub-app-singletons',
  setup(b) {
    b.onLoad({ filter: /[\\/]store[\\/]usePlayerStore\.ts$/ }, () => ({ contents: noopStore, loader: 'js' }));
    b.onLoad({ filter: /[\\/]src[\\/]lib[\\/]api\.ts$/ }, () => ({ contents: noopApi, loader: 'js' }));
  },
};

const bundled = await build({
  stdin: {
    contents: `
      export { TrackTable, LibraryOverview, LibraryHealthPanel, LibraryHealthIntro } from './src/components/views/LibraryView';
      export { ArtistLink, AlbumLink, TrackLink } from './src/components/EntityLink';
      export { wheelScoreDelta } from './src/components/ScoreRating';
      export * from './src/components/views/libraryTableState';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server.browser';
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
const render = (component, props) => m.renderToStaticMarkup(m.createElement(component, props));

const track = (id, extra = {}) => ({
  id, path: `/music/${id}.flac`, title: `Song ${id}`, artist: `Artist ${id}`, album: `Album ${id}`, albumArtist: `Artist ${id}`,
  trackNo: id, discNo: null, year: 2000, genre: null, duration: 200, bitrate: null, sampleRate: null, size: null, mtime: 0,
  hasArt: 0, loved: 0, rating: 0, ratingScore: null, avoidAutoPlay: 0, playCount: 0, lastPlayed: null, skipCount: 0,
  lastSkipped: null, bpm: null, key: null, replayGainTrackDb: null, replayGainAlbumDb: null, missingSince: null, ...extra,
});
const controls = (html) => [...html.matchAll(/<(?:button|input|select)\b[^>]*>/g)].map((match) => match[0]);
const tableRows = (html) => [...html.matchAll(/<tr [^>]*data-newamp-track-row[^>]*>[\s\S]*?<\/tr>/g)].map((match) => match[0]);
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

// ── the pure rules ─────────────────────────────────────────────────────────
{
  const rows = [track(1), track(2), track(3), track(4)];
  assert.equal(m.withoutTracks(rows, []), rows, 'no ids is the same list');
  assert.equal(m.withoutTracks(rows, [99]), rows, 'ids that are not in the list leave it alone');
  assert.deepEqual(m.withoutTracks(rows, [2, 4, 99]).map((t) => t.id), [1, 3], 'named rows go and the rest keep their order');
  assert.equal(rows.length, 4, 'the original list is untouched');

  assert.equal(m.rovingRowId([10, 11, 12], 11), 11, 'the row that last had focus is the Tab stop');
  assert.equal(m.rovingRowId([10, 11, 12], 99), 10, 'when it has scrolled away the first row is');
  assert.equal(m.rovingRowId([10, 11, 12], null), 10, 'and so it is before anything was focused');
  assert.equal(m.rovingRowId([4, 5, 6, 7, 8, 9, 10, 11, 12], null, 6), 10, 'in a scrolled list it is the first row on screen, not an overscan row');
  assert.equal(m.rovingRowId([4, 5], null, 6), 5, 'a short window clamps to its last row');
  assert.equal(m.rovingRowId([], 3), null, 'no rows, no stop');

  const shown = ['select', 'play', 'queue', 'title', 'artist', 'album', 'love'];
  assert.equal(m.resizeHandleStop(shown, null), 'title', 'before anything was focused the header\'s one Tab stop is Title\'s handle');
  assert.equal(m.resizeHandleStop(shown, 'album'), 'album', 'afterwards it is the handle that last had focus');
  assert.equal(m.resizeHandleStop(shown, 'year'), 'title', 'unless that column has been hidden');
  assert.equal(m.resizeHandleStop(['select', 'play', 'artist'], null), 'select', 'with Title hidden it is the first column\'s');
  assert.equal(m.resizeHandleStop([], null), null, 'no columns, no stop');
  assert.equal(m.nextResizeHandle(shown, 'title', 'ArrowDown'), 'artist', 'Down steps to the next column\'s handle');
  assert.equal(m.nextResizeHandle(shown, 'title', 'ArrowUp'), 'queue', 'Up to the previous one');
  assert.equal(m.nextResizeHandle(shown, 'love', 'ArrowDown'), 'love', 'and stops at the ends');
  assert.equal(m.nextResizeHandle(shown, 'select', 'ArrowUp'), 'select');
  assert.equal(m.nextResizeHandle(shown, 'album', 'Home'), 'select', 'Home jumps to the first');
  assert.equal(m.nextResizeHandle(shown, 'title', 'End'), 'love', 'End to the last');
  for (const key of ['ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'a']) assert.equal(m.nextResizeHandle(shown, 'title', key), null, `${key} does not move between handles`);
  assert.equal(m.nextResizeHandle(shown, 'year', 'ArrowDown'), null, 'a handle that is not shown has nowhere to go from');

  const slash = { key: '/', ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false };
  const idle = { typing: false, overlay: false };
  assert.equal(m.slashFocusesSearch(slash, idle), true, 'a bare slash jumps to the search box');
  assert.equal(m.slashFocusesSearch(slash, { typing: true, overlay: false }), false, 'but not while typing somewhere');
  assert.equal(m.slashFocusesSearch(slash, { typing: false, overlay: true }), false, 'nor over a dialog or the fullscreen visualizer');
  assert.equal(m.slashFocusesSearch({ ...slash, ctrlKey: true }, idle), false, 'chords are not a slash');
  assert.equal(m.slashFocusesSearch({ ...slash, metaKey: true }, idle), false);
  assert.equal(m.slashFocusesSearch({ ...slash, altKey: true }, idle), false);
  assert.equal(m.slashFocusesSearch({ ...slash, defaultPrevented: true }, idle), false, 'a key something else took stays taken');
  assert.equal(m.slashFocusesSearch({ ...slash, key: ' ' }, idle), false, 'Space is still the player\'s');
  assert.equal(m.slashFocusesSearch({ ...slash, key: 'l' }, idle), false, 'and so is L');
}

// ── the score wheel ────────────────────────────────────────────────────────
{
  assert.equal(m.wheelScoreDelta({ deltaY: -100 }), 0.1, 'wheel up raises the score by a tenth');
  assert.equal(m.wheelScoreDelta({ deltaY: 100 }), -0.1, 'wheel down lowers it');
  assert.equal(m.wheelScoreDelta({ deltaY: -3, shiftKey: true }), 1, 'Shift takes the coarse step, whatever the distance');
  assert.equal(m.wheelScoreDelta({ deltaY: 0, deltaX: 0 }), 0, 'a wheel event that moves nothing moves nothing');
  assert.equal(m.wheelScoreDelta({ deltaY: 0, deltaX: 80 }), 0, 'a sideways swipe is left to scroll the page');
  assert.equal(m.wheelScoreDelta({ deltaY: 0, deltaX: -80, shiftKey: true }), 1, 'macOS reports Shift+wheel as sideways travel');
  assert.equal(m.wheelScoreDelta({ deltaY: Number.NaN }), 0);

  const score = await read('src/components/ScoreRating.tsx');
  assert.match(score, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/, 'the wheel listener is native and not passive, so preventDefault holds');
  assert.match(score, /removeEventListener\('wheel', onWheel\)/, 'and it is removed again');
  assert.doesNotMatch(score, /onWheel=/, 'React\'s passive onWheel is gone');
  assert.match(score, /event\.preventDefault\(\);\s*const \{ value: current, onChange: commit \}/, 'the page is stopped from scrolling before the score is nudged');
}

// ── links in narrow cells ──────────────────────────────────────────────────
{
  const plain = render(m.ArtistLink, { artist: 'Radiohead' });
  assert.doesNotMatch(plain, /truncate/, 'links elsewhere keep wrapping as before');
  const cut = render(m.ArtistLink, { artist: 'Radiohead', truncate: true, tabIndex: -1 });
  assert.match(cut, /class="[^"]*\binline-block\b[^"]*\bmax-w-full\b[^"]*\btruncate\b/, 'a truncating link is its own ellipsis box');
  assert.equal(attr(cut, 'tabindex'), '-1', 'a link can be taken out of the Tab order');
  assert.equal(attr(render(m.AlbumLink, { album: 'OK Computer', albumArtist: 'Radiohead', truncate: true }), 'class')?.includes('truncate'), true);
  assert.equal(attr(render(m.TrackLink, { track: { title: 'Airbag', album: 'OK Computer' }, tabIndex: -1 }), 'tabindex'), '-1');
  assert.match(render(m.ArtistLink, { artist: 'Unknown', truncate: true }), /^<span/, 'an unknown artist is still plain text');
}

// ── the track table ────────────────────────────────────────────────────────
{
  const tracks = [track(1), track(2, { loved: 1 }), track(3), track(4)];
  const html = render(m.TrackTable, {
    tracks, currentId: 2, onPlay() {}, onPlayNext() {}, onAddToQueue() {}, onMetadataLookup() {},
  });

  // What a fresh install shows, and that it fits.
  const headers = [...html.matchAll(/<th [^>]*data-newamp-track-column="(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(headers, ['select', 'play', 'queue', 'number', 'title', 'artist', 'album', 'year', 'time', 'plays', 'rating', 'love']);
  const widths = [...html.matchAll(/<col style="width:(\d+)px"\/>/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, headers.length, 'a width for every column');
  const total = widths.reduce((sum, w) => sum + w, 0);
  assert.ok(total <= 1056, `columns add up to ${total}px, which has to fit the default window`);
  assert.match(html, new RegExp(`min-width:${total}px`), 'the table never squeezes below its columns');

  // One Tab stop.
  const rows = tableRows(html);
  assert.equal(rows.length, 4);
  rows.forEach((row, i) => {
    const rowTag = /^<tr [^>]*>/.exec(row)[0];
    const inner = controls(row.slice(rowTag.length));
    assert.ok(inner.length >= 8, 'a row has its controls');
    if (i === 0) {
      assert.equal(attr(rowTag, 'tabindex'), '0', 'the first row is the table\'s Tab stop');
      assert.ok(inner.every((tag) => attr(tag, 'tabindex') === undefined), 'and its controls stay in the Tab order');
    } else {
      assert.equal(attr(rowTag, 'tabindex'), '-1', `row ${i + 1} is reached with the arrow keys`);
      assert.ok(inner.every((tag) => attr(tag, 'tabindex') === '-1'), `no control in row ${i + 1} is a Tab stop: ${inner.filter((tag) => attr(tag, 'tabindex') !== '-1').join(' ')}`);
    }
  });
  assert.equal(rows.filter((row) => /^<tr [^>]*\stabindex="0"/.test(row)).length, 1, 'exactly one row is tabbable');
  assert.equal(attr(/^<tr [^>]*>/.exec(rows[0])[0], 'aria-label'), 'Song 1 by Artist 1', 'rows say what they are');
  assert.equal(attr(/^<tr [^>]*>/.exec(rows[1])[0], 'aria-current'), 'true', 'the playing row is marked');
  assert.equal(attr(/^<tr [^>]*>/.exec(rows[0])[0], 'aria-current'), undefined);

  // Artist and album end in an ellipsis rather than being cut mid-letter.
  assert.equal([...html.matchAll(/data-newamp-artist-link[^>]*class="[^"]*\btruncate\b/g)].length, 4, 'artist links truncate');
  assert.equal([...html.matchAll(/data-newamp-album-link[^>]*class="[^"]*\btruncate\b/g)].length, 4, 'album links truncate');

  // The Columns button is plain to see, labelled, and says where else the menu lives.
  const toolbar = /<div class="track-table-toolbar"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const button = /<button\b[^>]*>/.exec(toolbar)?.[0] ?? '';
  assert.match(toolbar, />Columns \(2 hidden\)<\/button>/, 'a labelled button that says what is hidden (Mix and Tag; Playlist needs a saved playlist)');
  assert.ok(button.includes('data-newamp-track-columns-open'), 'it opens the column menu');
  assert.match(attr(button, 'title') ?? '', /Right-click/, 'its tooltip mentions the header right-click');
  assert.equal(attr(button, 'aria-haspopup'), 'dialog');
  assert.equal(attr(button, 'aria-expanded'), 'false');
  assert.equal(attr(button, 'tabindex'), undefined, 'the labelled button is in the Tab order');
  const glyph = /<button[^>]*class="track-columns-btn"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(glyph.includes('data-newamp-track-columns-open'), 'the header glyph still opens it');
  assert.equal(attr(glyph, 'tabindex'), '-1', 'but it is the pointer\'s shortcut, not a second Tab stop for the same menu');
  assert.match(attr(glyph, 'title') ?? '', /Right-clicking the header/);
  assert.match(html, /<tr class="text-left[^>]*title="Right-click a column header/, 'and the header row says what a right-click does');
  assert.ok(html.indexOf('data-newamp-track-columns-open') < html.indexOf('track-columns-btn'), 'the labelled button comes first, so a scripted click lands on it');

  // Resize handles can be operated with the keyboard, and the header offers one Tab stop for all of them.
  const handles = [...html.matchAll(/<span role="separator"[^>]*>/g)].map((match) => match[0]);
  assert.equal(handles.length, headers.length);
  assert.deepEqual(handles.map((handle) => attr(handle, 'tabindex')), headers.map((key) => (key === 'title' ? '0' : '-1')), 'only Title\'s handle is tabbable until another has been focused');
  for (const handle of handles) {
    assert.ok(Number(attr(handle, 'aria-valuenow')) >= Number(attr(handle, 'aria-valuemin')), 'the value is not below the minimum');
    assert.ok(Number(attr(handle, 'aria-valuenow')) <= Number(attr(handle, 'aria-valuemax')), 'nor above the maximum');
  }
  assert.equal(attr(handles[headers.indexOf('title')], 'aria-valuenow'), '240');

  // A table that offers no queue or tag actions (Mixes, Albums) has fewer columns to hide.
  const plain = render(m.TrackTable, { tracks: tracks.slice(0, 2), currentId: null, onPlay() {} });
  assert.deepEqual([...plain.matchAll(/<th [^>]*data-newamp-track-column="(\w+)"/g)].map((match) => match[1]), ['select', 'play', 'number', 'title', 'artist', 'album', 'year', 'time', 'plays', 'rating', 'love']);
  assert.match(plain, />Columns \(1 hidden\)<\/button>/);

  // A scrolled list: only the rows in the window are drawn, one of them is the stop.
  const many = Array.from({ length: 40 }, (_, i) => track(i + 1));
  const windowed = render(m.TrackTable, {
    tracks: many, currentId: null, onPlay() {},
    virtualWindow: { startIndex: 20, endIndex: 32, topPad: 20 * 36, bottomPad: 7 * 36 },
  });
  const drawn = tableRows(windowed);
  assert.equal(drawn.length, 13);
  const stops = drawn.filter((row) => /^<tr [^>]*\stabindex="0"/.test(row));
  assert.equal(stops.length, 1, 'a scrolled list still has exactly one Tab stop');
  assert.match(stops[0], /data-track-id="27"/, 'the first row on screen, past the six overscan rows');
}

// ── the overview ───────────────────────────────────────────────────────────
{
  const health = {
    totals: { tracks: 987, albums: 100, artists: 50, duration: 3661 },
    missing: { artist: 1, album: 0, year: 1, art: 1, duration: 0 },
    quality: { lossless: 400, lossy: 587, hiRes: 20, dsd: 0, ffmpegFallback: 3, lowBitrate: 12, replayGainReady: 100, replayGainMissing: 887, unknown: 0 },
    duplicateGroups: [
      { artist: 'A', title: 'One', count: 2, exactMatchCount: 2, tracks: [] },
      { artist: 'B', title: 'Two', count: 2, exactMatchCount: 0, tracks: [] },
    ],
    legacyFormats: [{ ext: '.wma', count: 4 }],
    recentlyAdded: [track(1), track(2)],
    adoptedEdits: 0,
    generatedAt: 0,
  };
  const stats = { tracks: 987, albums: 100, artists: 50, duration: 3661 };
  const child = m.createElement('div', { 'data-probe-child': '' }, 'details');

  const closed = render(m.LibraryOverview, { open: false, onToggle() {}, stats, health, children: child });
  assert.match(closed, /aria-expanded="false"/, 'closed: one summary row');
  assert.doesNotMatch(closed, /id="library-overview-panel"|data-probe-child|data-newamp-view-onboarding/, 'and no panel, so the track list gets the space');
  assert.match(closed, /987 tracks · 100 albums · 50 artists · 1:01:01 · 3 missing tags · 2 duplicate groups/, 'the summary carries the headline numbers');
  assert.match(closed, /class="library-overview-grade"[^>]*title="Archive score \d+\/100"/, 'with the grade');
  assert.match(closed, /aria-controls="library-overview-panel"/);
  assert.doesNotMatch(closed, /data-newamp-view-onboarding/);

  const open = render(m.LibraryOverview, { open: true, onToggle() {}, stats, health, children: child });
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /id="library-overview-panel"/);
  assert.match(open, /data-probe-child/, 'opened, it shows the report');
  assert.doesNotMatch(open, /data-newamp-view-onboarding/, 'the explainer is not buried in the panel that starts closed');

  // The explainer card is on the view itself, so a first visit shows it.
  const intro = render(m.LibraryHealthIntro, { help: { open: true, close() {} } });
  assert.match(intro, /data-newamp-view-onboarding="library-health"/, 'a dismissible card explaining the terms');
  assert.match(intro, /ReplayGain is a loudness tag/);
  assert.match(intro, /The Library health row above the list opens the report/, 'and it says where the report is');
  assert.match(intro, /Compass Moves are suggested clean-ups, and most open the matching tracks when clicked/);
  assert.doesNotMatch(intro, /raise it most/, 'it does not claim the moves are ranked, which they are not');
  assert.equal(render(m.LibraryHealthIntro, { help: { open: false, close() {} } }), '', 'dismissed, it takes no room');

  const loading = render(m.LibraryOverview, { open: false, onToggle() {}, stats, health: null, children: child });
  assert.doesNotMatch(loading, /library-overview-grade/, 'before the health report loads there is no grade');
  assert.match(loading, /987 tracks/, 'but the counts are there');

  // The panel itself: Compass Moves.
  const noop = () => {};
  const panel = render(m.LibraryHealthPanel, {
    health, cleanupStatus: null, prunePreview: null,
    onCleanMissingFiles: noop, onConfirmPrune: noop, onCancelPrune: noop, onResetAdoptedEdits: noop,
    onCreateDuplicateReviewPlaylist: noop, onCreateMissingReviewPlaylist: noop, onCreateLegacyReviewPlaylist: noop,
    onCreateQualityReviewPlaylist: noop, onSearchCompassMove: noop,
  });
  const moveButtons = [...panel.matchAll(/<button[^>]*data-newamp-compass-move[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
  assert.ok(moveButtons.length >= 3, 'moves that search are buttons');
  assert.ok(moveButtons.every((button) => /Click to list these tracks/.test(button)), 'and say what a click does');
  assert.match(panel, /Add ReplayGain/);
  assert.match(panel, /Review low-bitrate files/, 'a long name is shown whole');
  assert.doesNotMatch(panel, /w-24/, 'the label is no longer cut to a fixed width');
  const reviewDuplicates = /<div[^>]*title="[^"]*exact duplicates[^"]*"[^>]*>/.exec(panel)?.[0] ?? '';
  assert.ok(reviewDuplicates && !reviewDuplicates.includes('bevel-in'), 'a move with nothing to open is text, not a button lookalike');
  assert.match(panel, /<span title="Tracks with no loudness tag/, 'the jargon rows explain themselves');
}

// ── source contracts ───────────────────────────────────────────────────────
{
  const view = await read('src/components/views/LibraryView.tsx');
  assert.doesNotMatch(view, /autoFocus/, 'the search box takes focus only when asked');
  assert.match(view, /ref=\{searchInputRef\}/);
  assert.match(view, /window\.addEventListener\('keydown', onSlash\)/, '"/" is handled while Library is mounted');
  assert.match(view, /if \(search\) setSearch\(''\);\s*else e\.currentTarget\.blur\(\);/, 'Escape clears the box, then leaves it');
  assert.doesNotMatch(view, /<kbd>Ctrl K<\/kbd>/, 'the hint no longer advertises the Quick Play chord');
  assert.match(view, /shortcutLabel\('Mod\+F'\)/, 'the hint is the platform\'s search chord');

  assert.match(view, /useState\(readOverviewOpen\)/);
  assert.match(view, /getItem\(LIBRARY_OVERVIEW_OPEN_KEY\) === '1'/, 'the overview starts closed unless it was left open');
  assert.match(view, /writeOverviewOpen\(!overviewOpen\)/, 'and the choice is remembered');
  assert.match(view, /className="relative flex h-full flex-col overflow-y-auto"/, 'a short window still scrolls the whole view');
  assert.match(view, /className="min-h-\[240px\] flex-1 overflow-auto"/, 'and the table keeps a usable height');

  assert.match(view, /api\.onTracksRemoved\(\(ids\) => void refreshAfterRemovalRef\.current\(ids\)\)/, 'removal events carry their ids to the list');
  assert.match(view, /setTracks\(\(rows\) => withoutTracks\(rows, removedIds\)\)/, 'named rows are dropped in place');
  assert.match(view, /refreshAfterRemoval\(result\.removedIds\)/, 'so is the cleanup\'s');
  const refetch = view.slice(view.indexOf('async function refreshAfterRemoval'), view.indexOf('refreshAfterRemovalRef.current = refreshAfterRemoval'));
  assert.match(refetch, /offset: 0/, 'without ids the first page is still refetched');
  const local = refetch.slice(0, refetch.indexOf('const [nextTracks'));
  assert.doesNotMatch(local, /api\.getTracks/, 'removal by id does not refetch the list');

  assert.match(view, /aria-pressed=\{value === o\.id\}/, 'sort chips say which one is on');
  assert.match(view, /useViewHelp\('library-health'\)/, 'the card can be brought back');
  assert.match(view, /\{hasLibrary && <LibraryHealthIntro help=\{healthHelp\} \/>\}/, 'it is mounted on the view, ahead of the overview');
  assert.match(view, /<HelpDot help=\{healthHelp\} label="What is Library health\?" \/>/, 'with a "?" beside the title');
  assert.match(view, /onSearchCompassMove=\{showCompassMove\}/, 'Compass Moves go through the runner');
  const runner = view.slice(view.indexOf('function showCompassMove'), view.indexOf('return (', view.indexOf('function showCompassMove')));
  assert.match(runner, /setSearch\(query\);\s*commandBarRef\.current\?\.scrollIntoView\(\{ block: 'start' \}\)/, 'a move searches, then brings the search box and the list into view');
  assert.match(view, /ref=\{commandBarRef\}\s+className="library-commandbar/);
  assert.match(view, /onFocus=\{\(\) => onFocusRow\(t\.id\)\}/, 'a row that takes focus becomes the Tab stop');
  assert.match(view, /onFocusRow=\{setFocusedRowId\}/);
  assert.match(view, /onFocus=\{\(\) => setFocusedHandle\(column\)\}/, 'and so does a resize handle');
  assert.match(view, /tabIndex=\{column === handleStop \? 0 : -1\}/);
  assert.match(view, /JSON\.stringify\(trackColumnWidthsRecord\(widths\)\)/, 'widths are stored as a versioned record');
  assert.match(view, /fitTrackColumnWidths\(activeColumnKeys, columnWidths, paneWidth\)/, 'the columns are fitted to the measured pane');
  assert.match(view, /new ResizeObserver\(measure\)/, 'which follows the window');
  assert.match(view, /const startWidth = shownWidths\[column\]/, 'a drag starts from the width on screen');
  assert.match(view, /onKeyDown=\{\(event\) => resizeColumnByKey\(column, event\)\}/, 'column handles answer the arrow keys');
  assert.match(view, /overscan: LIBRARY_ROW_OVERSCAN/, 'the list and the table agree on the overscan');
}

console.log('[library-table-test] ok: one Tab stop, visible Columns button, closed overview, ids drop rows in place');
