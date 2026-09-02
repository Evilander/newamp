// Runtime unit test for the eviland visual-memory schema + pure helpers
// (no GPU, no Electron, no Director). Bundles eviland-memory-types.ts for
// Node and exercises:
//   1. JSON round-trip preserves the schema shape.
//   2. validatePlan rejects malformed inputs.
//   3. nextGenerationAt steps the 8/32/96/256 ladder exactly at boundaries.
//   4. prunePlan drops orphan evolutionLog entries but NEVER drops a
//      referenced ancestor seed (mu+lambda elitism is mandatory).
//   5. ancestors cap at 8; evolutionLog cap at 32.
// Run: node scripts/eviland-memory-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-memory-test-result.txt');
writeFileSync(RESULT, '[eviland-memory-test] starting…\n');
process.on('uncaughtException', (e) => {
  writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n');
  process.exitCode = 1;
});
process.on('unhandledRejection', (e) => {
  writeFileSync(RESULT, 'REJECTION: ' + (e?.stack || e) + '\n');
  process.exitCode = 1;
});

await build({
  entryPoints: [resolve('src/visualizer/eviland-memory-types.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-memory-bundle.mjs'), logLevel: 'silent',
});
const mod = await import(pathToFileURL(resolve('tmp/eviland-memory-bundle.mjs')).href);
const {
  VISUAL_MEMORY_SCHEMA_VERSION,
  VISUAL_MEMORY_ALGO_VERSION,
  LINEAGE_PLAY_LADDER,
  EVOLUTION_LOG_CAP,
  ANCESTORS_CAP,
  createEmptyPlan,
  validatePlan,
  prunePlan,
  nextGenerationAt,
} = mod;

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// ─── 1. Module surface sanity ───────────────────────────────────────────────
if (VISUAL_MEMORY_SCHEMA_VERSION !== 1) fail(`schema version expected 1, got ${VISUAL_MEMORY_SCHEMA_VERSION}`);
// Pinned to the constant, not a literal: bumping it is the correct response to a
// randomizer/director change (algo-version-guard enforces that), and this test
// exists to prove minted plans carry whatever the current version is.
if (!Number.isInteger(VISUAL_MEMORY_ALGO_VERSION) || VISUAL_MEMORY_ALGO_VERSION < 1) {
  fail(`algo version should be a positive integer, got ${VISUAL_MEMORY_ALGO_VERSION}`);
}
if (!Array.isArray(LINEAGE_PLAY_LADDER) || LINEAGE_PLAY_LADDER.join(',') !== '8,32,96,256') {
  fail(`LINEAGE_PLAY_LADDER expected [8,32,96,256], got ${LINEAGE_PLAY_LADDER}`);
}
if (EVOLUTION_LOG_CAP !== 32) fail(`EVOLUTION_LOG_CAP expected 32, got ${EVOLUTION_LOG_CAP}`);
if (ANCESTORS_CAP !== 8) fail(`ANCESTORS_CAP expected 8, got ${ANCESTORS_CAP}`);

// ─── 2. createEmptyPlan shape ───────────────────────────────────────────────
const empty = createEmptyPlan(42, 'track-42', 0xdeadbeef);
if (empty.trackId !== 42) fail('createEmptyPlan trackId mismatch');
if (empty.songId !== 'track-42') fail('createEmptyPlan songId mismatch');
if (empty.lineage.rootSeed !== 0xdeadbeef) fail('createEmptyPlan rootSeed mismatch');
if (empty.lineage.generation !== 0) fail('createEmptyPlan generation must start at 0');
if (empty.lineage.ancestors.length !== 0) fail('createEmptyPlan ancestors must start empty');
if (empty.lineage.evolutionLog.length !== 0) fail('createEmptyPlan evolutionLog must start empty');
if (empty.sections.length !== 0) fail('createEmptyPlan sections must start empty');
if (empty.counters.plays !== 0) fail('createEmptyPlan counters.plays must start at 0');
if (empty.updatedAt !== 0) fail('createEmptyPlan updatedAt must start at 0 (bridge stamps it)');
if (!validatePlan(empty)) fail('createEmptyPlan output must validate');
log.push(`empty plan minted: schema=${empty.schema} algo=${empty.algoVersion}`);

// ─── 3. JSON round-trip ─────────────────────────────────────────────────────
function makeRichPlan() {
  const plan = createEmptyPlan(7, 'track-7', 0x12345678);
  plan.updatedAt = 1_000_000;
  plan.counters = { plays: 17, skips: 1, loves: 1, sectionReturns: 4 };
  plan.lineage.ancestors = [0x12345678, 0x9abcdef0];
  plan.lineage.generation = 1;
  plan.lineage.rootSeed = 0xcafebabe;
  plan.lineage.evolutionLog = [
    { at: 100, trigger: 'play-count', fromSeed: 0x12345678, toSeed: 0x9abcdef0 },
    { at: 200, trigger: 'love', fromSeed: 0x9abcdef0, toSeed: 0xcafebabe },
  ];
  const fp = new Array(24).fill(0).map((_, i) => i / 24);
  plan.sections.push({
    sectionId: 0,
    fingerprint: fp,
    seed: 0xcafebabe,
    archetype: 'liquid',
    tier: 'calm',
    rotationIndex: 0,
    observedCount: 3,
    firstSeenAt: 50,
    lastSeenAt: 300,
  });
  plan.neighborSeed = { fromTrackId: 99, score: 0.94, at: 0 };
  return plan;
}
{
  const orig = makeRichPlan();
  const json = JSON.stringify(orig);
  const parsed = JSON.parse(json);
  if (!validatePlan(parsed)) fail('rich plan JSON round-trip did not validate');
  if (JSON.stringify(parsed) !== json) fail('rich plan JSON round-trip is not stable');
  log.push(`json round-trip stable (${json.length} bytes)`);
}

// ─── 4. validatePlan rejects malformed inputs ───────────────────────────────
const rejections = [
  ['null', null],
  ['undefined', undefined],
  ['string', 'not-a-plan'],
  ['array', []],
  ['missing schema', { ...makeRichPlan(), schema: undefined }],
  ['missing algoVersion', { ...makeRichPlan(), algoVersion: undefined }],
  ['missing trackId', { ...makeRichPlan(), trackId: 'x' }],
  ['empty songId', { ...makeRichPlan(), songId: '' }],
  ['missing lineage', { ...makeRichPlan(), lineage: null }],
  ['lineage non-numeric ancestor', (() => { const p = makeRichPlan(); p.lineage.ancestors = ['x']; return p; })()],
  ['bad evolutionLog trigger', (() => { const p = makeRichPlan(); p.lineage.evolutionLog[0].trigger = 'nope'; return p; })()],
  ['fingerprint wrong length', (() => { const p = makeRichPlan(); p.sections[0].fingerprint = [0,1,2]; return p; })()],
  ['fingerprint non-numeric', (() => { const p = makeRichPlan(); p.sections[0].fingerprint = new Array(24).fill('x'); return p; })()],
  ['bad tier', (() => { const p = makeRichPlan(); p.sections[0].tier = 'wild'; return p; })()],
  ['counters not numeric', (() => { const p = makeRichPlan(); p.counters.plays = 'lots'; return p; })()],
  ['neighborSeed missing score', (() => { const p = makeRichPlan(); p.neighborSeed = { fromTrackId: 1, at: 0 }; return p; })()],
];
for (const [label, value] of rejections) {
  if (validatePlan(value)) fail(`validatePlan accepted "${label}" — should reject`);
}
log.push(`validatePlan rejected ${rejections.length} malformed shapes`);

// Unknown extra fields should NOT cause rejection (forward-compat).
{
  const augmented = { ...makeRichPlan(), futureField: { hello: 'world' } };
  if (!validatePlan(augmented)) fail('validatePlan must accept plans with extra unknown fields (forward-compat)');
}

// ─── 5. nextGenerationAt ladder boundaries ──────────────────────────────────
const cases = [
  [0, 8], [1, 8], [7, 8],
  [8, 32], [9, 32], [31, 32],
  [32, 96], [95, 96],
  [96, 256], [255, 256],
  [256, null], [257, null], [10_000, null],
];
for (const [plays, expected] of cases) {
  const got = nextGenerationAt(plays);
  if (got !== expected) fail(`nextGenerationAt(${plays}) expected ${expected}, got ${got}`);
}
log.push(`ladder ${cases.length} cases pass`);

// Non-integer / negative robustness — these are not contract guarantees but
// should not throw (used at evolution-event time on counters).
if (nextGenerationAt(-5) !== 8) fail('nextGenerationAt(-5) should clamp to 0 path → 8');
if (nextGenerationAt(7.7) !== 8) fail('nextGenerationAt(7.7) should floor to 7 → 8');

// ─── 6. prunePlan drops orphan evolutionLog entries ────────────────────────
{
  const plan = createEmptyPlan(1, 'track-1', 100);
  plan.lineage.rootSeed = 100;
  plan.lineage.ancestors = [50, 75];
  // Section references seed=200. So referenced set = {100, 50, 75, 200}.
  plan.sections.push({
    sectionId: 0, fingerprint: new Array(24).fill(0),
    seed: 200, archetype: 'liquid', tier: 'calm', rotationIndex: 0,
    observedCount: 1, firstSeenAt: 0, lastSeenAt: 0,
  });
  plan.lineage.evolutionLog = [
    // Live: from referenced ancestor, to referenced seed.
    { at: 1, trigger: 'play-count', fromSeed: 50, toSeed: 75 },
    // Live: to current rootSeed.
    { at: 2, trigger: 'play-count', fromSeed: 75, toSeed: 100 },
    // Dead twig: neither endpoint referenced.
    { at: 3, trigger: 'play-count', fromSeed: 999, toSeed: 888 },
    // Live by `from` only (from referenced rootSeed). Tells the story even if
    // toSeed has been replaced — keep.
    { at: 4, trigger: 'love', fromSeed: 100, toSeed: 444 },
  ];
  prunePlan(plan);
  if (plan.lineage.evolutionLog.length !== 3) {
    fail(`prunePlan expected 3 live entries, got ${plan.lineage.evolutionLog.length}`);
  }
  if (plan.lineage.evolutionLog.some((e) => e.fromSeed === 999)) {
    fail('prunePlan kept a dead twig (from=999/to=888)');
  }
  // CRITICAL: no referenced seed (especially ancestors) was dropped.
  if (!plan.lineage.ancestors.includes(50) || !plan.lineage.ancestors.includes(75)) {
    fail('prunePlan dropped a referenced ancestor — elitism violated');
  }
  // Section seed survived as well.
  if (plan.sections[0].seed !== 200) fail('prunePlan touched section.seed');
  log.push(`prune orphan check: ${plan.lineage.evolutionLog.length} live entries kept`);
}

// ─── 7. prunePlan caps ───────────────────────────────────────────────────────
{
  const plan = createEmptyPlan(2, 'track-2', 0);
  // 50 ancestors. All referenced (we put them in ancestors!) — cap should
  // FIFO-trim oldest 42 down to 8, NEVER selectively drop.
  plan.lineage.ancestors = Array.from({ length: 50 }, (_, i) => i + 1);
  prunePlan(plan);
  if (plan.lineage.ancestors.length !== ANCESTORS_CAP) {
    fail(`ancestors cap expected ${ANCESTORS_CAP}, got ${plan.lineage.ancestors.length}`);
  }
  // Oldest trimmed: kept ancestors should be the LAST 8 of the original.
  const expectedKept = Array.from({ length: ANCESTORS_CAP }, (_, i) => 50 - ANCESTORS_CAP + 1 + i);
  if (plan.lineage.ancestors.join(',') !== expectedKept.join(',')) {
    fail(`ancestors cap kept the wrong slice: got ${plan.lineage.ancestors.join(',')}, expected ${expectedKept.join(',')}`);
  }

  // evolutionLog with 50 referenced entries. After cap, last 32 kept (oldest trimmed).
  // Each entry's toSeed points to the current rootSeed so all are referenced.
  plan.lineage.rootSeed = 9999;
  plan.lineage.evolutionLog = Array.from({ length: 50 }, (_, i) => ({
    at: i, trigger: 'play-count', fromSeed: 1, toSeed: 9999,
  }));
  prunePlan(plan);
  if (plan.lineage.evolutionLog.length !== EVOLUTION_LOG_CAP) {
    fail(`evolutionLog cap expected ${EVOLUTION_LOG_CAP}, got ${plan.lineage.evolutionLog.length}`);
  }
  // FIFO: kept entries should be the latest 32 (at values 18..49).
  if (plan.lineage.evolutionLog[0].at !== 50 - EVOLUTION_LOG_CAP) {
    fail(`evolutionLog cap kept wrong slice: first.at=${plan.lineage.evolutionLog[0].at}`);
  }
  log.push(`caps: ancestors=${plan.lineage.ancestors.length}, evolutionLog=${plan.lineage.evolutionLog.length}`);
}

// ─── 8. prunePlan never drops a section seed that's still in `sections` ────
{
  const plan = createEmptyPlan(3, 'track-3', 5);
  plan.lineage.rootSeed = 5;
  plan.sections.push({
    sectionId: 0, fingerprint: new Array(24).fill(0),
    seed: 0xdead, archetype: 'liquid', tier: 'calm', rotationIndex: 0,
    observedCount: 1, firstSeenAt: 0, lastSeenAt: 0,
  });
  // Entry references a section.seed — must survive prune even though its
  // toSeed isn't the rootSeed.
  plan.lineage.evolutionLog = [
    { at: 1, trigger: 'section-return', fromSeed: 5, toSeed: 0xdead },
  ];
  prunePlan(plan);
  if (plan.lineage.evolutionLog.length !== 1) {
    fail('prunePlan dropped an entry whose toSeed is a section.seed (still referenced)');
  }
}

const report = log.join('\n') + '\n' + (pass ? '[eviland-memory-test] PASS' : '[eviland-memory-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
