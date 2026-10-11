import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// Library rows: 0-5 and L act on the row that has focus, metadata edits reach the
// player's copies of the track, and the row controls carry names and the dense
// button size.

Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map(frame => `  at ${frame.getFunctionName() ?? '<anonymous>'}:${frame.getLineNumber()}`).join('\n')}`;
const deadline = setTimeout(() => { console.error('Library row keys test timed out'); process.exit(1); }, 30000);
deadline.unref();

const bundled = await build({
  stdin: {
    contents: `
      export { rowShortcut, runRowShortcut, isTextEntryTarget } from './src/components/views/libraryRowKeys';
      export { resolvePlayerShortcut } from './shared/keyboard-shortcuts';
      export { playerTrackIds, freshPlayerTracks } from './src/components/views/libraryStoreSync';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const { rowShortcut, runRowShortcut, isTextEntryTarget, resolvePlayerShortcut, playerTrackIds, freshPlayerTracks } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

// --- rating and love keys ---------------------------------------------------------

const press = (key, extra = {}, platform = 'win32') => rowShortcut({ key, code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, ...extra }, platform);

for (const rating of [0, 1, 2, 3, 4, 5]) {
  assert.deepEqual(press(String(rating)), { kind: 'rate', rating }, `${rating} rates the row`);
}
assert.deepEqual(rowShortcut({ key: '4', code: 'Numpad4' }, 'win32'), { kind: 'rate', rating: 4 }, 'the numpad rates too');
assert.deepEqual(press('l'), { kind: 'love' });
assert.deepEqual(press('L', { shiftKey: true }), { kind: 'love' }, 'the same keys the app-wide map reads');
assert.equal(press('6'), null, 'there is no sixth star');
assert.equal(press('9'), null);

// Anything else is left to the row's own keys or the app-wide map.
for (const key of ['q', 'Q', 'Enter', ' ', 'ArrowDown', 'ArrowUp', 'z', 'v', 'f']) {
  assert.equal(press(key), null, `${JSON.stringify(key)} is not a rating or love key`);
}
assert.equal(press('4', { ctrlKey: true }), null, 'Ctrl+4 is a chord');
assert.equal(press('l', { ctrlKey: true }), null);
assert.equal(press('4', { altKey: true }), null);
assert.equal(press('4', { metaKey: true }, 'darwin'), null, 'Cmd+4 on a Mac is a chord');
assert.equal(press('l', { metaKey: true }, 'darwin'), null);
assert.equal(press('4', { metaKey: true }, 'win32'), null, 'the Windows key is never ours');
assert.equal(press('4', { repeat: true }), null, 'holding a key rates once');
assert.equal(press('l', { repeat: true }), null, 'and loves once');
assert.deepEqual(press('4', {}, 'darwin'), { kind: 'rate', rating: 4 });

// With NumLock off the numpad keeps its Numpad0-5 codes but sends navigation keys.
// They are not ratings, in a row or in the app-wide map, and the row's own arrow
// keys keep working.
for (const [key, code] of [
  ['ArrowDown', 'Numpad2'], ['ArrowLeft', 'Numpad4'], ['ArrowRight', 'Numpad6'], ['ArrowUp', 'Numpad8'],
  ['End', 'Numpad1'], ['PageDown', 'Numpad3'], ['Clear', 'Numpad5'], ['Insert', 'Numpad0'],
]) {
  assert.equal(rowShortcut({ key, code }, 'win32'), null, `${key} on ${code} is not a rating (row)`);
  assert.equal(resolvePlayerShortcut({ key, code, platform: 'win32' })?.startsWith('rate-') ?? false, false, `${key} on ${code} is not a rating (app-wide)`);
}
for (const digit of [0, 1, 2, 3, 4, 5]) {
  assert.deepEqual(rowShortcut({ key: String(digit), code: `Numpad${digit}` }, 'win32'), { kind: 'rate', rating: digit }, `the numpad ${digit} rates with NumLock on`);
  assert.equal(resolvePlayerShortcut({ key: String(digit), code: `Numpad${digit}`, platform: 'win32' }), `rate-${digit}`);
}

// --- running the shortcut on a row ------------------------------------------------------

// A stand-in for the DOM element isTextEntryTarget looks at: `closest` answers by
// the selector the helper asks with.
globalThis.Element = class FakeElement {
  constructor({ input, textEntry } = {}) { this.input = input; this.textEntry = textEntry; }
  closest(selector) {
    if (selector === 'input') return this.input ?? null;
    return this.textEntry ? this : null;
  }
};
const button = new Element();
const searchBox = new Element({ input: { type: 'search' } });
const slider = new Element({ input: { type: 'range' } });
const checkbox = new Element({ input: { type: 'checkbox' } });
const notes = new Element({ textEntry: true });

assert.equal(isTextEntryTarget(null), false);
assert.equal(isTextEntryTarget({}), false, 'a non-element target is not a text field');
assert.equal(isTextEntryTarget(button), false);
assert.equal(isTextEntryTarget(searchBox), true);
assert.equal(isTextEntryTarget(notes), true);
assert.equal(isTextEntryTarget(slider), false, 'a slider takes no typed characters');
assert.equal(isTextEntryTarget(checkbox), false);

function runOn(target, event, platform = 'win32') {
  const log = [];
  const e = {
    key: '', code: '', target,
    preventDefault: () => log.push('preventDefault'),
    stopPropagation: () => log.push('stopPropagation'),
    ...event,
  };
  const handled = runRowShortcut(e, platform, {
    onToggleLove: () => log.push('love'),
    onSetRating: (rating) => log.push(`rate ${rating}`),
  });
  return { handled, log };
}

assert.deepEqual(runOn(button, { key: '4', code: 'Digit4' }), { handled: true, log: ['preventDefault', 'stopPropagation', 'rate 4'] }, 'a control in the row rates it and stops the press there');
assert.deepEqual(runOn(button, { key: 'l', code: 'KeyL' }), { handled: true, log: ['preventDefault', 'stopPropagation', 'love'] });
assert.deepEqual(runOn(slider, { key: '0', code: 'Digit0' }), { handled: true, log: ['preventDefault', 'stopPropagation', 'rate 0'] }, 'a slider in the row is a control, not a text field');
for (const target of [searchBox, notes]) {
  assert.deepEqual(runOn(target, { key: '4', code: 'Digit4' }), { handled: false, log: [] }, 'a text field keeps its digits');
  assert.deepEqual(runOn(target, { key: 'l', code: 'KeyL' }), { handled: false, log: [] }, 'and its letters');
}
assert.deepEqual(runOn(button, { key: 'q', code: 'KeyQ' }), { handled: false, log: [] }, 'other keys are left to the row and the app');
assert.deepEqual(runOn(button, { key: 'ArrowDown', code: 'Numpad2' }), { handled: false, log: [] }, 'a numpad arrow moves between rows, it does not rate');
assert.deepEqual(runOn(button, { key: '4', code: 'Digit4', ctrlKey: true }), { handled: false, log: [] });
assert.deepEqual(runOn(button, { key: '4', code: 'Digit4', repeat: true }), { handled: false, log: [] });
assert.equal(runOn(button, { key: '4', code: 'Digit4', metaKey: true }, 'darwin').handled, false, 'Cmd+4 on a Mac is a chord');
assert.equal(runOn(button, { key: '4', code: 'Digit4' }, 'darwin').handled, true);

delete globalThis.Element;

// --- what the player holds ----------------------------------------------------------

const track = (id) => ({ id, title: `T${id}`, artist: 'A', album: 'B' });
assert.deepEqual(playerTrackIds({ current: track(3), queue: [track(1), track(3), track(2), track(1)] }), [3, 1, 2], 'each track once, the one on deck first');
assert.deepEqual(playerTrackIds({ current: null, queue: [track(4)] }), [4]);
assert.deepEqual(playerTrackIds({ current: null, queue: [] }), []);
assert.deepEqual(playerTrackIds({ current: track(-1), queue: [track(0), track(5)] }), [5], 'previews and other unsaved ids are not looked up');

{
  const asked = [];
  const rows = await freshPlayerTracks({ current: track(3), queue: [track(1), track(3)] }, async (ids) => { asked.push(ids); return ids.map((id) => ({ ...track(id), title: `New ${id}` })); });
  assert.deepEqual(asked, [[3, 1]], 'one lookup for everything the player holds');
  assert.deepEqual(rows.map((row) => row.title), ['New 3', 'New 1']);

  const idle = [];
  assert.deepEqual(await freshPlayerTracks({ current: null, queue: [] }, async (ids) => { idle.push(ids); return []; }), []);
  assert.deepEqual(idle, [], 'nothing is asked when the player holds nothing');

  assert.deepEqual(
    await freshPlayerTracks({ current: track(3), queue: [] }, async () => { throw new Error('ipc down'); }),
    [],
    'a failed lookup leaves the old tags, it does not fail the reset',
  );
}

// --- wiring in LibraryView ----------------------------------------------------------

const source = readFileSync(new URL('../src/components/views/LibraryView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// The text of a function declared at two-space indent, up to its closing brace.
function bodyOf(name) {
  const start = source.search(new RegExp(`^  (async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `LibraryView declares ${name}`);
  const end = source.indexOf('\n  }\n', start);
  assert.ok(end > start, `${name} closes`);
  return source.slice(start, end);
}

assert.match(bodyOf('applyMetadataCandidate'), /usePlayerStore\.getState\(\)\.refreshTracks\(\[updated\]\)/, 'a MusicBrainz match reaches the queue and the transport');
assert.match(bodyOf('applyManualMetadataEdit'), /usePlayerStore\.getState\(\)\.refreshTracks\(\[updated\]\)/, 'a manual edit does too');
{
  const reset = bodyOf('resetAdoptedEdits');
  assert.match(reset, /freshPlayerTracks\(/, 'a reset re-reads what the player holds');
  assert.match(reset, /refreshTracks\(/);
}
{
  const bulk = source.match(/const saveBulkResults = \(rows: Track\[\]\): void => \{\n([\s\S]*?)\n  \};/);
  assert.ok(bulk, 'TrackTable routes bulk results through one function');
  assert.match(bulk[1], /usePlayerStore\.getState\(\)\.refreshTracks\(rows\)/);
  assert.match(bulk[1], /onBulkMetadataSaved\?\.\(rows\)/);
  assert.equal([...source.matchAll(/onBulkMetadataSaved\?\.\(/g)].length, 1, 'no bulk path skips the player');
  assert.equal([...source.matchAll(/saveBulkResults\(/g)].length, 4, 'bulk edit, auto-number and both ReplayGain runs all go through it');
}

// --- row controls ---------------------------------------------------------------------

assert.match(source, /aria-label=\{`Play \$\{t\.title\}`\}/, 'the row play button has a name');
assert.equal([...source.matchAll(/className="pxbtn pxbtn-xs"/g)].length, 2, 'Mix and Tag use the dense button');
assert.doesNotMatch(source, /pxbtn px-1\.5 py-\[1px\] text-\[9px\]/, 'no row button sizes itself by hand');
assert.match(
  source,
  /runRowShortcut\(e, api\.platform, \{\n\s+onToggleLove: \(\) => onToggleLove\(t\.id\),\n\s+onSetRating: \(rating\) => onSetRating\(t\.id, rating\),\n\s+\}\);\n\s+if \(handled\) return;/,
  'the row reads its own rating and love keys and acts on its own track',
);
assert.doesNotMatch(source, /function isTextEntryTarget/, 'one text-field check, the one the row tests run');

const search = source.match(/<label className="library-search-command" data-newamp-library-search-command>([\s\S]*?)<\/label>/);
assert.ok(search, 'the search box keeps its marker for the quick-play chord');
assert.match(search[1], /<input\b[\s\S]*?placeholder="([^"]+)"/);
const placeholder = search[1].match(/placeholder="([^"]+)"/)[1];
assert.ok(placeholder.length <= 48, `the placeholder is short (${placeholder.length} chars)`);
assert.ok(placeholder.includes('artist:radiohead'), 'and still shows a power-search example');
assert.doesNotMatch(search[1], /autoFocus/, 'the box is not focused on arrival');
assert.match(search[1], /<kbd title=\{`Press \/ or \$\{searchChord\} to jump to the search box`\}>\{searchChord\}<\/kbd>/, 'the hint names the platform chord');
assert.match(source, /const searchChord = shortcutLabel\('Mod\+F'\);/);

// The example query is a hint. decks-compact.css fades placeholders to 42% of the
// readout colour; this rule loads after it, has the same specificity and wins.
{
  const css = readFileSync(new URL('../src/styles/views/library.css', import.meta.url), 'utf8');
  const rule = css.match(/\.library-search-command input::placeholder \{([^}]*)\}/);
  assert.ok(rule, 'library.css styles the search placeholder');
  assert.match(rule[1], /color:\s*var\(--display-dim\)/, 'the placeholder uses the dimmed readout colour');
  assert.match(rule[1], /opacity:\s*1\b/, 'at full opacity');
  const index = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');
  assert.ok(
    index.indexOf("./views/library.css") > index.indexOf("./decks-compact.css"),
    'library.css loads after decks-compact.css, so its placeholder colour wins the tie',
  );
}

console.log('library-row-keys-test ok');
