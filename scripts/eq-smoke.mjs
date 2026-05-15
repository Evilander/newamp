import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const presets = await import('../dist-electron/shared/eq-presets.js');

assert.equal(presets.EQ_BAND_COUNT, 10, 'EQ should keep the established 10-band shape');
assert.equal(presets.EQ_PRESETS.length >= 10, true, 'EQ should expose a broad preset set');

const rock = presets.EQ_PRESETS.find((preset) => preset.name === 'Rock');
assert.ok(rock, 'Rock preset should exist');
assert.deepEqual(rock.values, [4, 3, -1, -2, -1, 1, 3, 4, 5, 5]);

const flat = presets.EQ_PRESETS.find((preset) => preset.name === 'Flat');
assert.ok(flat, 'Flat preset should exist');
assert.equal(presets.findEqPresetName(flat.values), 'Flat');
assert.equal(presets.findEqPresetName(rock.values), 'Rock');
assert.equal(presets.findEqPresetName([4, 3, -1, -2, -1, 1, 3, 4, 5, 4]), 'Custom');
assert.deepEqual(
  presets.normalizeEqValues([99, -99, 1.4, Number.NaN, undefined, '3.6', 0, 0, 0, 0, 8, 9]),
  [12, -12, 1, 0, 0, 4, 0, 0, 0, 0],
);
assert.deepEqual(presets.normalizeEqValues([1, 2, 3]), flat.values);

const [settingsSource, storeSource, panelSource, stylesSource, packageSource, gateSource] = await Promise.all([
  readFile(new URL('../electron/settings.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/EqPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/index.css', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
]);

assert.match(settingsSource, /normalizeEqValues/, 'SettingsStore should use the shared EQ normalizer');
assert.match(storeSource, /setEqPreset/, 'player store should expose an atomic EQ preset action');
assert.match(storeSource, /engine\.setEqBands/, 'player store should apply presets to the engine in one path');
assert.match(panelSource, /EQ_PRESETS/, 'EQ panel should render shared presets');
assert.match(panelSource, /findEqPresetName/, 'EQ panel should derive active preset from current settings');
assert.doesNotMatch(panelSource, /useState/, 'EQ panel should not keep stale local preset state');
assert.match(panelSource, /eq-slider-frame/, 'EQ panel should use a stable CSS frame for vertical sliders');
assert.doesNotMatch(panelSource, /orient:\s*['"]vertical['"]/, 'EQ panel should not rely on the legacy orient attribute');
assert.doesNotMatch(panelSource, /slider-vertical/, 'EQ panel should not rely on WebKit-only vertical slider appearance');
assert.match(stylesSource, /\.eq-slider-frame/, 'styles should define the vertical EQ slider frame');
assert.match(stylesSource, /transform:\s*rotate\(-90deg\)/, 'vertical EQ sliders should be CSS-rotated standard range inputs');
assert.match(packageSource, /"smoke:eq"/, 'package.json should expose the EQ smoke');
assert.match(gateSource, /smoke:eq/, 'release gate should include the EQ smoke');

console.log(JSON.stringify({
  ok: true,
  presets: presets.EQ_PRESETS.map((preset) => preset.name),
  customName: presets.findEqPresetName([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
}, null, 2));
