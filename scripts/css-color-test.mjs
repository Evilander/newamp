import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const outfile = resolve('tmp/css-color-test-bundle.mjs');
await build({
  entryPoints: [resolve('src/visualizer/css-color.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile,
  logLevel: 'silent',
});

const { parseCssRgbVec } = await import(pathToFileURL(outfile).href);
const close = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) < 1e-6);
const cases = [
  ['#39ff14', [57 / 255, 1, 20 / 255]],
  ['#0af', [0, 170 / 255, 1]],
  ['rgb(12, 34, 56)', [12 / 255, 34 / 255, 56 / 255]],
  ['rgb(100% 50% 0% / 25%)', [1, 0.5, 0]],
];

for (const [input, expected] of cases) {
  const actual = parseCssRgbVec(input);
  if (!close(actual, expected)) {
    throw new Error(`${input}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const fallback = parseCssRgbVec('not-a-color', [0.1, 0.2, 0.3]);
if (!close(fallback, [0.1, 0.2, 0.3])) {
  throw new Error(`fallback mismatch: ${JSON.stringify(fallback)}`);
}

console.log('[css-color-test] PASS');
