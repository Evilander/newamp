# Eviland Evolving Variety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Eviland visualizer visibly evolve like MilkDrop — a timer floor forces fresh looks on an interval, the section detector fires on real musical changes more often, and held looks gently drift instead of freezing.

**Architecture:** Three changes behind existing module boundaries. (A) Loosen the structure detector's tuning constants in `eviland-audio.ts`. (B) Add a timer-rotation floor to the Director (`eviland-director.ts`) that forces a new look when structure hasn't changed it in ~20s, keyed by a monotonic rotation index so the look sequence stays deterministic. (C) Add throttled intra-section drift so a held look slowly breathes target↔driftTarget and back. All three default-on; neither `createDirector` call site changes.

**Tech Stack:** TypeScript, zero-dep visualizer modules. Tests are esbuild-bundled Node harnesses (no test runner). `packages/eviland-core` is a synced copy enforced by `sync.mjs --check` in prebuild.

---

## File Structure

- **Modify** `src/visualizer/eviland-audio.ts` — extract structure-detection tuning into named constants inside `createEvilandReactor`, slow the recent-average EMA, relax the time guards. (~lines 164, 400, 403)
- **Modify** `src/visualizer/eviland-director.ts` — new `DirectorOptions` (`rotateMs`, `rotateJitterPct`, `drift`); timer-rotation state + `onForcedRotation`; drift state + drift branch in `recomputeLive`; reset hooks in `startFade`/`onSectionBoundary`/`reset`/`setCurrent`; honest header comment.
- **Create** `scripts/eviland-audio-test.mjs` — Node harness driving `createEvilandReactor` with a synthetic two-phase spectrum; asserts a boundary fires within the relaxed window.
- **Modify** `scripts/eviland-director-test.mjs` — isolate existing assertions with `drift:0, rotateMs:0`; add timer-rotation and drift tests.
- **Sync** `packages/eviland-core/src/*` via `node packages/eviland-core/sync.mjs` (do not hand-edit).

Work happens on branch `eviland-evolving-variety` (already created; spec already committed there).

---

## Task 1: Detector fires more readily (`eviland-audio.ts`)

**Files:**
- Create: `scripts/eviland-audio-test.mjs`
- Modify: `src/visualizer/eviland-audio.ts` (add constants after line 164; edit lines 400 and 403)

- [ ] **Step 1: Write the failing detector test**

Create `scripts/eviland-audio-test.mjs`:

```js
// Runtime unit test for the structure detector in the Eviland audio reactor
// (no GPU, no audio hardware). Bundles eviland-audio.ts for Node, feeds a
// synthetic two-phase spectrum (bass-heavy → treble-heavy), and asserts a
// section boundary fires within the relaxed detection window.
// Run: node scripts/eviland-audio-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/audio-test-result.txt');
writeFileSync(RESULT, '[audio-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-audio.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/audio-bundle.mjs'), logLevel: 'silent',
});
const { createEvilandReactor } = await import(pathToFileURL(resolve('tmp/audio-bundle.mjs')).href);

const BINS = 1024;
const reactor = createEvilandReactor({ sampleRate: 48000, fftSize: 2048, binCount: BINS });

// Phase A: energy in the low half of the spectrum. Phase B: energy in the high
// half. The abrupt swap drives the band-vector cosine novelty hard.
function spectrum(highHalf) {
  const buf = new Uint8Array(BINS);
  const lo = highHalf ? BINS / 2 : 0;
  const hi = highHalf ? BINS : BINS / 2;
  for (let i = lo; i < hi; i++) buf[i] = 200;
  return buf;
}

const DT = 16.7;
let now = 0;
let firstBoundaryAt = -1;
// Run 0..8000ms: bass-heavy until 4000ms, then treble-heavy.
for (let i = 0; now <= 8000; i++) {
  const highHalf = now >= 4000;
  const f = spectrum(highHalf);
  const frame = reactor.analyze(f, f, f, f, DT, now);
  if (frame.sectionChanged && firstBoundaryAt < 0) firstBoundaryAt = now;
  now += DT;
}

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
log.push(`firstBoundaryAt=${firstBoundaryAt.toFixed(0)}ms`);
// Relaxed guards (3500ms) must let the 4000ms change fire by ~4500ms.
// The OLD 6000ms guards would push the earliest boundary past 6000ms → fail.
if (firstBoundaryAt < 0) fail('no section boundary detected at all');
else if (firstBoundaryAt < 3500) fail('boundary fired before the min-length guard');
else if (firstBoundaryAt > 5500) fail(`boundary too late (${firstBoundaryAt}ms) — detector not relaxed`);

const report = log.join('\n') + '\n' + (pass ? '[audio-test] PASS' : '[audio-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/eviland-audio-test.mjs`
Expected: FAIL — `boundary too late (~6000ms) — detector not relaxed` (the current 6000ms guards block the 4000ms change until past 6000ms).

- [ ] **Step 3: Add the named tuning constants**

In `src/visualizer/eviland-audio.ts`, immediately after the existing line `const STRUCT_PERIOD_MS = 500;` (currently line 164), add:

```ts
  // Structure-detection tuning. A slower recent-average EMA keeps a genuine
  // musical change reading as "novel" instead of being absorbed within ~3s,
  // and relaxed time guards let real sections fire ~2x more often — this is
  // what gives the visualizer MilkDrop-like variety. See
  // docs/superpowers/specs/2026-06-09-eviland-evolving-variety-design.md.
  const STRUCT_RECENT_ALPHA = 0.06; // was 0.18
  const SECTION_NOVELTY_THRESH = 0.22; // unchanged
  const SECTION_MIN_GAP_MS = 3500; // min ms since last boundary (was 6000)
  const SECTION_MIN_LEN_MS = 3500; // min section length before a new boundary (was 6000)
```

- [ ] **Step 4: Use the constants in the detector**

In `src/visualizer/eviland-audio.ts`, change the EMA update (currently line 400) from:

```ts
        for (let b = 0; b < EVILAND_BANDS; b++) recentAvg[b]! += (bandMag[b]! - recentAvg[b]!) * 0.18;
```

to:

```ts
        for (let b = 0; b < EVILAND_BANDS; b++) recentAvg[b]! += (bandMag[b]! - recentAvg[b]!) * STRUCT_RECENT_ALPHA;
```

And change the boundary condition (currently line 403) from:

```ts
        if (out.novelty > 0.22 && nowMs - lastNoveltyAt > 6000 && nowMs - sectionStartAt > 6000) {
```

to:

```ts
        if (out.novelty > SECTION_NOVELTY_THRESH && nowMs - lastNoveltyAt > SECTION_MIN_GAP_MS && nowMs - sectionStartAt > SECTION_MIN_LEN_MS) {
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/eviland-audio-test.mjs`
Expected: PASS — `firstBoundaryAt≈4500ms` and `[audio-test] PASS`.

- [ ] **Step 6: Commit**

```bash
git add scripts/eviland-audio-test.mjs src/visualizer/eviland-audio.ts
git commit -m "Eviland: relax structure detector so sections fire ~2x more often

Slow the recent-average EMA (0.18->0.06) so real musical changes still read
as novel, and relax the section time guards (6000->3500ms). Add a Node test
harness that drives the reactor with a synthetic two-phase spectrum and asserts
a boundary fires within the relaxed window.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Director timer-rotation floor (`eviland-director.ts`)

**Files:**
- Modify: `src/visualizer/eviland-director.ts`
- Modify: `scripts/eviland-director-test.mjs`

- [ ] **Step 1: Isolate the existing director assertions, then add the failing timer test**

In `scripts/eviland-director-test.mjs`, the existing tests assert exact-equality after settling and must not be perturbed by drift/timer. Change the director construction (currently line ~50):

```js
const d = createDirector({ songId: 'unit-test', enabled: true });
```

to:

```js
const d = createDirector({ songId: 'unit-test', enabled: true, drift: 0, rotateMs: 0 });
```

Then append, immediately before the `const report = ...` line near the end of the file:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/eviland-director-test.mjs`
Expected: FAIL — `timer rotation did not change the look without section boundaries` (only the opener look exists; nothing rotates).

- [ ] **Step 3: Add rotation constants and options**

In `src/visualizer/eviland-director.ts`, add constants just below the `TIER_MUTATE_AMOUNT`/`transitionSpeedFor` block (before `// Director options + state`):

```ts
// ---------------------------------------------------------------------------
// Timer-rotation + drift tuning (MilkDrop-like variety floor).
// ---------------------------------------------------------------------------

/** Default ms between forced look rotations when structure stays quiet. */
const ROTATE_INTERVAL_MS = 20000;
/** Default deterministic ±jitter on the rotation interval so it isn't metronomic. */
const ROTATE_JITTER_PCT = 0.15;
```

In the `DirectorOptions` interface, add these fields after `enabled?: boolean;`:

```ts
  /** ms between forced "timer" look rotations when no section boundary fires. Default 20000. 0 disables. */
  rotateMs?: number;
  /** Deterministic ±jitter fraction on the rotation interval (0..0.9). Default 0.15. */
  rotateJitterPct?: number;
```

- [ ] **Step 4: Read the options and add rotation state**

In `createDirector`, after the line `const initial = opts.initial ? cloneConfig(opts.initial) : defaultConfig();`, add:

```ts
  const rotateMs = Math.max(0, opts.rotateMs ?? ROTATE_INTERVAL_MS);
  const rotateJitterPct = Math.max(0, Math.min(0.9, opts.rotateJitterPct ?? ROTATE_JITTER_PCT));
```

In the `// ── core state ──` block, after `let lastTier: EnergyTier | null = null;`, add:

```ts
  // Timer-rotation floor: ms since the last look switch, and a monotonic
  // rotation counter (reset on a real section boundary) folded into the seed
  // so forced looks are deterministic in sequence but vary each rotation.
  let msSinceSwitch = 0;
  let rotationIndex = 0;
```

- [ ] **Step 5: Make seeds rotation-aware and add the rotation helpers**

In `src/visualizer/eviland-director.ts`, replace `seedFor`:

```ts
  function seedFor(sectionId: number): number {
    // Per-(song, section) deterministic seed. hashSeed is stable across runs.
    return hashSeed(`${activeSongId}::section::${sectionId}`);
  }
```

with:

```ts
  function seedFor(sectionId: number, rotation = 0): number {
    // Per-(song, section, rotation) deterministic seed. rotation 0 keeps the
    // original key so a song's first look per section is unchanged; forced
    // timer rotations (rotation > 0) derive distinct looks.
    const key =
      rotation === 0
        ? `${activeSongId}::section::${sectionId}`
        : `${activeSongId}::section::${sectionId}::r${rotation}`;
    return hashSeed(key);
  }
```

Replace the `generateForSection` signature line:

```ts
  function generateForSection(sectionId: number, tier: EnergyTier): OperatorConfig {
    const baseSeed = seedFor(sectionId);
```

with:

```ts
  function generateForSection(sectionId: number, tier: EnergyTier, rotation = 0): OperatorConfig {
    const baseSeed = seedFor(sectionId, rotation);
```

Add two helpers immediately after `generateForSection` (before `startFade`):

```ts
  function effectiveRotateMs(): number {
    if (rotateMs <= 0) return Infinity;
    // Deterministic jitter for the *next* rotation so the cadence varies but
    // replays identically.
    const r = new Rng(hashSeed(`${activeSongId}::rot::${rotationIndex + 1}`));
    const signed = (r.next() * 2 - 1) * rotateJitterPct;
    return rotateMs * (1 + signed);
  }

  function onForcedRotation(frame: EvilandFrame): void {
    rotationIndex++;
    const tier = tierFor(frame);
    const nextConfig = generateForSection(frame.sectionId, tier, rotationIndex);
    // Forced rotations deliberately do NOT write the `sections` recall map or
    // touch the audio sectionId — chorus recall stays driven by
    // frame.sectionReturn, which forced rotations never set.
    const speed = transitionSpeedFor(lastTier, tier);
    startFade(nextConfig, speed, frame.bpm);
    lastTier = tier;
  }
```

- [ ] **Step 6: Reset the rotation clock on every switch**

In `startFade`, after the `fadeDurationMs = ...` line, add:

```ts
    // Reset the timer-rotation clock on every switch (section- or timer-driven).
    msSinceSwitch = 0;
```

In `onSectionBoundary`, after the existing `framesSinceSection = 0;` line, add:

```ts
    // A real structural change resets the timer cadence — structure leads.
    rotationIndex = 0;
```

- [ ] **Step 7: Drive the timer in `update()`**

In `update()`, replace this block:

```ts
      advanceFade(frame, dtMs);
      recomputeLive();
      return live;
```

with:

```ts
      advanceFade(frame, dtMs);

      // Timer floor: if structure hasn't changed the look in a while, force a
      // fresh rotation (MilkDrop-style). Only when settled, never mid-fade.
      msSinceSwitch += dt;
      if (rotateMs > 0 && fade >= 1 && msSinceSwitch >= effectiveRotateMs()) {
        onForcedRotation(frame);
        advanceFade(frame, dtMs);
      }

      recomputeLive();
      return live;
```

(`dt` is already computed above as `Math.max(0, Math.min(250, dtMs))`.)

- [ ] **Step 8: Reset rotation state in `reset()`**

In `reset()`, after `energyAvg = 0;` ... `framesSinceSection = 0;` block, add:

```ts
      msSinceSwitch = 0;
      rotationIndex = 0;
```

- [ ] **Step 9: Run the timer test to verify it passes**

Run: `node scripts/eviland-director-test.mjs`
Expected: PASS — `timer rotation produced N distinct configs over 50s` with N ≥ 3, and `[director-test] PASS` (existing assertions still green because their director uses `rotateMs:0`).

- [ ] **Step 10: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/visualizer/eviland-director.ts scripts/eviland-director-test.mjs
git commit -m "Eviland: add MilkDrop-style timer-rotation floor to the Director

When structure stays quiet, force a fresh look every ~20s (deterministic
jitter), keyed by a monotonic rotation index so the sequence is reproducible.
Real section boundaries reset the cadence — structure still leads. Forced
rotations never touch the recall map, so chorus visual-rhyme is preserved.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Gentle intra-section drift (`eviland-director.ts`)

**Files:**
- Modify: `src/visualizer/eviland-director.ts`
- Modify: `scripts/eviland-director-test.mjs`

- [ ] **Step 1: Add the failing drift test**

In `scripts/eviland-director-test.mjs`, append immediately before the `const report = ...` line (after the timer block from Task 2):

```js
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

  // Drift OFF: live must be referentially stable frame-to-frame in steady state.
  const doff = createDirector({ songId: 'drift-off', enabled: true, drift: 0, rotateMs: 0 });
  doff.update(mockFrame({ sectionChanged: true, sectionId: 0, energy: 0.5 }), 16.7);
  settle(doff, { sectionId: 0, energy: 0.5 }, 180);
  const a = doff.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  const b = doff.update(mockFrame({ sectionId: 0, energy: 0.5 }), 16.7);
  log.push(`drift off: same reference across frames: ${a === b}`);
  if (a !== b) fail('drift off: steady-state config is not referentially stable (GC fast path broken)');
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/eviland-director-test.mjs`
Expected: FAIL — `drift on: held look did not move` (drift not implemented yet; `live = target` stays put).

- [ ] **Step 3: Add drift constants and option**

In `src/visualizer/eviland-director.ts`, add to the timer/drift tuning block (next to `ROTATE_INTERVAL_MS`):

```ts
/** Default intra-section drift strength (0 disables). */
const DRIFT_AMOUNT = 0.12;
/** Period of the drift "breathe out and back" triangle wave, ms. */
const DRIFT_PERIOD_MS = 14000;
/** Throttle: recompute the drift lerp at most this often (ms) to bound GC. */
const DRIFT_TICK_MS = 100;
```

In `DirectorOptions`, add after `rotateJitterPct`:

```ts
  /** Intra-section drift strength 0..1 — held looks slowly breathe. Default 0.12. 0 disables. */
  drift?: number;
```

- [ ] **Step 4: Read the option and add drift state**

After the `rotateJitterPct` option read, add:

```ts
  const driftAmount = Math.max(0, Math.min(1, opts.drift ?? DRIFT_AMOUNT));
```

In the core state block, after `let rotationIndex = 0;`, add:

```ts
  // Intra-section drift: one precomputed mutated "breathe toward" target per
  // look, a phase clock, and a throttled cache so we don't lerp every frame.
  let driftTarget: OperatorConfig = cloneConfig(initial);
  let driftPhaseMs = 0;
  let driftAccumMs = 0;
  let driftCache: OperatorConfig = cloneConfig(initial);
```

- [ ] **Step 5: Precompute the drift target on each switch**

In `startFade`, after the `msSinceSwitch = 0;` line added in Task 2, add:

```ts
    // Precompute one deterministic drift target for this look; reset the phase.
    if (driftAmount > 0) {
      const driftSeed =
        hashSeed(`${activeSongId}::drift::${target.seed ?? 'x'}::${rotationIndex}`) >>> 0;
      driftTarget = mutate(target, driftAmount, driftSeed);
      driftPhaseMs = 0;
      driftAccumMs = 0;
    }
```

- [ ] **Step 6: Add the drift branch to `recomputeLive`**

Replace the whole `recomputeLive` function:

```ts
  function recomputeLive(): void {
    if (fade >= 1) {
      // Steady state (the ~99% of frames between section boundaries): return the
      // owned `target` by reference. No per-frame clone — `target`/`from` are only
      // ever reassigned to fresh clones in startFade/reset/setCurrent and are never
      // mutated in place, and the renderer treats the config as read-only. Cloning
      // here every frame was the dominant GC source behind the "laggy visualizer".
      live = target;
    } else if (fade <= 0) {
      live = from;
    } else {
      // Smoothstep gives an ease-in/out feel — much more musical than linear.
      // lerpConfig allocates, but only during the brief beat-synced crossfade.
      const t = fade * fade * (3 - 2 * fade);
      live = lerpConfig(from, target, t);
    }
  }
```

with:

```ts
  function recomputeLive(dtMs = 0): void {
    if (fade >= 1) {
      if (driftAmount <= 0) {
        // Zero-alloc fast path — `target` is read-only and never mutated in
        // place. This was the GC fix behind the "laggy visualizer".
        live = target;
        return;
      }
      // Drift: slowly breathe target<->driftTarget and back on a triangle wave.
      // Throttled to DRIFT_TICK_MS so we allocate ~10x/sec, not 60x/sec; the
      // cached config is returned by reference between ticks.
      const dt = Math.max(0, Math.min(250, dtMs));
      driftPhaseMs = (driftPhaseMs + dt) % DRIFT_PERIOD_MS;
      driftAccumMs += dt;
      if (driftAccumMs >= DRIFT_TICK_MS) {
        driftAccumMs = 0;
        const phase = driftPhaseMs / DRIFT_PERIOD_MS; // 0..1
        const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2; // 0..1..0
        const t = tri * tri * (3 - 2 * tri); // smoothstep ease
        driftCache = lerpConfig(target, driftTarget, t);
      }
      live = driftCache;
    } else if (fade <= 0) {
      live = from;
    } else {
      const t = fade * fade * (3 - 2 * fade);
      live = lerpConfig(from, target, t);
    }
  }
```

- [ ] **Step 7: Pass dt to `recomputeLive` in `update()`**

In `update()`, change the steady-state call `recomputeLive();` (the one after the timer block) to:

```ts
      recomputeLive(dtMs);
```

Leave the priming call `recomputeLive();` at the bottom of `createDirector` (before the public API return) as-is — it defaults dt to 0.

- [ ] **Step 8: Keep drift coherent in `setCurrent` and `reset`**

In `setCurrent`, after `fade = 1;`, add:

```ts
      // Start drift neutral for the new look (no drift until the next switch
      // computes a real driftTarget).
      driftTarget = cloneConfig(config);
      driftPhaseMs = 0;
      driftAccumMs = 0;
```

In `reset`, after the `rotationIndex = 0;` added in Task 2, add:

```ts
      driftTarget = cloneConfig(live);
      driftPhaseMs = 0;
      driftAccumMs = 0;
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `node scripts/eviland-director-test.mjs`
Expected: PASS — `drift on: zoom.base moved …` (> 0, ≤ 0.5), `drift off: same reference across frames: true`, and `[director-test] PASS` (recall/distinct/passthrough still green).

- [ ] **Step 10: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/visualizer/eviland-director.ts scripts/eviland-director-test.mjs
git commit -m "Eviland: add gentle intra-section drift so held looks breathe

A held look now slowly oscillates target<->mutate(target) on a ~14s triangle
wave instead of freezing, recomputed at ~10Hz to bound GC. drift:0 preserves
the existing zero-alloc steady-state fast path exactly.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Honest docs, sync, and full verification gate

**Files:**
- Modify: `src/visualizer/eviland-director.ts` (header comment)
- Sync: `packages/eviland-core/src/*`

- [ ] **Step 1: Update the Director header comment for honesty**

In `src/visualizer/eviland-director.ts`, replace the paragraph (currently lines 17-18):

```ts
// Everything is deterministic from (songId, sectionId): the same song always
// gets the same sequence of looks. The platform RNG / clock is never read.
```

with:

```ts
// Look generation is deterministic from (songId, sectionId, rotationIndex):
// the same song always produces the same SEQUENCE of looks. The platform RNG
// is never read. Two timing inputs do follow the playback clock by design: the
// ~20s timer-rotation floor (so the look still changes when the music is
// structurally quiet, MilkDrop-style) and the gentle intra-section drift.
```

- [ ] **Step 2: Sync the eviland-core package copy**

Run: `node packages/eviland-core/sync.mjs`
Expected: reports the synced files (eviland-audio.ts + eviland-director.ts among them).

- [ ] **Step 3: Verify the sync check passes**

Run: `node packages/eviland-core/sync.mjs --check`
Expected: `7/7 in sync` (or equivalent all-green output). If it reports drift, re-run Step 2.

- [ ] **Step 4: Run the full verification gate**

Run each and confirm:
- `npm run typecheck` → no errors
- `node scripts/eviland-audio-test.mjs` → `[audio-test] PASS`
- `node scripts/eviland-director-test.mjs` → `[director-test] PASS`
- `npm run smoke:visualizer` → passes (module-export/wiring smoke)

- [ ] **Step 5: Commit the docs + sync**

```bash
git add src/visualizer/eviland-director.ts packages/eviland-core/src/
git commit -m "Eviland: honest determinism note + sync eviland-core package copy

Document that look SEQUENCE stays deterministic from (songId, sectionId,
rotationIndex) while rotation timing + drift follow the playback clock by
design. Sync the package copy so prebuild --check stays green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Live Electron smoke (manual visual confirmation)**

Run: `npm run smoke:eviland`
Expected: the Eviland visualizer renders non-blank, reacts to audio, AND visibly changes looks several times over ~60s (timer rotation + detector) with the held look gently moving between changes (drift). If it stays on one look, recheck Tasks 2-3.

---

## Self-Review Notes

- **Spec coverage:** A (detector) → Task 1; B (timer rotation) → Task 2; C (drift) → Task 3; honesty/sync → Task 4; testing items 1-4 → Tasks 1-3 tests + Task 4 gate. All spec sections covered.
- **Type consistency:** `seedFor(sectionId, rotation=0)` and `generateForSection(sectionId, tier, rotation=0)` signatures are updated once (Task 2) and used consistently. `recomputeLive(dtMs=0)` updated once (Task 3) with both call sites handled (Task 3 Step 7). `rotateMs`/`rotateJitterPct`/`drift` options are declared in `DirectorOptions` and read in `createDirector`. `driftTarget`/`driftPhaseMs`/`driftAccumMs`/`driftCache`/`msSinceSwitch`/`rotationIndex` are all declared in the core-state block before use.
- **Confirmed:** `OperatorConfig.zoom` is a `Channel` (`eviland-operators.ts:46,80`) with a numeric `base` field, so the drift test's `c.zoom.base` access is correct.
- **Backward-compat:** existing director assertions are isolated with `drift:0, rotateMs:0` (Task 2 Step 1); their ~4s `settle()` windows are well under the 20s timer regardless.
