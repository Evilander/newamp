// Next look and Previous look in the fullscreen visualizer: the Director's on
// the Eviland modes, the neighbouring mode everywhere else. The menu items and
// the bracket keys that reach this are pinned as source.
// Run: node scripts/look-step-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp/look-step-test');
mkdirSync(root, { recursive: true });
const outfile = resolve(root, 'look-step.mjs');
await build({
  stdin: { contents: `export * from './src/components/look-step';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent',
});
const { stepLook, isEvilandPreset } = await import(pathToFileURL(outfile).href);

const handlers = () => {
  const calls = [];
  return {
    calls,
    cyclePreset: (direction) => calls.push(`cycle ${direction}`),
    skipEvilandLook: () => calls.push('skip'),
    previousEvilandLook: () => calls.push('previous'),
  };
};

for (const preset of ['eviland', 'eviland-live']) {
  assert.ok(isEvilandPreset(preset));
  const h = handlers();
  stepLook(preset, 1, h);
  stepLook(preset, -1, h);
  assert.deepEqual(h.calls, ['skip', 'previous'], `${preset}: the Director is asked, the mode stays`);
}

for (const preset of ['neon-waves', 'milkdrop', 'eviland-lite', '']) {
  assert.ok(!isEvilandPreset(preset), preset);
  const h = handlers();
  stepLook(preset, 1, h);
  stepLook(preset, -1, h);
  assert.deepEqual(h.calls, ['cycle 1', 'cycle -1'], `${preset}: the neighbouring mode`);
}

const fullscreen = readFileSync(resolve('src/components/FullscreenVisualizer.tsx'), 'utf8');
assert.match(fullscreen, /id: 'next', label: 'Next look', hint: '\]', onSelect: \(\) => stepLook\(1\)/, 'the menu item goes through stepLook');
assert.match(fullscreen, /label: 'Previous look',\s*hint: '\[',\s*disabled: lookState\.eviland && !evilandDirector,\s*onSelect: \(\) => stepLook\(-1\)/, 'and so does Previous, which needs the Director for its history');
assert.match(fullscreen, /case 'preset-next': if \(event\.key === '\]'\) stepLook\(1\); else cyclePreset\(1\); break;/, 'the bracket keys are the menu\'s shortcut');
assert.match(fullscreen, /case 'preset-previous': if \(event\.key === '\['\) stepLook\(-1\); else cyclePreset\(-1\); break;/);
assert.match(fullscreen, /onClick=\{\(\) => cyclePreset\(-1\)\}/, 'the toolbar arrows still step the modes');

console.log(JSON.stringify({ ok: true }, null, 2));
