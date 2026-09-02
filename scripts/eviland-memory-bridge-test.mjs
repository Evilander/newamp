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
  // Test-controllable write timing/outcome — both default to off, so existing
  // tests that never call these are unaffected (immediate resolve, always ok).
  let writeGate = null; // Promise | null — the NEXT write awaits it once, then clears itself
  let failNext = false; // the NEXT write rejects instead of persisting, then clears itself
  const api = {
    async getTrackVisualMemory(id) { return store.get(id) ?? null; },
    async setTrackVisualMemory(id, plan) {
      if (writeGate) {
        const gate = writeGate;
        writeGate = null;
        await gate;
      }
      if (failNext) {
        failNext = false;
        throw new Error('simulated write failure');
      }
      store.set(id, plan);
      writes++;
      return true;
    },
    async clearTrackVisualMemory(id) { store.delete(id); return true; },
    async findSimilarTracks(id /*, limit */) { return similar.get(id) ?? []; },
  };
  return {
    api, store, similar,
    writeCount: () => writes,
    /** Delay the NEXT setTrackVisualMemory call until `promise` settles. */
    gateNextWrite(promise) { writeGate = promise; },
    /** Make the NEXT setTrackVisualMemory call reject instead of persisting. */
    failNextWrite() { failNext = true; },
  };
}

/** A promise plus its external resolve fn, for pinning write timing in tests. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
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

// ─── 8. discard() drops in-memory state + short-circuits future writes ─────
//
// Repro for finding #1/#2 of the pre-release review: badge "Reset visual
// memory" used to call api.clearTrackVisualMemory then flushAndDispose, but
// the bridge's still-resident in-memory plan + buffered sections caused
// flushAndDispose to re-write the row that was just deleted. discard() is
// the load-bearing primitive that makes that sequence safe.
{
  const { api, store, similar, writeCount } = makeMockApi();
  const trackId = 91;
  similar.set(trackId, []);
  const initial = createEmptyPlan(trackId, `track-${trackId}`, 0x1234abcd);
  initial.sections.push(fakeSection(0, 0xdeadbeef));
  initial.counters.plays = 5;
  store.set(trackId, initial);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed();
  if (!b.getState().hasPlan) fail('discard precondition: plan should be loaded');
  if (b.getState().plays !== 5) fail('discard precondition: plays should be 5');

  // Buffer some learning so flush() WOULD do work.
  const director = makeDirector(initial);
  b.attachDirector(director);
  director.setSections([fakeSection(0, 0xdeadbeef)]);
  b.observeSection(fakeSection(0, 0xdeadbeef));

  const writesBeforeDiscard = writeCount();
  b.discard();
  // discard() emitted a notify() with hasPlan=false before clearing listeners.
  if (b.getState().hasPlan) fail('discard: state.hasPlan should be false post-discard');
  if (b.getState().plays !== 0) fail('discard: state.plays should be 0 post-discard');

  // Any subsequent flush MUST be a no-op (no DB write).
  const flushed = await b.flush('manual');
  if (flushed) fail('discard: flush() after discard should return false');
  const flushAndDisposed = await b.flushAndDispose('manual');
  if (flushAndDisposed) fail('discard: flushAndDispose() after discard should return false');

  // observeSection() after discard must be inert (no allocation, no flush).
  for (let i = 0; i < LEARN_FLUSH_THRESHOLD + 2; i++) b.observeSection(fakeSection(i + 100, 0xcafe));
  if (writeCount() !== writesBeforeDiscard) {
    fail(`discard: writes leaked after discard (${writeCount() - writesBeforeDiscard})`);
  }
  // record* methods after discard must also be inert.
  b.recordCompletedPlay();
  b.recordLove();
  b.recordSkip();
  b.recordSectionReturn();
  if (writeCount() !== writesBeforeDiscard) fail('discard: record* methods wrote after discard');
  log.push('discard: future flushes + observes + record* short-circuit ✓');
}

// ─── 9. Registry routing: right-track routes, wrong-track + no-bridge no-op ─
//
// Coverage for the notifyPlayCompleted / notifyLove / notifySkip /
// notifySectionReturn fns that wire usePlayerStore into the bridge in
// production (finding #1 of the regression-and-claims dimension). Loads
// the registry as a separate bundle since its exports are independent.
{
  await build({
    entryPoints: [resolve('src/visualizer/eviland-memory-bridge-registry.ts')],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile: resolve('tmp/eviland-memory-bridge-registry-bundle.mjs'), logLevel: 'silent',
  });
  const reg = await import(pathToFileURL(resolve('tmp/eviland-memory-bridge-registry-bundle.mjs')).href);

  // No bridge: notify* must be cheap no-ops (no throw).
  reg.publishActiveBridge(null);
  reg.notifyPlayCompleted(42);
  reg.notifyLove(42);
  reg.notifySkip(42);
  reg.notifySectionReturn(42);
  // The above is "doesn't throw"; nothing observable to assert. We carry on.

  // Build a real bridge bound to trackId=42, publish it.
  const { api, store } = makeMockApi();
  const trackId = 42;
  const initial = createEmptyPlan(trackId, `track-${trackId}`, 0xabc12345);
  store.set(trackId, initial);
  const bridge = createMemoryBridge({ trackId, api });
  await bridge.loadOrSeed();
  reg.publishActiveBridge(bridge);

  // Right-track routes: notifyPlayCompleted bumps plays + (at ladder boundary)
  // the generation. notifyLove ticks generation when < 3.
  const before = bridge.getState();
  reg.notifyPlayCompleted(trackId);
  if (bridge.getState().plays !== before.plays + 1) {
    fail(`registry: notifyPlayCompleted should bump plays (was ${before.plays}, now ${bridge.getState().plays})`);
  }
  const playsBeforeLove = bridge.getState().plays;
  reg.notifyLove(trackId);
  if (bridge.getState().generation === before.generation) {
    fail('registry: notifyLove at gen<3 must tick generation');
  }
  // notifySkip / notifySectionReturn are routed but don't tick generation.
  reg.notifySkip(trackId);
  reg.notifySectionReturn(trackId);

  // Wrong-track: notify* must NOT mutate the active bridge.
  const stateBeforeWrong = bridge.getState();
  reg.notifyPlayCompleted(999); // not the active bridge's trackId
  reg.notifyLove(999);
  reg.notifySkip(999);
  reg.notifySectionReturn(999);
  const stateAfterWrong = bridge.getState();
  if (
    stateBeforeWrong.plays !== stateAfterWrong.plays ||
    stateBeforeWrong.generation !== stateAfterWrong.generation
  ) {
    fail('registry: wrong-track notify* mutated the active bridge');
  }
  // Sanity: plays did go up by 1 from the right-track notifyPlayCompleted earlier.
  if (bridge.getState().plays !== playsBeforeLove) {
    fail(`registry: plays should be stable post-wrong-track notifies (${playsBeforeLove} vs ${bridge.getState().plays})`);
  }

  // null trackId: cheap no-op (no throw).
  reg.notifyPlayCompleted(null);
  reg.notifyLove(null);
  reg.notifySkip(null);
  reg.notifySectionReturn(null);

  reg.publishActiveBridge(null);
  log.push('registry: routes by trackId match (right=route, wrong=no-op, no-bridge=no-op) ✓');
}

// ─── 10. acquireBridgeForTrack returns cached bridge for same trackId ──────
//
// Same-track remount fast path (finding #6). On a palette/quality/etc remount
// the Visualizer re-runs its effect: acquireBridgeForTrack({trackId: 42})
// returns the SAME bridge instance, preserving in-memory plan + buffered
// learning + counters. releaseBridgeForTrack flushes-and-disposes + drops.
{
  const reg = await import(pathToFileURL(resolve('tmp/eviland-memory-bridge-registry-bundle.mjs')).href);
  reg.__resetBridgeRegistryForTests();

  const { api, store } = makeMockApi();
  const trackId = 55;
  const initial = createEmptyPlan(trackId, `track-${trackId}`, 0xfacefeed);
  store.set(trackId, initial);

  // First mount: acquire, load.
  const b1 = reg.acquireBridgeForTrack({ trackId, api });
  await b1.loadOrSeed();
  if (!b1.getState().hasPlan) fail('acquire: first acquire should load the plan');

  // "Palette change" — second mount with same trackId returns the SAME bridge.
  const b2 = reg.acquireBridgeForTrack({ trackId, api });
  if (b1 !== b2) fail('acquire: same trackId should return the SAME bridge instance');
  if (!b2.getState().hasPlan) fail('acquire: cached bridge should still have its plan');

  // Track change: release flushes + drops; next acquire for a NEW track mints fresh.
  await reg.releaseBridgeForTrack(trackId, 'track-change');
  const b3 = reg.acquireBridgeForTrack({ trackId, api });
  if (b3 === b1) fail('acquire: post-release, acquire for same trackId should mint a fresh bridge');

  // Different trackId never returns the cached one.
  const b4 = reg.acquireBridgeForTrack({ trackId: trackId + 1, api });
  if (b4 === b3) fail('acquire: different trackId must mint a fresh bridge');

  reg.__resetBridgeRegistryForTests();
  log.push('registry: acquire returns cached bridge for same trackId, fresh for new ✓');
}

// ─── 11. flushAndDispose persists once, then is idempotent ─────────────────
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

// ─── 12. LRU cap sweep: over-cap acquire evicts the oldest unprotected entry ─
//
// Leak regression: the Visualizer's cleanup deliberately never releases the
// bridge on unmount (finding #6's same-track-remount survival), so switching
// visualizer MODE away from eviland used to orphan the current track's
// bridge forever. This proves acquireBridgeForTrack caps the registry at
// MAX_CACHED_BRIDGES, evicting the least-recently-acquired entry — but never
// the one just acquired, and never whichever bridge is currently published
// as active — and that the evicted entry's buffered learning still persists
// (flushAndDispose, not a bare drop).
{
  const reg = await import(pathToFileURL(resolve('tmp/eviland-memory-bridge-registry-bundle.mjs')).href);
  const { MAX_CACHED_BRIDGES } = reg;
  reg.__resetBridgeRegistryForTests();

  const { api, store, writeCount } = makeMockApi();
  const base = 500;

  // Oldest entry is published as ACTIVE — it must survive the sweep even
  // though it's the least-recently-acquired when the cap is breached.
  const bActive = reg.acquireBridgeForTrack({ trackId: base, api });
  reg.publishActiveBridge(bActive);

  // Fill the rest of the cap. trackId base+1 gets buffered (dirty) learning
  // so we can prove eviction flushes it rather than silently dropping it.
  const bVictim = reg.acquireBridgeForTrack({ trackId: base + 1, api });
  const victimPlan = createEmptyPlan(base + 1, `track-${base + 1}`, hashSeed(`track-${base + 1}`));
  const victimDirector = makeDirector(victimPlan);
  bVictim.attachDirector(victimDirector);
  victimDirector.setSections([fakeSection(0, 0xf00d)]);
  bVictim.observeSection(fakeSection(0, 0xf00d));

  for (let i = 2; i < MAX_CACHED_BRIDGES; i++) {
    reg.acquireBridgeForTrack({ trackId: base + i, api });
  }
  // Cache is now exactly at cap (MAX_CACHED_BRIDGES entries) — no eviction yet.

  const writesBeforeOverflow = writeCount();
  // One more DISTINCT trackId pushes the cache over cap and triggers the sweep.
  const overflowTrackId = base + MAX_CACHED_BRIDGES;
  reg.acquireBridgeForTrack({ trackId: overflowTrackId, api });
  // flushAndDispose is fire-and-forget; let its promise chain settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  if (writeCount() !== writesBeforeOverflow + 1) {
    fail(`LRU sweep: evicted bridge should have flushed its buffered learning (writes ${writeCount() - writesBeforeOverflow})`);
  }
  if (store.get(base + 1) === undefined) {
    fail('LRU sweep: evicted bridge (base+1) was not persisted before disposal');
  }

  // The evicted trackId (base+1) must mint a FRESH bridge on next acquire.
  const bVictimAgain = reg.acquireBridgeForTrack({ trackId: base + 1, api });
  if (bVictimAgain === bVictim) fail('LRU sweep: evicted trackId should mint a fresh bridge, got the disposed instance');

  // The ACTIVE trackId (base) must be untouched — same instance, never evicted.
  const bActiveAgain = reg.acquireBridgeForTrack({ trackId: base, api });
  if (bActiveAgain !== bActive) fail('LRU sweep: active bridge was evicted despite protection');

  reg.publishActiveBridge(null);
  reg.__resetBridgeRegistryForTests();
  log.push(`LRU sweep: over-cap acquire evicted oldest non-active entry (flushed), active entry protected ✓`);
}

// ─── 13. A love recorded during an in-flight flush is not lost ─────────────
//
// Lost-update repro: flush() takes a snapshot of the plan and, on success,
// used to unconditionally overwrite the live plan with that stale snapshot —
// discarding any counter/lineage mutation that arrived while the write was
// in flight. This proves recordLove() during an in-flight write survives
// in memory AND makes it into the persisted payload via a trailing flush.
{
  const { api, store, similar, writeCount, gateNextWrite } = makeMockApi();
  const trackId = 101;
  similar.set(trackId, []);
  const initial = createEmptyPlan(trackId, `track-${trackId}`, hashSeed(`track-${trackId}`));
  store.set(trackId, initial);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed();
  const director = makeDirector(initial);
  b.attachDirector(director);

  const gate = deferred();
  gateNextWrite(gate.promise);
  const flushPromise = b.flush('manual'); // dispatches a write now blocked on the gate

  b.recordLove(); // mutate WHILE the write above is in flight
  if (b.getState().generation !== 1) fail('lost-love: recordLove should tick generation in memory immediately');

  gate.resolve();
  const ok = await flushPromise;
  if (!ok) fail('lost-love: flush should report success (including any trailing round)');
  const persisted = store.get(trackId);
  if (!persisted || persisted.counters.loves !== 1) {
    fail(`lost-love: persisted loves expected 1, got ${persisted?.counters.loves}`);
  }
  if (writeCount() < 2) {
    fail(`lost-love: expected a trailing write to capture the in-flight love (writes=${writeCount()})`);
  }
  log.push('love recorded mid-flush survives in memory and in the persisted payload ✓');
}

// ─── 14. A section observed during an in-flight write is not lost ──────────
{
  const { api, store, similar, writeCount, gateNextWrite } = makeMockApi();
  const trackId = 102;
  similar.set(trackId, []);
  const initial = createEmptyPlan(trackId, `track-${trackId}`, hashSeed(`track-${trackId}`));
  store.set(trackId, initial);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed();
  const director = makeDirector(initial);
  b.attachDirector(director);

  const gate = deferred();
  gateNextWrite(gate.promise);
  const flushPromise = b.flush('manual');

  // A new section arrives mid-flight — Director learns it and the bridge is
  // told, same as production wiring (Director.onSectionLearn → bridge.observeSection).
  const lateSection = fakeSection(9, 0x9999);
  director.setSections([lateSection]);
  b.observeSection(lateSection);

  gate.resolve();
  const ok = await flushPromise;
  if (!ok) fail('late-section: flush should report success (including any trailing round)');
  const persisted = store.get(trackId);
  const hasLateSection = persisted?.sections.some((s) => s.sectionId === 9);
  if (!hasLateSection) fail('late-section: trailing flush should have persisted the section observed mid-flight');
  if (writeCount() < 2) fail(`late-section: expected a trailing write (writes=${writeCount()})`);
  log.push('section observed mid-flush is captured by a trailing write ✓');
}

// ─── 15. Failed write, then a mutation, then a retry — nothing lost ────────
{
  const { api, store, similar, failNextWrite } = makeMockApi();
  const trackId = 103;
  similar.set(trackId, []);
  const initial = createEmptyPlan(trackId, `track-${trackId}`, hashSeed(`track-${trackId}`));
  store.set(trackId, initial);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed();
  const director = makeDirector(initial);
  b.attachDirector(director);
  director.setSections([fakeSection(0, 0xaaaa)]);
  b.observeSection(fakeSection(0, 0xaaaa));

  failNextWrite();
  const first = await b.flush('manual');
  if (first) fail('retry-after-failure: first flush should report failure');
  if (!b.getState().hasPlan) fail('retry-after-failure: plan should survive a failed write');

  b.recordSkip(); // mutate again after the failed write settles
  const second = await b.flush('manual');
  if (!second) fail('retry-after-failure: retry should succeed');
  const persisted = store.get(trackId);
  if (!persisted || persisted.counters.skips !== 1) {
    fail(`retry-after-failure: persisted skips expected 1, got ${persisted?.counters.skips}`);
  }
  const hasSection = persisted?.sections.some((s) => s.sectionId === 0);
  if (!hasSection) fail('retry-after-failure: section buffered before the failed write should still persist');
  log.push('failed write followed by a mutation and a retry loses nothing ✓');
}

// ─── 16. discard() during an in-flight write blocks resurrection + trailing writes ─
{
  const { api, store, similar, writeCount, gateNextWrite } = makeMockApi();
  const trackId = 104;
  similar.set(trackId, []);
  const initial = createEmptyPlan(trackId, `track-${trackId}`, hashSeed(`track-${trackId}`));
  initial.counters.plays = 3;
  store.set(trackId, initial);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed();
  const director = makeDirector(initial);
  b.attachDirector(director);
  director.setSections([fakeSection(0, 0xbbbb)]);
  b.observeSection(fakeSection(0, 0xbbbb));

  const gate = deferred();
  gateNextWrite(gate.promise);
  const flushPromise = b.flush('manual'); // dispatched, now blocked on the gate

  const writesBeforeDiscard = writeCount();
  b.discard();
  if (b.getState().hasPlan) fail('discard-in-flight: state should read no-plan immediately');

  gate.resolve(); // let the ALREADY-dispatched write settle
  const result = await flushPromise;
  if (result) fail('discard-in-flight: the settling write must not report as a bridge success post-discard');
  if (writeCount() !== writesBeforeDiscard + 1) {
    fail(`discard-in-flight: expected exactly the one already-dispatched write, got ${writeCount() - writesBeforeDiscard}`);
  }
  if (b.getState().hasPlan) fail('discard-in-flight: plan must not be resurrected once the in-flight write resolves');

  // Any further explicit flush is a no-op — no second write, no resurrection.
  const after = await b.flush('manual');
  if (after) fail('discard-in-flight: flush after discard must stay a no-op');
  if (writeCount() !== writesBeforeDiscard + 1) fail('discard-in-flight: no additional write after discard');
  log.push('discard during an in-flight write blocks resurrection and any trailing write ✓');
}

// ─── 17. flushAndDispose during an in-flight write waits for a trailing persist ─
{
  const { api, store, similar, writeCount, gateNextWrite } = makeMockApi();
  const trackId = 105;
  similar.set(trackId, []);
  const initial = createEmptyPlan(trackId, `track-${trackId}`, hashSeed(`track-${trackId}`));
  store.set(trackId, initial);
  const b = createMemoryBridge({ trackId, api });
  await b.loadOrSeed();
  const director = makeDirector(initial);
  b.attachDirector(director);
  director.setSections([fakeSection(0, 0xcccc)]);
  b.observeSection(fakeSection(0, 0xcccc));

  const gate = deferred();
  gateNextWrite(gate.promise);
  const flushPromise = b.flush('dirty-threshold'); // simulate the auto-flush already running

  // A mutation lands after the in-flight write's snapshot but before disposal.
  b.recordSkip();

  const disposePromise = b.flushAndDispose('unmount');
  gate.resolve();

  const flushResult = await flushPromise;
  const disposeResult = await disposePromise;
  if (!flushResult) fail('dispose-mid-flight: original flush should succeed');
  if (!disposeResult) fail('dispose-mid-flight: flushAndDispose should report success (waited for the trailing round)');
  const persisted = store.get(trackId);
  if (!persisted || persisted.counters.skips !== 1) {
    fail(`dispose-mid-flight: persisted skips expected 1, got ${persisted?.counters.skips}`);
  }
  if (writeCount() < 2) fail(`dispose-mid-flight: expected a trailing write to persist the skip (writes=${writeCount()})`);
  log.push('flushAndDispose during an in-flight write waits for the trailing persist ✓');
}

const report = log.join('\n') + '\n' + (pass ? '[eviland-memory-bridge-test] PASS' : '[eviland-memory-bridge-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
