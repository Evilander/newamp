// Pure-node unit test for the visual-memory bridge (no Electron, no GPU).
// Bundles eviland-memory-bridge.ts and feeds it an in-memory mock API. Covers:
//   1. Null trackId → loadOrSeed returns null and observeSection no-ops.
//   2. Existing plan loads verbatim.
//   3. DNA-neighbor borrow at score ≥ 0.92 mints a derived rootSeed and the
//      derived seed NEVER equals the neighbor's rootSeed.
//   4. Neighbor below threshold → returns null (no borrow).
//   5. observeSection buffers + auto-flushes at LEARN_FLUSH_THRESHOLD.
//   6. Lineage generation tick at the 8/32/96/256 ladder.
//   7. Love forces a generation tick when generation < 3, never at ≥ 3.
//   8. flushAndDispose persists once when dirty, idempotent on second call.
// Run: node scripts/eviland-memory-bridge-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-memory-bridge-test-result.txt');
writeFileSync(RESULT, '[eviland-memory-bridge-test] starting…\n');
process.on('uncaughtException', (e) => {
  writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n');
  process.exitCode = 1;
});
process.on('unhandledRejection', (e) => {
  writeFileSync(RESULT, 'REJECTION: ' + (e?.stack || e) + '\n');
  process.exitCode = 1;
});

await build({
  entryPoints: [resolve('src/visualizer/eviland-memory-bridge.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-memory-bridge-bundle.mjs'), logLevel: 'silent',
});
const mod = await import(pathToFileURL(resolve('tmp/eviland-memory-bridge-bundle.mjs')).href);
const { createMemoryBridge, NEIGHBOR_BORROW_THRESHOLD, LEARN_FLUSH_THRESHOLD } = mod;

await build({
  entryPoints: [resolve('src/visualizer/eviland-memory-types.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-memory-types-bundle.mjs'), logLevel: 'silent',
});
const typesMod = await import(pathToFileURL(resolve('tmp/eviland-memory-types-bundle.mjs')).href);
const { createEmptyPlan } = typesMod;

await build({
  entryPoints: [resolve('src/visualizer/eviland-rng.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-rng-bundle.mjs'), logLevel: 'silent',
});
const rngMod = await import(pathToFileURL(resolve('tmp/eviland-rng-bundle.mjs')).href);
const { hashSeed } = rngMod;

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// --- helpers ---
function makeMockApi() {
  const store = new Map(); // trackId -> plan
  const similar = new Map(); // trackId -> SimilarTrack[]
  let writes = 0;
  const api = {
    async getTrackVisualMemory(id) { return store.get(id) ?? null; },
    async setTrackVisualMemory(id, plan) { store.set(id, plan); writes++; return true; },
    async clearTrackVisualMemory(id) { store.delete(id); return true; },
    async findSimilarTracks(id /*, limit */) { return similar.get(id) ?? []; },
  };
  return { api, store, similar, writeCount: () => writes };
}

function fakeSection(sectionId, seed) {
  return {
    sectionId,
    fingerprint: new Array(24).fill(0.2),
    seed: seed >>> 0,
    archetype: 'liquid',
    tier: 'calm',
    rotationIndex: 0,
    observedCount: 1,
    firstSeenAt: 0,
    lastSeenAt: 0,
  };
}

function makeDirector(initialPlan) {
  // Minimal Director mock — exportPlan returns whatever was last set via
  // setSections, with the bridge-supplied updatedAt stamped on.
  let sections = initialPlan ? initialPlan.sections.slice() : [];
  let lineage = initialPlan?.lineage ?? { rootSeed: 0, ancestors: [], generation: 0, evolutionLog: [] };
  return {
    setSections(next) { sections = next.slice(); },
    exportPlan(updatedAt = 0) {
      return {
        schema: 1,
        algoVersion: 1,
        trackId: initialPlan?.trackId ?? 0,
        songId: initialPlan?.songId ?? `track-${initialPlan?.trackId ?? 0}`,
        lineage: {
          rootSeed: lineage.rootSeed >>> 0,
          ancestors: lineage.ancestors.slice(),
          generation: lineage.generation | 0,
          evolutionLog: lineage.evolutionLog.slice(),
        },
        sections: sections.slice(),
        counters: initialPlan?.counters ?? { plays: 0, skips: 0, loves: 0, sectionReturns: 0 },
        updatedAt,
      };
    },
    // unused by the bridge; kept so any future surface that the bridge calls
    // through Director.* won't NPE in this mock if added later.
    update() { return {}; },
    loadPlan() {},
    reset() {},
    setEnabled() {},
    isEnabled() { return true; },
    current() { return {}; },
    setCurrent() {},
  };
}

// ─── 1. Null trackId → loadOrSeed returns null, observeSection is a no-op ───
{
  const { api } = makeMockApi();
  const b = createMemoryBridge({ trackId: null, api });
  const loaded = await b.loadOrSeed();
  if (loaded !== null) fail(`null-track loadOrSeed expected null, got ${JSON.stringify(loaded)}`);
  // observeSection must NOT throw and must NOT auto-flush (no setTrackVisualMemory hit).
  for (let i = 0; i < LEARN_FLUSH_THRESHOLD + 2; i++) b.observeSection(fakeSection(i, i * 7));
  const ok = await b.flush('manual');
  if (ok) fail('null-track flush should be a no-op (got ok=true)');
  log.push('null trackId: loadOrSeed→null, observe→no-op, flush→false ✓');
}

// ─── 2. Existing plan loads verbatim and state surfaces it ──────────────────
{
  const { api, store } = makeMockApi();
  const trackId = 11;
  const existing = createEmptyPlan(trackId, `track-${trackId}`, 0xdeadbeef);
  existing.counters = { plays: 5, skips: 0, loves: 1, sectionReturns: 2 };
  existing.lineage.generation = 0;
  existing.sections.push(fakeSection(0, 0x1111));
  existing.sections.push(fakeSection(1, 0x2222));
  existing.updatedAt = 12345;
  store.set(trackId, existing);
  const b = createMemoryBridge({ trackId, api });
  const loaded = await b.loadOrSeed();
  if (!loaded) fail('existing plan: loadOrSeed returned null');
  if (loaded?.lineage.rootSeed !== 0xdeadbeef) fail('existing plan: rootSeed mismatch');
  const s = b.getState();
  if (s.plays !== 5) fail(`existing plan: state.plays=${s.plays}, expected 5`);
  if (s.sectionsKnown !== 2) fail(`existing plan: state.sectionsKnown=${s.sectionsKnown}, expected 2`);
  if (s.borrowed) fail('existing plan: state.borrowed should be false');
  log.push(`existing plan loaded: gen=${s.generation} plays=${s.plays} sections=${s.sectionsKnown}`);
}

// ─── 3. DNA-neighbor borrow ≥ 0.92 mints derived seed ≠ neighbor's rootSeed ─
{
  const { api, store, similar } = makeMockApi();
  const trackId = 42;
  const neighborId = 99;
  const neighborPlan = createEmptyPlan(neighborId, `track-${neighborId}`, 0xfeedface);
  neighborPlan.sections.push(fakeSection(0, 0xaaaa));
  store.set(neighborId, neighborPlan);
  similar.set(trackId, [{ track: { id: neighborId }, score: 0.95 }]);

  const fixedNow = 1_700_000_000_000;
  const b = createMemoryBridge({ trackId, api, now: () => fixedNow });
  const minted = await b.loadOrSeed();
  if (!minted) fail('borrow: expected derived plan, got null');
  if (minted?.trackId !== trackId) fail('borrow: derived trackId mismatch');
  if (!minted?.neighborSeed) fail('borrow: neighborSeed missing on derived plan');
  if (minted?.neighborSeed?.fromTrackId !== neighborId) fail('borrow: neighborSeed.fromTrackId wrong');
  if (minted?.neighborSeed?.at !== fixedNow) fail('borrow: neighborSeed.at not stamped from injected now()');
  if ((minted?.lineage.rootSeed >>> 0) === (neighborPlan.lineage.rootSeed >>> 0)) {
    fail('CRITICAL: derived rootSeed equals neighbor rootSeed (borrow semantic broken)');
  }
  // Determinism: re-running with the same inputs yields the same derived seed.
  const b2 = createMemoryBridge({ trackId, api, now: () => fixedNow });
  const again = await b2.loadOrSeed();
  if ((again?.lineage.rootSeed >>> 0) !== (minted?.lineage.rootSeed >>> 0)) {
    fail('borrow: derived rootSeed is non-deterministic across bridges');
  }
  // Verify the derivation rule matches the spec: hashSeed(`${neighborRoot}::borrow::${trackId}`)
  const expected = hashSeed(`${(neighborPlan.lineage.rootSeed >>> 0)}::borrow::${trackId}`) >>> 0;
  if ((minted?.lineage.rootSeed >>> 0) !== expected) {
    fail(`borrow: derived rootSeed ${minted?.lineage.rootSeed} != expected ${expected}`);
  }
  log.push(`borrow: derived seed=${minted?.lineage.rootSeed >>> 0} (≠ neighbor ${neighborPlan.lineage.rootSeed >>> 0}) ✓`);
}

// ─── 4. Neighbor below threshold → null (no borrow) ─────────────────────────
{
  const { api, store, similar } = makeMockApi();
  const trackId = 43;
  const neighborId = 100;
  store.set(neighborId, createEmptyPlan(neighborId, `track-${neighborId}`, 0xbeef));
  similar.set(trackId, [{ track: { id: neighborId }, score: NEIGHBOR_BORROW_THRESHOLD - 0.01 }]);
  const b = createMemoryBridge({ trackId, api });
  const result = await b.loadOrSeed();
  if (result !== null) fail(`below-threshold borrow returned a plan (score ${NEIGHBOR_BORROW_THRESHOLD - 0.01})`);
  log.push('below-threshold neighbor: no borrow ✓');
}

// ─── 5. observeSection buffers + auto-flushes at LEARN_FLUSH_THRESHOLD ──────
{
  const { api, store, similar, writeCount } = makeMockApi();
  const trackId = 77;
  similar.set(trackId, []);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed(); // null, no existing — bridge stays plan-less

  // No plan yet, so the bridge has nothing to persist (no Director attached).
  // Attach a director so flush has a target. The Director's sections list is
  // authoritative; we mirror what we'd see if the Director actually got these.
  const fakePlan = createEmptyPlan(trackId, `track-${trackId}`, hashSeed(`track-${trackId}`));
  const director = makeDirector(fakePlan);
  b.attachDirector(director);
  // Pre-seed the bridge's plan via a fake load (otherwise composePlanForWrite
  // starts from the Director's exportPlan with no counters). Simulate by
  // setting an empty plan and loading it.
  store.set(trackId, fakePlan);
  await b.loadOrSeed();

  // Now observe LEARN_FLUSH_THRESHOLD sections — should auto-flush exactly once.
  const startWrites = writeCount();
  for (let i = 0; i < LEARN_FLUSH_THRESHOLD; i++) {
    director.setSections([fakeSection(i, hashSeed(`track-${trackId}::section::${i}`))]);
    b.observeSection(fakeSection(i, hashSeed(`track-${trackId}::section::${i}`)));
  }
  // Allow the in-flight promise to settle.
  await Promise.resolve();
  await Promise.resolve();
  const endWrites = writeCount();
  if (endWrites !== startWrites + 1) {
    fail(`dirty-threshold flush: expected exactly 1 write, got ${endWrites - startWrites}`);
  }
  log.push(`dirty-threshold auto-flush fires once at N=${LEARN_FLUSH_THRESHOLD} ✓`);
}

// ─── 6. Lineage generation tick at the 8/32/96/256 ladder ───────────────────
{
  const { api, store } = makeMockApi();
  const trackId = 88;
  const initial = createEmptyPlan(trackId, `track-${trackId}`, 0xcafebabe);
  initial.counters.plays = 7;
  store.set(trackId, initial);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed();
  // plays goes 7 → 8: should tick generation 0 → 1 (first ladder rung).
  b.recordCompletedPlay();
  const s1 = b.getState();
  if (s1.plays !== 8) fail(`gen-tick: expected plays=8, got ${s1.plays}`);
  if (s1.generation !== 1) fail(`gen-tick: expected generation=1 at plays=8, got ${s1.generation}`);
  // plays goes 8 → 9: no tick (no rung between 8 and 32).
  b.recordCompletedPlay();
  if (b.getState().generation !== 1) fail('gen-tick: spurious tick between rungs');
  // Walk up to plays=32 → tick to generation 2.
  while (b.getState().plays < 32) b.recordCompletedPlay();
  if (b.getState().generation !== 2) fail(`gen-tick: expected generation=2 at plays=32, got ${b.getState().generation}`);
  log.push(`ladder tick verified: gen→1 at plays=8, gen→2 at plays=32 ✓`);
}

// ─── 7. Love forces a tick when gen < 3, never at gen ≥ 3 ───────────────────
{
  const { api, store } = makeMockApi();
  const trackId = 89;
  const initial = createEmptyPlan(trackId, `track-${trackId}`, 0xfeed);
  store.set(trackId, initial);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed();
  if (b.getState().generation !== 0) fail('love-tick precondition: generation should start at 0');
  b.recordLove();
  if (b.getState().generation !== 1) fail(`love-tick: expected gen=1 after first love at gen 0, got ${b.getState().generation}`);
  b.recordLove();
  if (b.getState().generation !== 2) fail(`love-tick: expected gen=2 after second love, got ${b.getState().generation}`);
  b.recordLove();
  if (b.getState().generation !== 3) fail(`love-tick: expected gen=3 after third love, got ${b.getState().generation}`);
  // Now at gen 3: love must NOT tick further.
  b.recordLove();
  if (b.getState().generation !== 3) fail(`love-tick: gen=3 must not advance (got ${b.getState().generation})`);
  log.push('love-tick: gen 0→1→2→3, frozen at ≥3 ✓');
}

// ─── 8. flushAndDispose persists once, then is idempotent ───────────────────
{
  const { api, store, similar, writeCount } = makeMockApi();
  const trackId = 90;
  similar.set(trackId, []);
  const initial = createEmptyPlan(trackId, `track-${trackId}`, hashSeed(`track-${trackId}`));
  store.set(trackId, initial);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed();
  const director = makeDirector(initial);
  b.attachDirector(director);
  director.setSections([fakeSection(0, 0x1234)]);
  b.observeSection(fakeSection(0, 0x1234));
  const startWrites = writeCount();
  const first = await b.flushAndDispose('unmount');
  if (!first) fail('flushAndDispose: first call should succeed');
  const second = await b.flushAndDispose('unmount');
  if (second) fail('flushAndDispose: second call should no-op (dispose is idempotent)');
  const writes = writeCount() - startWrites;
  if (writes !== 1) fail(`flushAndDispose: expected exactly 1 write, got ${writes}`);
  log.push('flushAndDispose: persists once, idempotent on second call ✓');
}

const report = log.join('\n') + '\n' + (pass ? '[eviland-memory-bridge-test] PASS' : '[eviland-memory-bridge-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
