// ensureGraph() built the master gain node with the raw 0-2 slider position
// (masterGain.gain.value = this.volume) instead of volumePositionToGain(...),
// the same perceptual taper setVolume() applies on every later change.
// setVolume() called before the graph exists (e.g. init() applying the
// persisted volume at startup, before any play()) is a no-op on the gain
// node — its `if (!this.graph) return;` guard only updates this.volume — so
// first playback ran at raw-position gain (e.g. 0.75 instead of 0.75^3=0.42,
// noticeably louder) until the user next touched the volume control.
// volumePositionToGain is a pure function, exported for this test, so the
// taper math itself is verified by running it; ensureGraph() actually
// applying it can only be verified against source (it needs a real
// AudioContext to execute).
// Run with: npm run test:boot-volume-taper

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = resolve('tmp', 'boot-volume-taper-test');
await mkdir(outDir, { recursive: true });
const outfile = join(outDir, 'engine.mjs');
await build({
  entryPoints: [resolve('src', 'audio', 'engine.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile,
  logLevel: 'silent',
});
const { volumePositionToGain } = await import(pathToFileURL(outfile).toString());

// Cubic taper below unity, linear boost zone above, unity preserved exactly —
// the documented contract this fix needs ensureGraph() to actually apply.
assert.equal(volumePositionToGain(0), 0);
assert.equal(volumePositionToGain(1), 1, 'unity must be preserved exactly');
assert.equal(volumePositionToGain(0.75), 0.75 ** 3, 'below unity should be a cubic taper');
assert.ok(volumePositionToGain(0.75) < 0.75, 'the taper should sit below raw position anywhere below unity (the whole point of the fix)');
assert.equal(volumePositionToGain(1.5), 1.5, 'the 1.0-2.0 boost zone should stay linear');
assert.equal(volumePositionToGain(2), 2);
assert.equal(volumePositionToGain(-1), 0, 'position should clamp to [0, 2]');
assert.equal(volumePositionToGain(5), 2, 'position should clamp to [0, 2]');

// --- Source assertion: ensureGraph() must build masterGain with the taper
// applied, not the raw slider position.
const engineSource = await readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8');
assert.match(
  engineSource,
  /masterGain\.gain\.value = volumePositionToGain\(this\.volume\);/,
  'ensureGraph() should build masterGain with the perceptual taper applied, matching setVolume()',
);
assert.doesNotMatch(
  engineSource,
  /masterGain\.gain\.value = this\.volume;/,
  'ensureGraph() should no longer set masterGain directly from the raw slider position',
);

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
assert.match(packageSource, /"test:boot-volume-taper"/, 'package.json should expose the boot volume taper test');

console.log(JSON.stringify({ ok: true }, null, 2));
