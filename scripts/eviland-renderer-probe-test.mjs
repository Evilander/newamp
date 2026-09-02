// canvas.getContext('webgl2', ...) permanently binds a canvas element to
// WebGL2 per the Canvas spec — a later getContext('2d') on the SAME element
// returns null forever. createEvilandRenderer used to call getContext on the
// caller's real canvas first and could still return null afterward (missing
// EXT_color_buffer_float, or a shader failing to link), which permanently
// blocked the caller's 2D fallback (paintMilkdropFallback) on that same
// canvas — "return null so it never goes dark" broke the very fallback it
// was supposed to enable. This can only run for real inside a browser
// (WebGL2 context creation), so it's verified against source: the fix must
// probe context creation + the extension check on a throwaway detached
// canvas BEFORE ever calling getContext on the real one.
// Run: node scripts/eviland-renderer-probe-test.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const source = readFileSync(resolve('src/visualizer/eviland.ts'), 'utf8');
const fnMatch = source.match(/export function createEvilandRenderer\([\s\S]*?\n\}/);
if (!fnMatch) fail('could not locate createEvilandRenderer in eviland.ts');
const fn = fnMatch?.[0] ?? '';

const probeIdx = fn.indexOf("document.createElement('canvas').getContext('webgl2'");
const realBindIdx = fn.indexOf("const ctx = canvas.getContext(");
if (probeIdx < 0) {
  fail('createEvilandRenderer should probe WebGL2 support on a throwaway detached canvas, not the real one');
}
if (realBindIdx < 0) {
  fail('createEvilandRenderer should still bind the real canvas once the probe has passed');
} else if (probeIdx >= 0 && probeIdx > realBindIdx) {
  fail('the detached-canvas probe must run BEFORE the real canvas is bound to WebGL2, or it does not prevent the permanent-binding problem');
}

if (!/probe\.getExtension\('EXT_color_buffer_float'\)/.test(fn)) {
  fail('EXT_color_buffer_float should be checked on the probe context, before the real canvas is ever touched');
}

// The real canvas's own context creation + extension check must still
// exist as belt-and-suspenders (in case the real canvas genuinely differs
// from the probe), but by construction the probe should catch the realistic
// "no GPU support" failure modes first.
if (!/const ctx = canvas\.getContext\('webgl2', contextOptions\);/.test(fn)) {
  fail('the real canvas should still get its own webgl2 context after the probe passes');
}

const coreSource = readFileSync(resolve('packages/eviland-core/src/eviland.ts'), 'utf8');
if (coreSource !== source) {
  fail('packages/eviland-core/src/eviland.ts has drifted from src/visualizer/eviland.ts — run node packages/eviland-core/sync.mjs');
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:eviland-renderer-probe"/.test(packageSource)) fail('package.json should expose the eviland renderer probe test');

console.log(log.join('\n') + '\n' + (pass ? '[renderer-probe-test] PASS' : '[renderer-probe-test] FAIL'));
process.exitCode = pass ? 0 : 1;
