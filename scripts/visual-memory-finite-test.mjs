// Both isValidVisualMemoryPlan (shared/visual-memory.ts) and validatePlan
// (src/visualizer/eviland-memory-types.ts) checked numeric fields with a
// bare `typeof v === 'number'`, which is true for NaN and +/-Infinity too.
// JSON.stringify turns any of those into `null`, and the NEXT read's same
// bare typeof check then rejects that null — so one non-finite value
// anywhere in a plan (fingerprint/seed/counter/etc) got it silently written
// as corrupt, then the whole plan quarantined on the very next read.
// Run: npm run build:electron && node scripts/visual-memory-finite-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isValidVisualMemoryPlan } from '../dist-electron/shared/visual-memory.js';

const outDir = resolve('tmp', 'visual-memory-finite-test');
await mkdir(outDir, { recursive: true });
const outfile = resolve(outDir, 'eviland-memory-types.mjs');
await build({
  entryPoints: [resolve('src/visualizer/eviland-memory-types.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile, logLevel: 'silent',
});
const { validatePlan } = await import(pathToFileURL(outfile).toString());

function basePlan() {
  return {
    schema: 1,
    algoVersion: 1,
    trackId: 1,
    songId: 'track-1',
    lineage: { rootSeed: 1, ancestors: [], generation: 0, evolutionLog: [] },
    sections: [{
      sectionId: 0,
      fingerprint: new Array(24).fill(0.5),
      seed: 1,
      archetype: 'phosphor',
      tier: 'calm',
      rotationIndex: 0,
      observedCount: 1,
      firstSeenAt: 1000,
      lastSeenAt: 1000,
    }],
    counters: { plays: 1, skips: 0, loves: 0, sectionReturns: 0 },
    updatedAt: 1000,
  };
}

for (const validate of [isValidVisualMemoryPlan, validatePlan]) {
  assert.equal(validate(basePlan()), true, 'a well-formed plan should validate');

  const nanFingerprint = basePlan();
  nanFingerprint.sections[0].fingerprint[3] = NaN;
  assert.equal(validate(nanFingerprint), false, 'NaN in a fingerprint value should be rejected');

  const infSeed = basePlan();
  infSeed.sections[0].seed = Infinity;
  assert.equal(validate(infSeed), false, 'Infinity in a section seed should be rejected');

  const negInfCounter = basePlan();
  negInfCounter.counters.plays = -Infinity;
  assert.equal(validate(negInfCounter), false, '-Infinity in a counter should be rejected');

  const nanRootSeed = basePlan();
  nanRootSeed.lineage.rootSeed = NaN;
  assert.equal(validate(nanRootSeed), false, 'NaN in lineage.rootSeed should be rejected');

  const infAncestor = basePlan();
  infAncestor.lineage.ancestors = [1, Infinity];
  assert.equal(validate(infAncestor), false, 'Infinity in a lineage ancestor should be rejected');
}

// --- Source assertions ---
const [sharedSource, algoSource, coreSource, packageSource] = await Promise.all([
  readFile(new URL('../shared/visual-memory.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/visualizer/eviland-memory-types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/eviland-core/src/eviland-memory-types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);
assert.match(sharedSource, /function isFiniteNumber\(/, 'shared/visual-memory.ts should have a finite-number guard');
assert.match(algoSource, /function isFiniteNumber\(/, 'eviland-memory-types.ts should have a finite-number guard');
assert.equal(coreSource, algoSource, 'packages/eviland-core/src/eviland-memory-types.ts has drifted — run node packages/eviland-core/sync.mjs');
assert.match(packageSource, /"test:visual-memory-finite"/, 'package.json should expose the visual-memory finite test');

console.log(JSON.stringify({ ok: true }, null, 2));
