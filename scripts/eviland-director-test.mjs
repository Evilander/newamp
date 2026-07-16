// Runtime unit test for the AI Director (no GPU). Bundles the director + its
// deps for Node and asserts the conducting logic: valid configs per tier,
// distinct looks across sections, chorus recall on section return, and clean
// passthrough when disabled. Run: node scripts/eviland-director-test.mjs
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const RESULT = resolve('tmp/director-test-result.txt');
// Always leave a trace, even if we crash before the assertions run.
writeFileSync(RESULT, '[director-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });
process.on('unhandledRejection', (e) => { writeFileSync(RESULT, 'REJECTION: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-director.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/director-bundle.mjs'), logLevel: 'silent',
});
const { createDirector } = await import(pathToFileURL(resolve('tmp/director-bundle.mjs')).href);

function mockFrame(over = {}) {
  return {
    kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0,
    energy: 0.3, centroid: 0.4, flatness: 0.3, crest: 0.3, rolloff: 0.5,
    width: 0.4, pan: 0, novelty: 0.2, beatPhase: 0, beatConfidence: 0.5, bpm: 120,
    sectionId: 0, sectionChanged: false, sectionReturn: -1,
    sectionFingerprint: null,
    bands: new Array(24).fill(0.2), onsets: [],
    ...over,
  };
}

function settle(d, frameOver, n = 240) {
  let c;
  for (let i = 0; i < n; i++) c = d.update(mockFrame(frameOver), 16.7);
  return c;
}

function valid(c) {
  return !!(c && c.zoom && c.decay && c.waveform && c.mirrorMix &&
    typeof c.spinFromSection === 'boolean' && c.palette &&
    Array.isArray(c.palette.accent));
}

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const d = createDirector({ songId: 'unit-test', enabled: true, drift: 0, rotateMs: 0 });

// Section 0 — calm intro.
d.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.08, novelty: 0.1 }), 16.7);
const c0 = settle(d, { sectionId: 0, energy: 0.08 });
log.push(`c0 archetype=${c0?.archetype} valid=${valid(c0)}`);
if (!valid(c0)) fail('c0 invalid');

// Section 1 — peak/drop.
d.update(mockFrame({ sectionChanged: true, sectionId: 1, energy: 0.85, novelty: 0.6 }), 16.7);
const c1 = settle(d, { sectionId: 1, energy: 0.85 });
log.push(`c1 archetype=${c1?.archetype} valid=${valid(c1)}`);
if (!valid(c1)) fail('c1 invalid');

const distinct = JSON.stringify(c0) !== JSON.stringify(c1);
log.push(`c0 != c1 (sections get distinct looks): ${distinct}`);
if (!distinct) fail('sections produced identical looks');

// Section 2 returns to section 0 → should recall c0's look (chorus rhymes).
d.update(mockFrame({ sectionChanged: true, sectionId: 2, sectionReturn: 0, energy: 0.1 }), 16.7);
const cr = settle(d, { sectionId: 2, energy: 0.1 });
const recalled = JSON.stringify(cr?.zoom) === JSON.stringify(c0?.zoom) &&
  JSON.stringify(cr?.palette) === JSON.stringify(c0?.palette);
log.push(`recall on section return == c0: ${recalled}`);
if (!recalled) fail('section return did not recall earlier look');

// Disabled → passthrough of explicitly set config.
d.setEnabled(false);
d.setCurrent(c1);
const cp = d.update(mockFrame({ sectionChanged: true, sectionId: 3, energy: 0.9 }), 16.7);
const passthrough = JSON.stringify(cp?.zoom) === JSON.stringify(c1?.zoom);
log.push(`disabled passthrough keeps set config: ${passthrough}`);
if (!passthrough) fail('disabled director did not passthrough');

// --- plan §2.6: live config carries _transition during section fades, ---
// --- absent/1 when settled, and absent during intra-section drift ---
{
  const dt = createDirector({ songId: 'transition-test', enabled: true, drift: 0, rotateMs: 0 });
  // First frame at section 0 — Director starts a fade (no prior live).
  let c = dt.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.5 }), 16.7);
  // Mid-fade: _transition should be set and <1.
  let sawMid = false;
  for (let i = 0; i < 20; i++) {
    c = dt.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
    if (typeof c._transition === 'number' && c._transition > 0 && c._transition < 1) { sawMid = true; break; }
  }
  if (!sawMid) fail('Director did not stamp _transition < 1 during a section fade');
  // Settle the fade; _transition should be undefined (the live === target fast-path).
  for (let i = 0; i < 240; i++) c = dt.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  if (c._transition !== undefined) fail(`settled live config must not carry _transition, got ${c._transition}`);
  log.push('crossfade meta: _transition stamped mid-fade, absent when settled');

  // Drift ON, fade settled: _transition must STILL be absent on the drift cache
  // (drift is intra-section breathing, not a section crossfade).
  const dd = createDirector({ songId: 'transition-drift', enabled: true, drift: 0.12, rotateMs: 0 });
  dd.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.5 }), 16.7);
  for (let i = 0; i < 300; i++) dd.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  const drifted = dd.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  if (drifted._transition !== undefined) fail(`drift cache must not carry _transition, got ${drifted._transition}`);
  log.push('crossfade meta: drift never triggers crossfade');
}

// --- timer rotation: with no section changes, the look still rotates ---
{
  const dr = createDirector({ songId: 'rotate-test', enabled: true, rotateMs: 20000, drift: 0 });
  // Opening look.
  dr.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.5 }), 16.7);
  const opener = settle(dr, { sectionId: 0, energy: 0.5 }, 120); // ~2s, settle the fade
  const seen = new Set([JSON.stringify(opener)]);
  // Run ~50s of steady frames with NO section change. The timer floor must
  // force fresh looks anyway.
  let t = 0;
  while (t < 50000) {
    const c = dr.update(mockFrame({ sectionId: 0, energy: 0.5, sectionChanged: false }), 16.7);
    seen.add(JSON.stringify(c));
    t += 16.7;
  }
  log.push(`timer rotation produced ${seen.size} distinct configs over 50s`);
  if (seen.size < 3) fail('timer rotation did not change the look without section boundaries');
}

// --- intra-section drift: a held look breathes (on) / is frozen (off) ---
{
  // Drift ON: live must change across a held section but stay bounded near target.
  const don = createDirector({ songId: 'drift-on', enabled: true, drift: 0.12, rotateMs: 0 });
  don.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.5 }), 16.7);
  const settled = settle(don, { sectionId: 0, energy: 0.5 }, 180); // ~3s, finish the fade
  const zoomStart = settled.zoom.base;
  let zoomMax = zoomStart, zoomMin = zoomStart;
  let t = 0;
  while (t < 5000) {
    const c = don.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
    zoomMax = Math.max(zoomMax, c.zoom.base);
    zoomMin = Math.min(zoomMin, c.zoom.base);
    t += 16.7;
  }
  const moved = zoomMax - zoomMin;
  log.push(`drift on: zoom.base moved ${moved.toFixed(4)} over 5s (start ${zoomStart.toFixed(4)})`);
  if (moved <= 1e-4) fail('drift on: held look did not move');
  if (moved > 0.5) fail('drift on: held look moved too far (runaway, not breathing)');

  // Perf regression: driftCache must be a PERSISTENT scratch object mutated
  // in place via lerpConfigInto, not a fresh lerpConfig() allocation every
  // ~100ms tick. Hold the raw reference across many ticks and assert its
  // IDENTITY stays stable while the breathing values still move — a fresh
  // allocation per tick would fail the identity check.
  const driftRef = don.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  const driftRefZoomStart = driftRef.zoom.base;
  let sameRefThroughout = true;
  let driftRefMoved = false;
  for (let i = 0; i < 60; i++) { // ~1s — spans several DRIFT_TICK_MS recomputes
    const c = don.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
    if (c !== driftRef) sameRefThroughout = false;
    if (Math.abs(c.zoom.base - driftRefZoomStart) > 1e-6) driftRefMoved = true;
  }
  log.push(`drift on: scratch reused (same identity across ticks): ${sameRefThroughout}, values still moved: ${driftRefMoved}`);
  if (!sameRefThroughout) fail('drift on: driftCache is being reallocated instead of reused via lerpConfigInto (perf regression)');
  if (!driftRefMoved) fail('drift on: driftCache values froze (breathing broke)');

  // Drift OFF: live must be referentially stable frame-to-frame in steady state.
  const doff = createDirector({ songId: 'drift-off', enabled: true, drift: 0, rotateMs: 0 });
  doff.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.5 }), 16.7);
  settle(doff, { sectionId: 0, energy: 0.5 }, 180);
  const a = doff.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  const b = doff.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  log.push(`drift off: same reference across frames: ${a === b}`);
  if (a !== b) fail('drift off: steady-state config is not referentially stable (GC fast path broken)');
}

// ─── Plan §1.10 — exportPlan→loadPlan round-trip ────────────────────────────
// Builds a few real boundary configs, exports the plan, replays it on a fresh
// Director, and asserts the first 4 stored seeds + replayed configs match.
{
  const songId = 'roundtrip-song';
  const a = createDirector({ songId, enabled: true, drift: 0, rotateMs: 0 });
  // Fire 4 distinct real section boundaries with varied tiers.
  const tiers = [
    { sectionId: 0, energy: 0.08, novelty: 0.1 },     // calm
    { sectionId: 1, energy: 0.85, novelty: 0.6 },     // climax/drop
    { sectionId: 2, energy: 0.40, novelty: 0.3 },     // steady/lift
    { sectionId: 3, energy: 0.20, novelty: 0.2 },     // calm/steady
  ];
  for (const t of tiers) {
    a.update(mockFrame({ sectionChanged: true, ...t, sectionFingerprint: new Float32Array(24).fill(t.energy) }), 16.7);
    settle(a, { sectionId: t.sectionId, energy: t.energy });
  }
  const exported = a.exportPlan(123_456);
  if (exported.sections.length !== 4) fail(`exportPlan: expected 4 sections, got ${exported.sections.length}`);
  if (exported.songId !== songId) fail(`exportPlan: songId mismatch`);
  if (exported.algoVersion !== 1) fail(`exportPlan: algoVersion expected 1, got ${exported.algoVersion}`);
  if (exported.updatedAt !== 123_456) fail('exportPlan: updatedAt did not pass through');
  // Lineage at generation 0 — the round-trip path doesn't bump generations.
  if (exported.lineage.generation !== 0) fail(`exportPlan: lineage.generation expected 0, got ${exported.lineage.generation}`);

  // Replay into a fresh Director via opts.plan.
  const b = createDirector({ songId, enabled: true, drift: 0, rotateMs: 0, plan: exported });
  // For each section in the plan, fire a sectionReturn pointing back to it and
  // verify the recalled config (after fade settles) matches the exported entry.
  for (let i = 0; i < Math.min(4, exported.sections.length); i++) {
    const s = exported.sections[i];
    // Bring section i into "current" so the next frame can recall it.
    b.update(mockFrame({ sectionChanged: true, sectionId: 100 + i, sectionReturn: s.sectionId, energy: 0.3 }), 16.7);
    const settled = settle(b, { sectionId: 100 + i, energy: 0.3 }, 240);
    // Re-derive the EXPECTED config in isolation to compare against. The look
    // comes from the same seed/archetype/tier, so this is a deterministic check.
    // We can't access the helper directly, but we can compare the archetype:
    // a plan with this seed should always produce the same archetype string.
    if (settled.archetype !== s.archetype) {
      fail(`round-trip: section ${s.sectionId} archetype drifted (expected ${s.archetype}, got ${settled.archetype})`);
    }
  }

  // The Director's exportPlan after replay should report the same primary seeds
  // for the original 4 sections (proving stored seed -> reconstructed config).
  const reExported = b.exportPlan(0);
  const aSeeds = new Map(exported.sections.map((s) => [s.sectionId, s.seed >>> 0]));
  for (const s of reExported.sections) {
    if (!aSeeds.has(s.sectionId)) continue;
    if (aSeeds.get(s.sectionId) !== (s.seed >>> 0)) {
      fail(`round-trip: section ${s.sectionId} seed drifted (${aSeeds.get(s.sectionId)} -> ${s.seed >>> 0})`);
    }
  }
  log.push(`round-trip: ${exported.sections.length} sections exported + replayed deterministically`);
}

// ─── onSectionLearn ONLY fires from real audio boundaries (never timer) ────
// Run ~5 minutes of frames with NO sectionChanged and rotateMs=4000 (so many
// forced rotations happen). The learn callback must NEVER fire.
{
  const events = [];
  const d2 = createDirector({
    songId: 'learn-callback-gate',
    enabled: true,
    drift: 0,
    rotateMs: 4000, // forces ~75 rotations across 5min
    onSectionLearn: (s) => events.push(s),
  });
  // Open with one real boundary so the priming path doesn't conflate. The
  // priming-section path does NOT fire learn (see director.ts) and a real
  // sectionChanged WILL — so we record exactly one event from the opener.
  d2.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.4 }), 16.7);
  settle(d2, { sectionId: 0, energy: 0.4 });
  const eventsAfterOpener = events.length;
  if (eventsAfterOpener !== 1) {
    fail(`onSectionLearn: opener boundary fire count expected 1, got ${eventsAfterOpener}`);
  }
  // Now stream 5 minutes of frames with NO new boundary — only forced timer
  // rotations should happen. The learn callback MUST stay quiet.
  let t = 0;
  while (t < 5 * 60 * 1000) {
    d2.update(mockFrame({ sectionId: 0, energy: 0.4, sectionChanged: false }), 16.7);
    t += 16.7;
  }
  if (events.length !== eventsAfterOpener) {
    fail(`onSectionLearn: timer rotations fired callback (${events.length - eventsAfterOpener} unexpected events)`);
  }
  // A second REAL boundary fires the callback exactly once more.
  d2.update(mockFrame({ sectionChanged: true, sectionId: 1, energy: 0.8 }), 16.7);
  if (events.length !== eventsAfterOpener + 1) {
    fail(`onSectionLearn: second real boundary fire count expected ${eventsAfterOpener + 1}, got ${events.length}`);
  }
  log.push(`onSectionLearn: ${events.length} events from 2 real boundaries (zero from ~75 timer rotations over 5min)`);
}

// ─── Generation 0 seedFor is BYTE-IDENTICAL to pre-change format ───────────
// Plan-less Director and a plan with generation: 0 must produce the same seed
// per (songId, sectionId, rotation), so existing songs render byte-identically.
{
  const songId = 'gen-zero-bytewise';
  const plain = createDirector({ songId, enabled: true, drift: 0, rotateMs: 0 });
  plain.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.3 }), 16.7);
  settle(plain, { sectionId: 0, energy: 0.3 });
  const plainPlan = plain.exportPlan(0);
  const plainSeed0 = plainPlan.sections.find((s) => s.sectionId === 0)?.seed >>> 0;

  // Build a fresh plan with explicit generation:0 lineage + non-default rootSeed.
  const seededPlan = {
    schema: 1, algoVersion: 1, trackId: 42, songId, updatedAt: 0,
    counters: { plays: 0, skips: 0, loves: 0, sectionReturns: 0 },
    lineage: { rootSeed: 0xdeadbeef >>> 0, ancestors: [], generation: 0, evolutionLog: [] },
    sections: [],
  };
  const withPlan = createDirector({ songId, enabled: true, drift: 0, rotateMs: 0, plan: seededPlan });
  withPlan.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.3 }), 16.7);
  settle(withPlan, { sectionId: 0, energy: 0.3 });
  const planSeed0 = withPlan.exportPlan(0).sections.find((s) => s.sectionId === 0)?.seed >>> 0;

  if (plainSeed0 !== planSeed0) {
    fail(`gen-0 byte-equal: plain seed ${plainSeed0} != gen-0 seed ${planSeed0} (lineage salt leaked at generation 0)`);
  }
  log.push(`gen-0 byte-equal seed: ${plainSeed0 >>> 0}`);

  // Sanity: generation 1 with the SAME rootSeed MUST differ from generation 0
  // (the salt kicks in). This proves the salt is non-trivial when armed.
  const evolvedPlan = { ...seededPlan, lineage: { ...seededPlan.lineage, generation: 1 } };
  const evolved = createDirector({ songId, enabled: true, drift: 0, rotateMs: 0, plan: evolvedPlan });
  evolved.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.3 }), 16.7);
  settle(evolved, { sectionId: 0, energy: 0.3 });
  const gen1Seed0 = evolved.exportPlan(0).sections.find((s) => s.sectionId === 0)?.seed >>> 0;
  if (gen1Seed0 === planSeed0) {
    fail(`generation salt: gen-1 produced the same seed as gen-0 (salt has no effect)`);
  }
  log.push(`gen-1 seed differs from gen-0 (lineage salt active): gen0=${planSeed0 >>> 0} gen1=${gen1Seed0 >>> 0}`);
}

// ─── algoVersion mismatch never consumes stored seeds ───────────────────────
// A plan with algoVersion=999 must NOT inject its stored seeds into reset(); a
// fresh re-derivation should occur, and exportPlan after reset shows a different
// seed than what the stale plan claimed.
{
  const songId = 'stale-algo-song';
  const stalePlan = {
    schema: 1, algoVersion: 999, trackId: 7, songId, updatedAt: 0,
    counters: { plays: 0, skips: 0, loves: 0, sectionReturns: 0 },
    lineage: { rootSeed: 0xcafebabe >>> 0, ancestors: [], generation: 0, evolutionLog: [] },
    sections: [
      {
        sectionId: 0,
        fingerprint: new Array(24).fill(0.1),
        seed: 0xabad1dea >>> 0, // a seed the current algorithm would NEVER mint
        archetype: 'liquid',
        tier: 'calm',
        rotationIndex: 0,
        observedCount: 5,
        firstSeenAt: 0,
        lastSeenAt: 0,
      },
    ],
  };
  const d3 = createDirector({ songId, enabled: true, drift: 0, rotateMs: 0, plan: stalePlan });
  // Fire a real boundary so the Director mints its OWN seed (the stale one was rejected).
  d3.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.4 }), 16.7);
  settle(d3, { sectionId: 0, energy: 0.4 });
  const replayed = d3.exportPlan(0);
  const seed0 = replayed.sections.find((s) => s.sectionId === 0)?.seed >>> 0;
  if (seed0 === (0xabad1dea >>> 0)) {
    fail('algoVersion-mismatch: stored seed leaked into export (mismatch gate broken)');
  }
  log.push(`algoVersion mismatch: stale seed rejected, fresh seed = ${seed0 >>> 0}`);
}

// ─── reset() without subsequent loadPlan must produce virgin-track behavior ─
//
// Regression test for finding #3 of the pre-release review. The previous
// reset() implementation re-ran repopulateFromPlan() using the closure-scoped
// pendingPlan from the prior track, leaking the prior song's seeds into the
// new song's sections map and salting the new song's seeds with the prior
// lineage. The fix is: reset() nulls pendingPlan + clears lineage/counters/
// neighbor to virgin defaults, and only loadPlan() can re-arm a plan.
//
// This test loads a plan into a Director, fires section boundaries, exports
// (proving the plan took effect), then reset()s WITHOUT calling loadPlan()
// and verifies the next exportPlan looks like a virgin Director's would for
// the same songId (no inherited lineage, no inherited sections, no inherited
// counters, no inherited neighborSeed).
{
  const songIdA = 'planned-track-A';
  const planA = {
    schema: 1, algoVersion: 1, trackId: 7, songId: songIdA, updatedAt: 0,
    counters: { plays: 25, skips: 2, loves: 3, sectionReturns: 6 },
    lineage: { rootSeed: 0xcafef00d >>> 0, ancestors: [0x11111111, 0x22222222], generation: 2, evolutionLog: [] },
    neighborSeed: { fromTrackId: 99, score: 0.95, at: 1700000000000 },
    sections: [
      {
        sectionId: 0,
        fingerprint: new Array(24).fill(0.3),
        seed: 0xdeadbeef >>> 0,
        archetype: 'liquid',
        tier: 'calm',
        rotationIndex: 0,
        observedCount: 4,
        firstSeenAt: 0,
        lastSeenAt: 0,
      },
    ],
  };
  const dPlanned = createDirector({ songId: songIdA, enabled: true, drift: 0, rotateMs: 0, plan: planA });
  // Sanity: the plan is in effect — lineage.generation = 2.
  const exportedWithPlan = dPlanned.exportPlan(0);
  if (exportedWithPlan.lineage.generation !== 2) {
    fail(`pre-reset: planned director should report generation=2, got ${exportedWithPlan.lineage.generation}`);
  }
  if (exportedWithPlan.counters.plays !== 25) fail('pre-reset: plays should be 25');
  if (exportedWithPlan.lineage.rootSeed !== (0xcafef00d >>> 0)) {
    fail(`pre-reset: rootSeed should be 0xcafef00d, got ${exportedWithPlan.lineage.rootSeed.toString(16)}`);
  }

  // Now reset() to a NEW songId without a subsequent loadPlan call.
  const songIdB = 'plan-less-track-B';
  dPlanned.reset(songIdB);

  // exportPlan after reset must show virgin-track defaults for songIdB.
  const exportedAfterReset = dPlanned.exportPlan(0);
  if (exportedAfterReset.songId !== songIdB) {
    fail(`reset: songId should be '${songIdB}', got '${exportedAfterReset.songId}'`);
  }
  if (exportedAfterReset.lineage.generation !== 0) {
    fail(`reset: lineage.generation should be 0 (virgin), got ${exportedAfterReset.lineage.generation}`);
  }
  if (exportedAfterReset.lineage.ancestors.length !== 0) {
    fail(`reset: lineage.ancestors should be empty, got ${exportedAfterReset.lineage.ancestors.length}`);
  }
  if (exportedAfterReset.counters.plays !== 0) {
    fail(`reset: counters.plays should be 0, got ${exportedAfterReset.counters.plays}`);
  }
  if (exportedAfterReset.counters.loves !== 0) fail(`reset: counters.loves should be 0`);
  if (exportedAfterReset.neighborSeed !== undefined) fail('reset: neighborSeed must be cleared');
  if (exportedAfterReset.sections.length !== 0) {
    fail(`reset: sections should be empty (no plan replay), got ${exportedAfterReset.sections.length}`);
  }
  if (exportedAfterReset.trackId !== 0) {
    fail(`reset: trackId should be 0 (no plan bound), got ${exportedAfterReset.trackId}`);
  }
  // rootSeed should equal hashSeed(songIdB) — same as a virgin Director for songIdB.
  const dVirgin = createDirector({ songId: songIdB, enabled: true, drift: 0, rotateMs: 0 });
  const virginExport = dVirgin.exportPlan(0);
  if (exportedAfterReset.lineage.rootSeed !== virginExport.lineage.rootSeed) {
    fail(
      `reset: rootSeed differs from virgin Director's for same songId ` +
      `(reset=${exportedAfterReset.lineage.rootSeed}, virgin=${virginExport.lineage.rootSeed})`,
    );
  }

  // Drive a real boundary; the seed minted for sectionId=0 must EQUAL the
  // virgin Director's seed for the same songId+sectionId — i.e., no lineage
  // salt leaked from track A's generation=2 plan.
  dPlanned.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.3 }), 16.7);
  settle(dPlanned, { sectionId: 0, energy: 0.3 });
  dVirgin.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.3 }), 16.7);
  settle(dVirgin, { sectionId: 0, energy: 0.3 });
  const seedPlanned = dPlanned.exportPlan(0).sections.find((s) => s.sectionId === 0)?.seed >>> 0;
  const seedVirgin = dVirgin.exportPlan(0).sections.find((s) => s.sectionId === 0)?.seed >>> 0;
  if (seedPlanned !== seedVirgin) {
    fail(
      `reset: plan-bleed leaked into reset Director (seed=${seedPlanned} vs virgin=${seedVirgin}). ` +
      `This is the regression for finding #3.`,
    );
  }
  log.push(`reset: virgin behavior after reset without loadPlan (rootSeed=${exportedAfterReset.lineage.rootSeed}, seed0=${seedPlanned})`);
}

// ─── deferPrimingFrames suppresses first-update mint until loadPlan or budget ─
//
// Coverage for finding #9: when the caller knows a loadPlan IPC is in flight,
// it can ask the Director to hold the first-ever fresh-mint for a bounded
// number of frames. loadPlan() opens the gate immediately. Budget expiry
// proceeds with the fresh mint as before.
{
  // Without defer: first update mints a section immediately.
  const dNoDefer = createDirector({ songId: 'no-defer', enabled: true, drift: 0, rotateMs: 0 });
  dNoDefer.update(mockFrame({ sectionChanged: false, sectionId: 0, energy: 0.4 }), 16.7);
  const sectionsNoDefer = dNoDefer.exportPlan(0).sections.length;
  if (sectionsNoDefer !== 1) {
    fail(`defer: no-defer Director should have 1 section after first update, got ${sectionsNoDefer}`);
  }

  // With defer=10, first 10 updates suppress the priming mint.
  const dDefer = createDirector({ songId: 'with-defer', enabled: true, drift: 0, rotateMs: 0, deferPrimingFrames: 10 });
  for (let i = 0; i < 5; i++) {
    dDefer.update(mockFrame({ sectionChanged: false, sectionId: 0, energy: 0.4 }), 16.7);
  }
  if (dDefer.exportPlan(0).sections.length !== 0) {
    fail('defer: sections should still be empty during defer window');
  }
  // Run past the budget; the mint should fire.
  for (let i = 0; i < 20; i++) {
    dDefer.update(mockFrame({ sectionChanged: false, sectionId: 0, energy: 0.4 }), 16.7);
  }
  if (dDefer.exportPlan(0).sections.length !== 1) {
    fail(`defer: after budget expires, priming should mint a section (got ${dDefer.exportPlan(0).sections.length})`);
  }

  // With defer=30 + loadPlan during the window: gate opens immediately, next
  // update mints under the LOADED lineage (not default).
  const planAt5 = {
    schema: 1, algoVersion: 1, trackId: 11, songId: 'with-defer-load', updatedAt: 0,
    counters: { plays: 0, skips: 0, loves: 0, sectionReturns: 0 },
    lineage: { rootSeed: 0xabad1dea >>> 0, ancestors: [], generation: 1, evolutionLog: [] },
    sections: [],
  };
  const dLoaded = createDirector({ songId: 'with-defer-load', enabled: true, drift: 0, rotateMs: 0, deferPrimingFrames: 30 });
  // 5 frames before plan lands — no mint yet.
  for (let i = 0; i < 5; i++) {
    dLoaded.update(mockFrame({ sectionChanged: false, sectionId: 0, energy: 0.4 }), 16.7);
  }
  if (dLoaded.exportPlan(0).sections.length !== 0) {
    fail('defer+load: sections should be empty before plan lands');
  }
  // Plan arrives.
  dLoaded.loadPlan(planAt5);
  // Next update — gate opens, priming mints under generation=1 lineage.
  dLoaded.update(mockFrame({ sectionChanged: false, sectionId: 0, energy: 0.4 }), 16.7);
  const afterLoad = dLoaded.exportPlan(0);
  if (afterLoad.sections.length !== 1) {
    fail(`defer+load: after loadPlan, next update should mint a section (got ${afterLoad.sections.length})`);
  }
  if (afterLoad.lineage.generation !== 1) {
    fail(`defer+load: lineage should reflect loaded plan (got generation=${afterLoad.lineage.generation})`);
  }
  log.push(`defer: priming suppressed during window, opens on loadPlan or budget expiry`);
}

const report = log.join('\n') + '\n' + (pass ? '[director-test] PASS' : '[director-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
