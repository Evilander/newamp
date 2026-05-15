import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolvePlayerShortcut } from '../dist-electron/shared/keyboard-shortcuts.js';

const base = { key: '', code: '', targetEditable: false, fullscreenVisualizer: false };

assert.equal(resolvePlayerShortcut({ ...base, code: 'Space', key: ' ' }), 'toggle-play');
assert.equal(resolvePlayerShortcut({ ...base, key: 'z', code: 'KeyZ' }), 'previous');
assert.equal(resolvePlayerShortcut({ ...base, key: 'x', code: 'KeyX' }), 'play');
assert.equal(resolvePlayerShortcut({ ...base, key: 'c', code: 'KeyC' }), 'pause');
assert.equal(resolvePlayerShortcut({ ...base, key: 'v', code: 'KeyV' }), 'stop');
assert.equal(resolvePlayerShortcut({ ...base, key: 'b', code: 'KeyB' }), 'next');
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowLeft' }), 'seek-backward');
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowRight' }), 'seek-forward');
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowUp' }), 'volume-up');
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowDown' }), 'volume-down');
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowLeft', ctrlKey: true }), 'previous');
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowRight', ctrlKey: true }), 'next');
assert.equal(resolvePlayerShortcut({ ...base, key: 'l', code: 'KeyL' }), 'toggle-love');
assert.equal(resolvePlayerShortcut({ ...base, key: '5', code: 'Digit5' }), 'rate-5');
assert.equal(resolvePlayerShortcut({ ...base, key: '0', code: 'Numpad0' }), 'rate-0');
assert.equal(resolvePlayerShortcut({ ...base, key: 'f', code: 'KeyF' }), 'toggle-fullscreen-visualizer');
assert.equal(resolvePlayerShortcut({ ...base, key: 'Escape', code: 'Escape', fullscreenVisualizer: true }), 'exit-fullscreen-visualizer');
assert.equal(resolvePlayerShortcut({ ...base, key: 'Escape', code: 'Escape', fullscreenVisualizer: false }), null);
assert.equal(resolvePlayerShortcut({ ...base, key: 'z', code: 'KeyZ', repeat: true }), null, 'track-skip keys should ignore keyboard repeat');
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowRight', repeat: true }), 'seek-forward', 'seek keys may repeat');
assert.equal(resolvePlayerShortcut({ ...base, key: 'z', code: 'KeyZ', targetEditable: true }), null, 'typing in fields should not trigger player controls');
assert.equal(resolvePlayerShortcut({ ...base, key: 'z', code: 'KeyZ', altKey: true }), null, 'modified app/menu shortcuts should be left alone');

const [appSource, storeSource, packageSource, gateSource, readmeSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('./release-gate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
]);

assert.match(appSource, /resolvePlayerShortcut/, 'App should use the shared shortcut resolver');
assert.match(appSource, /runPlayerShortcut/, 'App should execute resolved player shortcuts');
assert.match(appSource, /isEditableShortcutTarget/, 'App should protect inputs and editable fields');
assert.match(storeSource, /current: state\.current\?\.id === id \? \{ \.\.\.state\.current, loved: nextLoved \}/, 'love shortcut should update current track state');
assert.match(packageSource, /"smoke:keyboard"/, 'package scripts should expose keyboard shortcut smoke');
assert.match(gateSource, /smoke:keyboard/, 'release gate should include keyboard shortcut smoke');
assert.match(readmeSource, /Winamp-style keyboard controls/, 'README should advertise power-user keyboard controls');

console.log(JSON.stringify({ ok: true }, null, 2));
