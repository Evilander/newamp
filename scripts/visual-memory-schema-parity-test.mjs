// shared/visual-memory.ts mirrors src/visualizer/eviland-memory-types.ts's
// VisualMemoryPlan shape by hand — but unlike the algorithm-side file and
// its packages/eviland-core mirror (enforced byte-identical by
// packages/eviland-core/sync.mjs --check, wired into `prebuild`),
// shared/visual-memory.ts isn't in that sync list and isn't watched by
// scripts/algo-version-guard.mjs either. It can drift from the other two
// with no build-time catch — the only place it meets the algorithm-side
// type in electron/main.ts is an unchecked `as VisualMemoryPlan` cast. This
// adds exactly that missing catch: it asserts the two files' version
// constants agree, and that their two validator functions require the same
// set of fields (a proxy for "the shape is still the same"), so a shape
// change in one that isn't mirrored in the other fails a test instead of
// only surfacing as a runtime rejection.
// Run: node scripts/visual-memory-schema-parity-test.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const sharedSource = readFileSync(resolve('shared/visual-memory.ts'), 'utf8');
const algoSource = readFileSync(resolve('src/visualizer/eviland-memory-types.ts'), 'utf8');

function constant(source, name) {
  const m = source.match(new RegExp(`export const ${name} = (\\d+);`));
  return m ? Number(m[1]) : null;
}
for (const name of ['VISUAL_MEMORY_SCHEMA_VERSION', 'VISUAL_MEMORY_ALGO_VERSION']) {
  const sharedValue = constant(sharedSource, name);
  const algoValue = constant(algoSource, name);
  log.push(`${name}: shared=${sharedValue} algo=${algoValue}`);
  if (sharedValue == null) fail(`shared/visual-memory.ts should export ${name}`);
  if (algoValue == null) fail(`eviland-memory-types.ts should export ${name}`);
  if (sharedValue !== algoValue) fail(`${name} has drifted: shared/visual-memory.ts=${sharedValue}, eviland-memory-types.ts=${algoValue}`);
}

// Field-name proxy for "the two validators still require the same shape".
// Pulls every `.identifier` access inside each validator function body.
function validatorFields(source, fnName) {
  const fnMatch = source.match(new RegExp(`export function ${fnName}\\([\\s\\S]*?\\n\\}`));
  if (!fnMatch) return null;
  const body = fnMatch[0];
  const fields = new Set();
  for (const m of body.matchAll(/\.([a-zA-Z][a-zA-Z0-9]*)\b/g)) {
    // Exclude JS/TS built-ins that show up as property access but aren't
    // plan fields, so the diff stays meaningful.
    if (!['isArray', 'length', 'trigger', 'tier', 'every'].includes(m[1])) fields.add(m[1]);
  }
  return fields;
}

const sharedFields = validatorFields(sharedSource, 'isValidVisualMemoryPlan');
const algoFields = validatorFields(algoSource, 'validatePlan');
if (!sharedFields) fail('could not locate isValidVisualMemoryPlan in shared/visual-memory.ts');
if (!algoFields) fail('could not locate validatePlan in eviland-memory-types.ts');

if (sharedFields && algoFields) {
  const onlyInShared = [...sharedFields].filter((f) => !algoFields.has(f)).sort();
  const onlyInAlgo = [...algoFields].filter((f) => !sharedFields.has(f)).sort();
  log.push(`shared-only fields: ${onlyInShared.join(', ') || '(none)'}`);
  log.push(`algo-only fields: ${onlyInAlgo.join(', ') || '(none)'}`);
  if (onlyInShared.length) fail(`isValidVisualMemoryPlan checks fields validatePlan doesn't: ${onlyInShared.join(', ')} — the two schemas have drifted`);
  if (onlyInAlgo.length) fail(`validatePlan checks fields isValidVisualMemoryPlan doesn't: ${onlyInAlgo.join(', ')} — the two schemas have drifted`);
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:visual-memory-schema-parity"/.test(packageSource)) fail('package.json should expose the visual-memory schema parity test');

console.log(log.join('\n') + '\n' + (pass ? '[visual-memory-schema-parity-test] PASS' : '[visual-memory-schema-parity-test] FAIL'));
process.exitCode = pass ? 0 : 1;
