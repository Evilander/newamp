// End-to-end smoke for "Eviland Remembers Your Library" — proves the bridge
// learns sections, persists through LibraryStore (real sql.js), and recalls
// the same lineage + seeds after a LibraryStore close/reopen (the persistence
// equivalent of an app restart — the blueprint's "restart-and-recall" gate).
//
// Why not a full Electron-UI smoke? The on-screen visualizer needs a real
// audio output device + 30s of audible playback to fire reactor boundaries —
// CI workers don't have either. Instead this smoke drives the SAME bridge +
// Director the renderer uses, fed by the SAME reactor, with synthetic FFT
// bytes (the proven pattern from scripts/eviland-smoke.mjs) shaped to mimic
// 3 tonally-contrasting 10s segments so the reactor actually fires structural
// section boundaries. Then we close the DB and reopen it — if the plan + seeds
// survive, persistence works. If the Director reloads them and produces the
// same archetype/seed for the recalled section, recall works.
//
// Counters asserted:
//   - ≥1 visual-memory DB write per completed track (we count IPC equivalents:
//     bridge.flush() success returns).
//   - exactly one persisted plan with ≥1 section.
//   - plan survives DB close/reopen (the "restart" proof).
//   - Director created with the persisted plan re-derives the same seed for
//     the same sectionId (recall proof).
//
// Run: npm run smoke:eviland-memory
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'eviland-memory-smoke');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

// ─── Bundle the bridge, director, reactor, types, randomizer for Node ───────
const bundles = [
  { name: 'bridge', entry: 'src/visualizer/eviland-memory-bridge.ts' },
  { name: 'director', entry: 'src/visualizer/eviland-director.ts' },
  { name: 'reactor', entry: 'src/visualizer/eviland-audio.ts' },
  { name: 'types', entry: 'src/visualizer/eviland-memory-types.ts' },
  { name: 'rng', entry: 'src/visualizer/eviland-rng.ts' },
];

const mods = {};
for (const b of bundles) {
  const out = join(smokeRoot, `${b.name}.mjs`);
  await build({
    entryPoints: [resolve(repoRoot, b.entry)],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile: out, logLevel: 'silent',
  });
  mods[b.name] = await import(pathToFileURL(out).href);
}

const { createMemoryBridge } = mods.bridge;
const { createDirector } = mods.director;
const { createEvilandReactor } = mods.reactor;
const { hashSeed } = mods.rng;

// ─── Open a real LibraryStore + seed it with a track row ────────────────────
const library = await LibraryStore.open(dbPath);
// Use the lower-level db.run since we don't need a Scanner — we just need a row
// for our trackId. Mirror dna-smoke's "we add a track" pattern via a raw insert.
const trackId = 1;
library.db.run(
  `INSERT OR REPLACE INTO tracks
   (id, path, title, artist, album, album_artist, mtime, has_art, loved, rating, avoid_auto_play, play_count, skip_count)
   VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
  [trackId, '/eviland-memory-smoke/fixture.wav', 'Memory Smoke', 'Eviland QA', 'Memory Album', 'Eviland QA', Date.now()],
);

// ─── Build an in-process IPC mock the bridge can consume ────────────────────
// In production the bridge talks to window.newamp; the renderer's IPC just
// forwards into LibraryStore. We dial straight into the LibraryStore here so
// we're exercising the REAL persistence path (not a fake store).
let writeCount = 0;
const api = {
  async getTrackVisualMemory(id) { return library.getTrackVisualMemory(id); },
  async setTrackVisualMemory(id, plan) {
    writeCount++;
    return library.setTrackVisualMemory(id, plan);
  },
  async clearTrackVisualMemory(id) { return library.clearTrackVisualMemory(id); },
  async findSimilarTracks(id, limit) { return library.findSimilarTracks(id, limit ?? 20); },
};

// ─── Construct the bridge + Director, wire them like the Visualizer does ────
const bridge = createMemoryBridge({ trackId, api });
const director = createDirector({
  songId: `track-${trackId}`,
  onSectionLearn: (s) => bridge.observeSection(s),
  // Match production: drift on (12%), rotate floor at 20s. Doesn't materially
  // affect this smoke since we drive boundaries via sectionChanged, but keeps
  // the runtime shape honest to what ships.
});
bridge.attachDirector(director);

// First load: track is empty → null. No DNA neighbor either.
const initial = await bridge.loadOrSeed();
assert.equal(initial, null, 'first launch: no plan should exist for a brand-new track');

// ─── Drive the reactor with synthetic FFT bytes that fire 3 boundaries ──────
// Reactor sees only frequency-domain bytes per frame. We synthesize spectra
// shaped like 3 tonally distinct passages (low/mid/high-dominant), each ~10s
// at 60fps, with sharp onset transients on each "beat" so the reactor
// detects real structural boundaries (not just energy ramps).
const sampleRate = 48000;
const fftSize = 2048;
const binCount = fftSize / 2;
const reactor = createEvilandReactor({ sampleRate, fftSize, binCount });

const freq = new Uint8Array(binCount);
const onsetFreq = new Uint8Array(binCount);
const leftFreq = new Uint8Array(binCount);
const rightFreq = new Uint8Array(binCount);

function binAt(hz) {
  return Math.min(binCount - 1, Math.max(0, Math.round(hz * fftSize / sampleRate)));
}
function synth(buf, peaks) {
  buf.fill(2);
  for (const [hz, level] of peaks) {
    const c = binAt(hz);
    for (let k = -3; k <= 3; k++) {
      const i = c + k;
      if (i >= 0 && i < binCount) buf[i] = Math.max(buf[i], Math.round(level * 255 * Math.exp(-k * k * 0.3)));
    }
  }
}

// Three contrasting 10s passages — the reactor segments on energy/centroid
// shifts so changing the spectral COG between passages forces a real boundary.
const passages = [
  // Calm low: bass + a touch of mid, no top end.
  { peaks: [[60, 0.55], [110, 0.45]], hatEvery: 6, kickEvery: 12 },
  // Bright mid/high: vocal-band + hat-band heavy, low quieter.
  { peaks: [[900, 0.75], [3500, 0.6]], hatEvery: 2, kickEvery: 8 },
  // Drop: kick-driven, full-spectrum punch.
  { peaks: [[60, 1.0], [200, 0.7], [900, 0.5], [6000, 0.7]], hatEvery: 1, kickEvery: 4 },
];

const dtMs = 16.7;
let now = 0;
let boundaryCount = 0;
let lastSectionId = -1;
for (let p = 0; p < passages.length; p++) {
  const pa = passages[p];
  const framesInPassage = Math.round(10000 / dtMs); // ~10s
  for (let i = 0; i < framesInPassage; i++) {
    const kick = i % pa.kickEvery === 0;
    const hat = i % pa.hatEvery === 0;
    const peaks = pa.peaks.slice();
    if (kick) peaks.push([60, 1.0]);
    if (hat) peaks.push([10000, 0.6]);
    synth(freq, peaks);
    synth(onsetFreq, kick || hat ? peaks : pa.peaks);
    synth(leftFreq, peaks.filter(([h]) => h < 5000));
    synth(rightFreq, peaks);
    const frame = reactor.analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, now);
    director.update(frame, dtMs);
    if (frame.sectionChanged && frame.sectionId !== lastSectionId) {
      lastSectionId = frame.sectionId;
      boundaryCount++;
    }
    now += dtMs;
  }
}

// Reactor must have produced ≥1 real section boundary across the contrasting
// passages — otherwise the bridge had no fingerprints to learn.
assert.ok(boundaryCount >= 1, `reactor must fire ≥1 section boundary across 3 contrasting passages (got ${boundaryCount})`);

// Track completed: simulate a finished play. This is what the player store
// would call on track-end.
bridge.recordCompletedPlay();

// Flush + dispose like the Visualizer's unmount path would.
const initialWriteCount = writeCount;
const flushed = await bridge.flushAndDispose('track-end');
assert.equal(flushed, true, 'flushAndDispose should succeed when sections were learned');
const writesThisPlay = writeCount - initialWriteCount;
// Bridge must NOT write more than once per completed play in the simple case
// (no visibility-hidden + no LEARN_FLUSH_THRESHOLD interactions — boundaries are
// few). One write per completed track is the upper bound asserted by §1.10.
// However an auto-flush at the dirty threshold can land mid-play. We assert
// ≤2 to allow that, ≥1 to prove we wrote at all.
assert.ok(writesThisPlay >= 1, 'at least one DB write per completed track');
assert.ok(writesThisPlay <= 2, `≤2 DB writes per completed track (got ${writesThisPlay})`);

// ─── Read back from the SAME library: the plan must be there ────────────────
const persisted = library.getTrackVisualMemory(trackId);
assert.ok(persisted, 'plan should be persisted after flush');
assert.equal(persisted.trackId, trackId);
assert.equal(persisted.songId, `track-${trackId}`);
assert.ok(persisted.sections.length >= 1, `persisted plan should have ≥1 section, got ${persisted.sections.length}`);
// The algorithm version moves whenever the randomizer's safe ranges change (see
// test:algo-version-guard); the smoke only cares that a real one was stamped.
assert.ok(Number.isInteger(persisted.algoVersion) && persisted.algoVersion >= 1, `persisted plan should carry a positive algoVersion, got ${persisted.algoVersion}`);
assert.ok(persisted.updatedAt > 0);
const firstSection = persisted.sections[0];
assert.ok(typeof firstSection.seed === 'number');
assert.ok(typeof firstSection.archetype === 'string');
assert.equal(firstSection.fingerprint.length, 24);

// ─── Restart: close + reopen the library (the persistence-layer "restart") ──
library.close();
const library2 = await LibraryStore.open(dbPath);

// New IPC mock pointing at the reopened library.
let restartWriteCount = 0;
const api2 = {
  async getTrackVisualMemory(id) { return library2.getTrackVisualMemory(id); },
  async setTrackVisualMemory(id, plan) {
    restartWriteCount++;
    return library2.setTrackVisualMemory(id, plan);
  },
  async clearTrackVisualMemory(id) { return library2.clearTrackVisualMemory(id); },
  async findSimilarTracks(id, limit) { return library2.findSimilarTracks(id, limit ?? 20); },
};

const recalled = await api2.getTrackVisualMemory(trackId);
assert.ok(recalled, 'plan must survive DB close/reopen (the restart proof)');
assert.equal(recalled.sections.length, persisted.sections.length, 'section count must survive restart');
assert.equal(recalled.sections[0].seed, persisted.sections[0].seed, 'primary section seed must survive restart');
assert.equal(recalled.lineage.rootSeed, persisted.lineage.rootSeed, 'rootSeed must survive restart');
assert.equal(recalled.lineage.generation, persisted.lineage.generation, 'generation must survive restart');

// ─── Recall proof: feed the plan back into a fresh Director ────────────────
// Construct the second-launch bridge + director the way the Visualizer would
// on track load. Wire plan → loadPlan, then assert exportPlan shows the SAME
// primary seed for the originally-known sectionId (Director recalled it).
const bridge2 = createMemoryBridge({ trackId, api: api2 });
const director2 = createDirector({
  songId: `track-${trackId}`,
  onSectionLearn: (s) => bridge2.observeSection(s),
});
bridge2.attachDirector(director2);
const reloadedPlan = await bridge2.loadOrSeed();
assert.ok(reloadedPlan, 'bridge.loadOrSeed must surface the persisted plan on restart');
director2.loadPlan(reloadedPlan);

// Snapshot the Director's exported sections immediately after loadPlan — these
// are the plan's sections re-derived into the in-memory map. The primary seed
// of the first persisted section MUST match what the persisted plan claimed.
const restoredExport = director2.exportPlan(0);
const matchedSection = restoredExport.sections.find((s) => s.sectionId === persisted.sections[0].sectionId);
assert.ok(matchedSection, 'Director must reload the persisted sectionId after loadPlan');
assert.equal(
  matchedSection.seed >>> 0,
  persisted.sections[0].seed >>> 0,
  'Director must recall the EXACT primary seed for the persisted section after restart',
);
assert.equal(
  matchedSection.archetype,
  persisted.sections[0].archetype,
  'Director must recall the EXACT archetype for the persisted section after restart',
);

// Tidy up — disposing the restart bridge should be a no-op (no buffered work).
const disposeOk = await bridge2.flushAndDispose('unmount');
assert.equal(disposeOk, false, 'restart-bridge dispose with no observed sections should no-op');
assert.equal(restartWriteCount, 0, 'restart path must not write back to the DB until the user observes new sections');

// ─── TRACK-SWITCH PLAN-BLEED REGRESSION (findings #3/#4) ────────────────────
//
// Drive the second-launch director through track 1 → switch to plan-less
// track 2 → assert that track 2's behavior is virgin: any plan written for
// track 2 contains NO track-1 seeds, AND track 2's first-boundary seed equals
// what a brand-new Director would produce for the same songId+sectionId
// (proving no lineage salt leaked from track 1).
//
// This is the regression test for the closure-scoped pendingPlan bleed at
// reset() time and the Visualizer initial loadOrSeed race. The Director-side
// fix (reset() clears pendingPlan + lineage to virgin defaults) is the
// load-bearing change; the bridge belt-and-suspenders pass (Visualizer.tsx)
// always calls loadPlan(createEmptyPlan(...)) when loadOrSeed yields null.
const trackId2 = 2;
library2.db.run(
  `INSERT OR REPLACE INTO tracks
   (id, path, title, artist, album, album_artist, mtime, has_art, loved, rating, avoid_auto_play, play_count, skip_count)
   VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
  [trackId2, '/eviland-memory-smoke/fixture-track-2.wav', 'Memory Smoke Track 2', 'Eviland QA', 'Memory Album', 'Eviland QA', Date.now()],
);

// Compute the seed a VIRGIN Director would mint for track 2's sectionId=0
// using only the public hashSeed (same formula seedFor() uses at generation 0).
// This is the "what should the seed look like if no plan bled in" reference.
function virginSeedFor(songId, sectionId) {
  return hashSeed(`${songId}::section::${sectionId}`) >>> 0;
}

// Continue with director2 (which has track 1's plan loaded). Switch it to
// track 2 via reset() + loadPlan(createEmptyPlan) — the production path.
director2.reset(`track-${trackId2}`);
// Belt-and-suspenders: simulate the Visualizer always calling loadPlan with
// an empty plan when loadOrSeed yields null. createEmptyPlan needs a
// rootSeed; use the same formula as createEmptyPlan when called by the
// Visualizer in production.
const { createEmptyPlan } = mods.types;
director2.loadPlan(createEmptyPlan(trackId2, `track-${trackId2}`, hashSeed(`track-${trackId2}`)));

// Fire a real section boundary on the freshly-reset director and snapshot.
// We don't drive 30 seconds of synthetic audio here — just one boundary is
// enough to prove no plan-bleed.
const evFrame2 = {
  kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0,
  energy: 0.3, centroid: 0.4, flatness: 0.3, crest: 0.3, rolloff: 0.5,
  width: 0.4, pan: 0, novelty: 0.2, beatPhase: 0, beatConfidence: 0.5, bpm: 120,
  sectionId: 0, sectionChanged: true, sectionReturn: -1,
  sectionFingerprint: new Float32Array(24).fill(0.3),
  bands: new Array(24).fill(0.2), onsets: [],
};
director2.update(evFrame2, 16.7);
// Settle the fade so the section is fully written.
for (let i = 0; i < 240; i++) {
  director2.update({ ...evFrame2, sectionChanged: false }, 16.7);
}

const track2Export = director2.exportPlan(0);

// Track 2 export must have its own songId + virgin lineage.
assert.equal(track2Export.songId, `track-${trackId2}`, 'track 2 export must have its own songId');
assert.equal(track2Export.lineage.generation, 0, 'track 2 lineage must be virgin (generation 0)');
assert.equal(track2Export.lineage.ancestors.length, 0, 'track 2 lineage must have no ancestors');
assert.equal(track2Export.counters.plays, 0, 'track 2 counters must be virgin');
assert.equal(track2Export.counters.loves, 0, 'track 2 counters must be virgin');

// Critical assertion: no section in track 2's export may share a seed with
// track 1's persisted plan. This is the "track A's chorus visually rhymes
// with track B's chorus" regression for finding #3.
const track1Seeds = new Set(persisted.sections.map((s) => s.seed >>> 0));
for (const s of track2Export.sections) {
  assert.ok(
    !track1Seeds.has(s.seed >>> 0),
    `track 2 section seed ${s.seed} matched a track 1 seed (cross-track plan bleed)`,
  );
}

// And: track 2's section 0 seed must equal a virgin Director's seed for the
// same songId+sectionId (i.e., the seedFor() path produced the byte-identical
// pre-memory key, proving lineage.generation === 0 with no salt).
const track2Section0 = track2Export.sections.find((s) => s.sectionId === 0);
assert.ok(track2Section0, 'track 2 should have a section 0 after the boundary');
const expectedVirginSeed = virginSeedFor(`track-${trackId2}`, 0);
assert.equal(
  track2Section0.seed >>> 0,
  expectedVirginSeed,
  `track 2 section 0 seed ${track2Section0.seed} differs from virgin seed ${expectedVirginSeed} (lineage salt leaked)`,
);

library2.close();

console.log(JSON.stringify({
  ok: true,
  boundaryCount,
  persistedSections: persisted.sections.length,
  persistedRootSeed: persisted.lineage.rootSeed,
  persistedGeneration: persisted.lineage.generation,
  writesPerCompletedPlay: writesThisPlay,
  recalledSeed: matchedSection.seed >>> 0,
  recalledArchetype: matchedSection.archetype,
  // Track-switch regression for findings #3/#4: track 2 produced virgin seed.
  trackSwitch: {
    track2RootSeed: track2Export.lineage.rootSeed,
    track2Generation: track2Export.lineage.generation,
    track2Section0Seed: track2Section0.seed >>> 0,
    expectedVirginSeed,
  },
}, null, 2));
