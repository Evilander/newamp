// Channel plumbing + SEED-CODE STABILITY for the fluid channels. The goldens
// were captured from the randomizer BEFORE fluid/vorticity were added; they
// must never change, proving shared seed codes keep their exact look.
// Run: node scripts/eviland-operators-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-operators-test-result.txt');
writeFileSync(RESULT, '[eviland-operators-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-randomizer.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-rand-bundle.mjs'), logLevel: 'silent',
});
const { generate, mutate } = await import(pathToFileURL(resolve('tmp/eviland-rand-bundle.mjs')).href);
await build({
  entryPoints: [resolve('src/visualizer/eviland-operators.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-ops-bundle.mjs'), logLevel: 'silent',
});
const { defaultConfig, cloneConfig, lerpConfig } = await import(pathToFileURL(resolve('tmp/eviland-ops-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const close = (a, b) => Math.abs(a - b) < 1e-9;

// --- GOLDENS (captured pre-change from unmodified code; must never drift) ---
const GOLDEN = {
  42: { zoom: 0.010925956232938915, rotate: -0.002692744402214885, swirl: -0.009321760525926948, hueCycle: 0.0034588682329049335, decay: 0.838650261722505, warpAmp: 0.0003438699586782604, mirrorMix: 0.5894492887891829, archetype: 'lattice' },
  1337: { zoom: 0.0072173870278056705, rotate: -0.004974026433192193, swirl: 0.009419304635375735, hueCycle: 0.004696161659434438, decay: 0.8620538124674931, warpAmp: 0.0003708583426661789, mirrorMix: 0.8111618332564831, archetype: 'kaleidoscope' },
};
for (const seed of [42, 1337]) {
  const c = generate(seed).config;
  const g = GOLDEN[seed];
  for (const k of ['zoom', 'rotate', 'swirl', 'hueCycle', 'decay', 'warpAmp', 'mirrorMix']) {
    if (!close(c[k].base, g[k])) fail(`seed ${seed} ${k}.base drifted: ${c[k].base} != ${g[k]}`);
  }
  if (c.archetype !== g.archetype) fail(`seed ${seed} archetype drifted`);
  log.push(`seed ${seed}: goldens hold (${c.archetype})`);
}

// --- fluid channels exist, in range, everywhere ---
for (const seed of [42, 1337, 7, 'NEON-RIVER']) {
  const c = generate(seed).config;
  if (!c.fluid || typeof c.fluid.base !== 'number') fail(`seed ${seed}: missing fluid channel`);
  if (!c.vorticity || typeof c.vorticity.base !== 'number') fail(`seed ${seed}: missing vorticity channel`);
  if (c.fluid && (c.fluid.base < 0 || c.fluid.base > 1)) fail(`seed ${seed}: fluid.base out of range`);
  if (c.vorticity && (c.vorticity.base < 0 || c.vorticity.base > 30)) fail(`seed ${seed}: vorticity.base out of range`);
}
log.push('fluid/vorticity present + in range across seeds');

// defaultConfig has them; clone/lerp roundtrip them.
const d = defaultConfig();
if (!d.fluid || !d.vorticity) fail('defaultConfig missing fluid channels');
const a = generate(42).config; const b = generate(1337).config;
const mid = lerpConfig(a, b, 0.5);
if (!close(mid.fluid.base, (a.fluid.base + b.fluid.base) / 2)) fail('lerpConfig does not interpolate fluid.base');
const cl = cloneConfig(a);
if (cl.fluid === a.fluid) fail('cloneConfig must deep-copy fluid channel');
if (!close(cl.fluid.base, a.fluid.base)) fail('cloneConfig fluid value mismatch');

// mutate keeps them in safe range.
const m = mutate(a, 1, 99);
if (m.fluid.base < 0 || m.fluid.base > 1) fail('mutate pushed fluid out of range');
log.push('default/clone/lerp/mutate plumbing OK');

const report = log.join('\n') + '\n' + (pass ? '[eviland-operators-test] PASS' : '[eviland-operators-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
