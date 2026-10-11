// What a key press means in the projector: the transport chords follow the main
// window's rules, and a chord those rules turn down does nothing instead of
// falling through to the plain arrows.
// Run: node scripts/projector-keys-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp/projector-keys-test');
mkdirSync(root, { recursive: true });
const outfile = resolve(root, 'keys.mjs');
await build({
  stdin: { contents: `export { projectorKeyAction } from './src/detached/projector-keys';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent',
});
const { projectorKeyAction } = await import(pathToFileURL(outfile).href);

const keyOf = (code) => (code === 'Space' ? ' ' : code);
const press = (code, over = {}, platform) => projectorKeyAction({ key: keyOf(code), code, ...over }, platform);

// Plain keys.
assert.equal(press('F11'), 'toggle-fullscreen');
assert.equal(press('Escape'), 'exit-fullscreen');
assert.equal(press('Space'), 'toggle-play');
assert.equal(press('Space', { repeat: true }), null, 'a held Space toggles once');
assert.equal(press('ArrowRight'), 'seek-forward');
assert.equal(press('ArrowLeft'), 'seek-backward');
assert.equal(press('ArrowRight', { repeat: true }), 'seek-forward', 'a held arrow keeps seeking');
assert.equal(press('ArrowRight', { shiftKey: true }), 'seek-forward');
assert.equal(press('ArrowUp'), 'volume-up');
assert.equal(press('ArrowDown', { repeat: true }), 'volume-down');
assert.equal(projectorKeyAction({ key: 'z', code: 'KeyZ' }), null, 'the letter shortcuts stay with the main window');
assert.equal(projectorKeyAction({ key: '3', code: 'Digit3' }), null);

// Ctrl chords off a Mac.
assert.equal(press('ArrowRight', { ctrlKey: true }, 'win32'), 'next');
assert.equal(press('ArrowLeft', { ctrlKey: true }, 'win32'), 'previous');
assert.equal(press('ArrowRight', { ctrlKey: true, repeat: true }, 'win32'), null, 'a held Ctrl+Right is not a seek');
assert.equal(press('ArrowLeft', { ctrlKey: true, repeat: true }, 'win32'), null);
assert.equal(press('ArrowUp', { ctrlKey: true }, 'win32'), null, 'Ctrl+Up is not volume off a Mac');
assert.equal(press('ArrowDown', { ctrlKey: true }, 'win32'), null);
assert.equal(press('Space', { ctrlKey: true }, 'win32'), null);

// The Windows key belongs to the OS.
for (const code of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
  assert.equal(press(code, { metaKey: true }, 'win32'), null, `Win+${code}`);
  assert.equal(press(code, { metaKey: true, repeat: true }, 'win32'), null, `held Win+${code}`);
  assert.equal(press(code, { metaKey: true }, undefined), null, `Win+${code} with no platform`);
}

// Cmd is the transport modifier on a Mac.
assert.equal(press('ArrowRight', { metaKey: true }, 'darwin'), 'next');
assert.equal(press('ArrowLeft', { metaKey: true }, 'darwin'), 'previous');
assert.equal(press('ArrowRight', { metaKey: true, repeat: true }, 'darwin'), null, 'a held Cmd+Right is not a seek');
assert.equal(press('ArrowLeft', { metaKey: true, repeat: true }, 'darwin'), null);
assert.equal(press('ArrowUp', { metaKey: true }, 'darwin'), 'volume-up');
assert.equal(press('ArrowDown', { metaKey: true }, 'darwin'), 'volume-down');
assert.equal(press('ArrowUp', { metaKey: true, repeat: true }, 'darwin'), 'volume-up', 'a held Cmd+Up keeps stepping');
assert.equal(press('ArrowRight', { ctrlKey: true }, 'darwin'), 'next', 'Ctrl+Right keeps working on a Mac');
assert.equal(press('ArrowUp', { ctrlKey: true }, 'darwin'), null, 'Ctrl+Up is Mission Control there');

// Alt belongs to the browser and the OS.
assert.equal(press('ArrowLeft', { altKey: true }), null);
assert.equal(press('ArrowRight', { altKey: true, ctrlKey: true }, 'win32'), null);

// The handler asks for exactly this and nothing else.
const detached = readFileSync(resolve('src/detached/main.tsx'), 'utf8');
assert.match(detached, /projectorKeyAction\(event, hostPlatform\)/);
assert.doesNotMatch(detached, /resolvePlayerShortcut/, 'the chord rules live in projector-keys.ts only');
assert.doesNotMatch(detached, /event\.key === 'Arrow/, 'no key is read in the handler itself');

console.log(JSON.stringify({ ok: true }, null, 2));
