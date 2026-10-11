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
// In fullscreen visualizer the ←/→ keys cycle visualizer presets — the
// shortcut layer must defer to the viz's own keydown handler instead of
// also nudging seek-back/forward, otherwise every preset change scrubs
// the song five seconds in one direction.
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowLeft', fullscreenVisualizer: true }), null);
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowRight', fullscreenVisualizer: true }), null);
// Ctrl+arrow is the global "previous/next track" shortcut and must keep
// working everywhere, including fullscreen viz.
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowLeft', ctrlKey: true, fullscreenVisualizer: true }), 'previous');
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowRight', ctrlKey: true, fullscreenVisualizer: true }), 'next');
// Up/Down still nudge volume in fullscreen viz.
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowUp', fullscreenVisualizer: true }), 'volume-up');
assert.equal(resolvePlayerShortcut({ ...base, code: 'ArrowDown', fullscreenVisualizer: true }), 'volume-down');
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

// macOS: Cmd is the transport modifier (Ctrl+Left/Right is Mission Control's
// Spaces switcher), with volume on Cmd+Up/Down like Music.app. Every other Cmd
// chord belongs to the menu or the palette.
const mac = { ...base, platform: 'darwin', metaKey: true };
assert.equal(resolvePlayerShortcut({ ...mac, code: 'ArrowLeft' }), 'previous');
assert.equal(resolvePlayerShortcut({ ...mac, code: 'ArrowRight' }), 'next');
assert.equal(resolvePlayerShortcut({ ...mac, code: 'ArrowUp' }), 'volume-up');
assert.equal(resolvePlayerShortcut({ ...mac, code: 'ArrowDown' }), 'volume-down');
assert.equal(resolvePlayerShortcut({ ...base, platform: 'darwin', ctrlKey: true, code: 'ArrowRight' }), 'next', 'Ctrl+Right still works on a Mac');
assert.equal(resolvePlayerShortcut({ ...mac, key: 'k', code: 'KeyK' }), null, 'Cmd+K is the palette, not a player command');
assert.equal(resolvePlayerShortcut({ ...mac, key: 'z', code: 'KeyZ' }), null, 'Cmd+Z must not become previous');
assert.equal(resolvePlayerShortcut({ ...mac, altKey: true, code: 'ArrowRight' }), null, 'Alt chords are left alone');
assert.equal(resolvePlayerShortcut({ ...base, metaKey: true, code: 'ArrowRight' }), null, 'off a Mac, Meta chords are the OS\'s');
assert.equal(resolvePlayerShortcut({ ...base, platform: 'win32', metaKey: true, code: 'ArrowLeft' }), null);

// A focused slider keeps its arrow keys; everything else, Space included,
// still reaches the shortcut map.
assert.equal(resolvePlayerShortcut({ ...base, targetIsSlider: true, code: 'Space', key: ' ' }), 'toggle-play');
assert.equal(resolvePlayerShortcut({ ...base, targetIsSlider: true, code: 'ArrowLeft' }), null);
assert.equal(resolvePlayerShortcut({ ...base, targetIsSlider: true, code: 'ArrowLeft', ctrlKey: true }), 'previous');
assert.equal(resolvePlayerShortcut({ ...base, targetIsSlider: true, key: '3', code: 'Digit3' }), 'rate-3');

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
assert.match(appSource, /platform: api\.platform/, 'App should tell the resolver which platform it is on');
assert.match(appSource, /targetIsSlider: isSliderShortcutTarget/, 'App should leave a focused slider its arrow keys');
assert.match(storeSource, /current: state\.current\?\.id === id \? \{ \.\.\.state\.current, loved: nextLoved \}/, 'love shortcut should update current track state');
assert.match(packageSource, /"smoke:keyboard"/, 'package scripts should expose keyboard shortcut smoke');
assert.match(gateSource, /smoke:keyboard/, 'release gate should include keyboard shortcut smoke');
// Matches "control" and "controls" so an ordinary README rewording does not
// fail the gate; the point is that the feature stays documented at all.
assert.match(readmeSource, /Winamp-style keyboard control/, 'README should advertise power-user keyboard controls');

console.log(JSON.stringify({ ok: true }, null, 2));
