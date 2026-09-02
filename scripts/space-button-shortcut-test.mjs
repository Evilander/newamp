// Space has two jobs that used to collide: the global "toggle play" shortcut,
// and the browser/role="button" convention that Space activates a focused
// button. Track-list rows across HomeView/NowPlayingView/MixesView are
// role="button" and handle Space themselves (starting that row's track), but
// nothing stopped the same keydown from ALSO bubbling to the window-level
// shortcut listener and toggling playback of whatever the row just started —
// press Space on a focused row, hear it start then immediately pause.
// Run with: npm run test:space-button-shortcut

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolvePlayerShortcut } from '../dist-electron/shared/keyboard-shortcuts.js';

const base = { key: '', code: '', targetEditable: false, fullscreenVisualizer: false };

// The core fix: Space resolves to null (defer to the button's own handler)
// when focus is on a button-role element.
assert.equal(
  resolvePlayerShortcut({ ...base, code: 'Space', key: ' ', targetIsButton: true }),
  null,
  'Space should not resolve to a global command while a button/role="button" element has focus',
);

// Unaffected: Space still works everywhere else (the default/common case —
// focus on the track list itself, an unfocused body, etc).
assert.equal(
  resolvePlayerShortcut({ ...base, code: 'Space', key: ' ', targetIsButton: false }),
  'toggle-play',
  'Space should still toggle playback when focus is not on a button',
);
assert.equal(
  resolvePlayerShortcut({ ...base, code: 'Space', key: ' ' }),
  'toggle-play',
  'omitting targetIsButton should behave exactly like false (backward compatible default)',
);

// Every other shortcut must keep working while a button has focus — this
// fix is specifically about Space's dual meaning, not a blanket "shortcuts
// don't fire near buttons" rule (that would make keyboard library browsing
// unusable, since track rows are role="button" throughout the app).
assert.equal(
  resolvePlayerShortcut({ ...base, key: 'b', code: 'KeyB', targetIsButton: true }),
  'next',
  'non-Space shortcuts should still resolve normally while a button has focus',
);
assert.equal(
  resolvePlayerShortcut({ ...base, code: 'ArrowRight', targetIsButton: true }),
  'seek-forward',
  'arrow-key shortcuts should still resolve normally while a button has focus',
);

// --- Source assertions: the App.tsx wiring that feeds targetIsButton in,
// and every role="button" track row's own Space handler, must be present.
const [appSource, homeSource, nowPlayingSource, mixesSource, packageSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/HomeView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/MixesView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(appSource, /function isButtonShortcutTarget/, 'App.tsx should detect button/role="button" shortcut targets');
assert.match(appSource, /targetIsButton: isButtonShortcutTarget\(e\.target\)/, 'the global keydown handler should feed the button-target check into resolvePlayerShortcut');

for (const [name, source] of [['HomeView', homeSource], ['NowPlayingView', nowPlayingSource], ['MixesView', mixesSource]]) {
  const roleButtonCount = (source.match(/role="button"/g) ?? []).length;
  assert.ok(roleButtonCount > 0, `${name} should still use role="button" rows (sanity check that the fixture assumption holds)`);
}

assert.match(packageSource, /"test:space-button-shortcut"/, 'package.json should expose the space/button shortcut test');

console.log(JSON.stringify({ ok: true }, null, 2));
