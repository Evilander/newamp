// On Windows, registering any global media-key shortcut switches off
// Chromium's own media-key handling, and that handling is what feeds the system
// media session (volume flyout, lock screen, headset buttons). It stays off
// even when the registration fails because another app holds the key. So the
// main process must not register them there, and the keys have to arrive
// through the handlers the page registers on navigator.mediaSession.
// Run: node scripts/media-keys-smtc-test.mjs [path to main.ts]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const mainPath = process.argv[2] ? resolve(process.argv[2]) : new URL('../electron/main.ts', import.meta.url);
const [main, session, app] = await Promise.all([
  readFile(mainPath, 'utf8'),
  readFile(new URL('../src/lib/mediaSession.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
]);
const text = (source) => source.replace(/\r\n/g, '\n');

const fn = text(main).match(/function registerMediaShortcuts\(\): void \{[\s\S]*?\n\}\n/)?.[0] ?? '';
assert.ok(fn, 'registerMediaShortcuts exists');
const register = fn.indexOf('globalShortcut.register');
assert.ok(register > 0, 'it still registers the media keys for the platforms that need it');

const winGuard = fn.match(/if \(process\.platform === 'win32'[^\n]*\) return;/);
assert.ok(winGuard, "Windows must return before registering: a registered media key kills the system media session");
assert.ok(winGuard.index < register, 'the Windows guard comes before the first registration');
assert.match(fn, /if \(smokeMode\) return;/, 'smoke runs still skip it');
assert.match(
  fn.slice(0, register),
  /bitPerfectExclusive/,
  'Bit-Perfect Exclusive plays outside Chromium, has no media session to feed, and keeps the global keys',
);

// The keys then reach the page as media session actions.
const stripped = text(session);
for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'stop']) {
  assert.match(stripped, new RegExp(`setMediaSessionAction\\(session, '${action}', actions\\.`), `the page handles the ${action} key`);
}
const sync = text(app).match(/function MediaSessionSync\(\): null \{[\s\S]*?\n\}\n/)?.[0] ?? '';
assert.match(sync, /pause: \(\) => usePlayerStore\.getState\(\)\.engine\.pause\(\)/, 'a pause key pauses');
assert.match(sync, /if \(!store\.isPlaying\) store\.togglePlay\(\)/, 'a play key starts playback and never pauses it');
assert.match(sync, /next: \(\) => void usePlayerStore\.getState\(\)\.next\(\)/, 'a next key skips ahead');

console.log('PASS media keys: Windows leaves them to the media session, the page handles play, pause, previous, next and stop');
