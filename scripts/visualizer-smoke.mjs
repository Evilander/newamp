import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.window = globalThis.window ?? globalThis;

const [butterchurnModule, presetsModule] = await Promise.all([
  import('butterchurn'),
  import('butterchurn-presets'),
]);

const butterchurn = unwrapDefault(butterchurnModule);
const presetApi = unwrapDefault(presetsModule);

assert.equal(typeof butterchurn.createVisualizer, 'function', 'butterchurn.createVisualizer is missing');
assert.equal(typeof presetApi.getPresets, 'function', 'butterchurn-presets.getPresets is missing');

const presets = presetApi.getPresets();
const presetCount = Object.keys(presets).length;
assert.ok(presetCount >= 100, `expected at least 100 Milkdrop presets, got ${presetCount}`);

const visualizerSource = await readFile(new URL('../src/components/Visualizer.tsx', import.meta.url), 'utf8');
assert.match(visualizerSource, /mode === 'butterchurn'/, 'Visualizer must implement Butterchurn mode');
assert.match(
  visualizerSource,
  /connectAudio\(engine\.masterGain\)/,
  'Butterchurn must connect to the real Newamp audio graph',
);

const fullscreenSource = await readFile(
  new URL('../src/components/FullscreenVisualizer.tsx', import.meta.url),
  'utf8',
);
assert.match(fullscreenSource, /id: 'butterchurn'/, 'Fullscreen visualizer must expose a Butterchurn preset');

console.log(
  JSON.stringify(
    {
      butterchurn: true,
      presetCount,
      fullscreenMode: true,
    },
    null,
    2,
  ),
);

function unwrapDefault(module) {
  const first = module.default ?? module;
  return first.default ?? first;
}
