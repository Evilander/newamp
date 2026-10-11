// The volume keys share the wheel's stop at 100%: going up from below lands on
// exactly 100%, plain presses (and key repeat) stay there until the keys have
// been quiet for a moment, and Shift goes straight on into the boost range.
// Run: node scripts/volume-shortcut-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `export * from './src/lib/volume-shortcut'; export { DETENT_MS } from './src/lib/wheel-volume';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const { VolumeKeyInput, volumeKeyInput, DETENT_MS } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);

// Ordinary steps are 5% either way, clamped to 0..2.
near(new VolumeKeyInput().next('up', 0.5, 1000), 0.55, 'up from the middle');
near(new VolumeKeyInput().next('down', 0.5, 1000), 0.45, 'down from the middle');
near(new VolumeKeyInput().next('down', 0.02, 1000), 0, 'down stops at silence');
near(new VolumeKeyInput().next('up', 1.98, 1000, { shift: true }), 2, 'up stops at the top of the range');

// Going up from just below 100% lands on exactly 100%, not past it.
{
  const keys = new VolumeKeyInput();
  assert.equal(keys.next('up', 0.97, 1000), 1, 'a step that would cross 100% stops on it');
  assert.equal(keys.next('up', 0.95, 5000), 1, 'an exact landing is 100% too');
}

// At 100% plain presses and key repeat are absorbed while they keep coming.
{
  const keys = new VolumeKeyInput();
  assert.equal(keys.next('up', 0.97, 1000), 1);
  assert.equal(keys.next('up', 1, 1100), 1, 'a second press right after stays at 100%');
  assert.equal(keys.next('up', 1, 1400), 1, 'held keys keep it there');
  assert.equal(keys.next('up', 1, 1400 + DETENT_MS - 1), 1, 'each absorbed press extends the hold');
  near(keys.next('up', 1, 1400 + DETENT_MS - 1 + DETENT_MS + 1), 1.05, 'after a quiet pause the next press goes past');
}

// A held key: the first repeat arrives after the system's repeat delay, which
// is 500 ms by default on Windows and up to a second, so it can come well after
// the hold from the press itself has run out. Repeats stay at 100% anyway.
{
  const keys = new VolumeKeyInput();
  assert.equal(keys.next('up', 0.97, 1000), 1, 'the press lands on 100%');
  assert.equal(keys.next('up', 1, 1500, { repeat: true }), 1, 'the first repeat, 500 ms later, is absorbed');
  for (let at = 1533; at < 2500; at += 33) assert.equal(keys.next('up', 1, at, { repeat: true }), 1, `repeat at ${at}`);
  assert.equal(keys.next('up', 1, 2500 + 600, { repeat: true }), 1, 'a slow repeat rate stays inside the hold');
  near(keys.next('up', 1, 3100 + DETENT_MS + 1), 1.05, 'a fresh press after the keys went quiet moves on');
}
{
  // The slowest repeat delay Windows offers is about a second.
  const keys = new VolumeKeyInput();
  assert.equal(keys.next('up', 0.99, 1000), 1);
  assert.equal(keys.next('up', 1, 2000, { repeat: true }), 1, 'a 1 s repeat delay is still the same hold');
}
{
  // A repeat that arrives long after anything was absorbed is not part of a hold.
  const keys = new VolumeKeyInput();
  assert.equal(keys.next('up', 0.97, 1000), 1);
  near(keys.next('up', 1, 1000 + 5000, { repeat: true }), 1.05, 'a repeat after a long silence moves on');
  // A fresh press (not a repeat) outside the 400 ms hold moves on too, however soon the first press was.
  const again = new VolumeKeyInput();
  assert.equal(again.next('up', 0.97, 1000), 1);
  near(again.next('up', 1, 1000 + DETENT_MS + 50), 1.05, 'a fresh press outside the hold moves on');
}
{
  // A repeat that lands on 100% from below holds the following repeats.
  const keys = new VolumeKeyInput();
  assert.equal(keys.next('up', 0.97, 1000, { repeat: true }), 1);
  assert.equal(keys.next('up', 1, 1033, { repeat: true }), 1);
  assert.equal(keys.next('up', 1, 1066, { repeat: true }), 1);
}
{
  // Shift passes even a held key, and repeat does not hold it back.
  const keys = new VolumeKeyInput();
  assert.equal(keys.next('up', 0.97, 1000), 1);
  near(keys.next('up', 1, 1500, { shift: true, repeat: true }), 1.05, 'Shift passes a held stop');
}

// Shift goes straight through, from below and from 100%.
{
  const keys = new VolumeKeyInput();
  near(keys.next('up', 0.97, 1000, { shift: true }), 1.02, 'Shift from below does not stop at 100%');
  assert.equal(keys.next('up', 0.95, 1100), 1, 'a plain press after Shift still stops there');
  near(keys.next('up', 1, 1150, { shift: true }), 1.05, 'Shift passes while the stop is holding');
}

// Down is never held, and leaves the stop alone for the way back up.
{
  const keys = new VolumeKeyInput();
  assert.equal(keys.next('up', 0.97, 1000), 1);
  near(keys.next('down', 1, 1050), 0.95, 'down from 100% moves');
  near(keys.next('down', 1.4, 1100), 1.35, 'down from the boost range moves');
}

// Already in the boost range with no stop in force (loaded from settings, or
// the wheel moved it there): plain presses keep raising it.
near(new VolumeKeyInput().next('up', 1.4, 1000), 1.45, 'plain up above 100%');
near(new VolumeKeyInput().next('up', 1, 1000), 1.05, 'plain up from 100% with no recent stop');

// The shortcut path in App uses the shared instance and the key's own
// timestamp, Shift state and repeat flag.
{
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /from '\.\/lib\/volume-shortcut'/, 'App imports the volume key helper');
  assert.match(app, /volumeKeyInput\.next\('up', store\.volume, key\.at, \{ shift: key\.shiftKey, repeat: key\.repeat \}\)/, 'volume-up goes through the helper');
  assert.match(app, /volumeKeyInput\.next\('down', store\.volume, key\.at, \{ shift: key\.shiftKey, repeat: key\.repeat \}\)/, 'volume-down goes through the helper');
  assert.match(app, /runPlayerShortcut\(command, store, \{ shiftKey: e\.shiftKey, repeat: e\.repeat, at: e\.timeStamp \}\)/, 'the key event supplies Shift, repeat and its timestamp');
  assert.ok(volumeKeyInput instanceof VolumeKeyInput);
}

console.log('[volume-shortcut-test] PASS');
