// mutate() perturbed waveform.intensity by reusing the 'bloom' SAFE_RANGES
// entry ({min:0, max:1.1}) instead of intensity's own real range (evalConfig
// clamps waveIntensity to [0,3] in eviland-operators.ts). Several archetypes
// deliberately seed intensity above 1.1 (phosphor: 1.4-2.2) — a single
// mutate() call, even amount=0 ("near no-op, still re-clamps" per the
// original code's own comment), silently and permanently cut it down to 1.1.
// Run: node scripts/eviland-mutate-wave-intensity-test.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
await build({
  entryPoints: [resolve('src/visualizer/eviland-randomizer.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/randomizer-bundle.mjs'), logLevel: 'silent',
});
const { generate, mutate } = await import(pathToFileURL(resolve('tmp/randomizer-bundle.mjs')).href);

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const { config, seed } = generate('mutate-wave-intensity-test-seed', 'phosphor');
const startIntensity = config.waveform.intensity.base;
log.push(`phosphor seed intensity.base=${startIntensity.toFixed(3)}`);
if (!(startIntensity > 1.1)) {
  fail(`test assumption broken: the phosphor archetype should seed intensity above 1.1 (bloom's old range ceiling), got ${startIntensity}`);
}

// amount=0 is documented as a near-no-op — jitterNum adds zero jitter at
// amount 0, so the only thing that can move intensity.base here is the
// clamp itself. This isolates exactly the reported bug.
const mutated = mutate(config, 0, seed);
const afterIntensity = mutated.waveform.intensity.base;
log.push(`after mutate(amount=0): intensity.base=${afterIntensity.toFixed(3)}`);
if (Math.abs(afterIntensity - startIntensity) > 1e-9) {
  fail(`amount=0 should not move intensity.base at all (no jitter, and it should now be within range so the clamp is a no-op too); moved from ${startIntensity} to ${afterIntensity}`);
}

// Repeated mutate() calls (as the Director issues on every section
// start/drift) must not progressively erode intensity toward 1.1 either.
let drifted = config;
for (let i = 0; i < 20; i++) drifted = mutate(drifted, 0.3, `${seed}-${i}`);
log.push(`after 20 mutate(amount=0.3) calls: intensity.base=${drifted.waveform.intensity.base.toFixed(3)}`);
if (drifted.waveform.intensity.base > 3 || drifted.waveform.intensity.base < 0) {
  fail(`intensity.base drifted outside its real [0,3] range: ${drifted.waveform.intensity.base}`);
}

// --- Source assertions: the dedicated range and its use are actually wired up.
const randomizerSource = readFileSync(resolve('src/visualizer/eviland-randomizer.ts'), 'utf8');
if (!/waveIntensity: \{ min: 0, max: 3 \}/.test(randomizerSource)) {
  fail('SAFE_RANGES should define a dedicated waveIntensity range matching evalConfig\'s real [0,3] clamp');
}
if (!/mutateChannel\(rng, 'waveIntensity', next\.waveform\.intensity, a\)/.test(randomizerSource)) {
  fail('waveform.intensity should mutate against its own waveIntensity range, not bloom\'s');
}
if (/mutateChannel\(rng, 'bloom', next\.waveform\.intensity, a\)/.test(randomizerSource)) {
  fail('waveform.intensity should no longer reuse the bloom range');
}

const coreSource = readFileSync(resolve('packages/eviland-core/src/eviland-randomizer.ts'), 'utf8');
if (coreSource !== randomizerSource) {
  fail('packages/eviland-core/src/eviland-randomizer.ts has drifted from src/visualizer/eviland-randomizer.ts — run node packages/eviland-core/sync.mjs');
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:eviland-mutate-wave-intensity"/.test(packageSource)) {
  fail('package.json should expose the eviland mutate wave-intensity test');
}

console.log(log.join('\n') + '\n' + (pass ? '[mutate-wave-intensity-test] PASS' : '[mutate-wave-intensity-test] FAIL'));
process.exitCode = pass ? 0 : 1;
