# Eviland Evolving Variety — Design

**Date:** 2026-06-09
**Status:** Approved (design), pending implementation plan
**Goal:** Make the Eviland visualizer visibly evolve like MilkDrop — frequent, varied look changes plus continuous motion — while keeping its musical-structure awareness.

## Problem

Eviland's full generative stack (6 archetypes → randomizer → Director → operator engine → WebGL2 renderer) is **already built and wired**, with the Director on by default. It nevertheless *feels static* for two concrete, code-level reasons:

1. **Section boundaries almost never fire.** `eviland-audio.ts` (the structure detector) gates a boundary on `novelty > 0.22 && now - lastNovelty > 6000ms && now - sectionStart > 6000ms`. Novelty is `1 - cosine(current, recentAvg)`, and `recentAvg` is an EMA with **α = 0.18** — it converges in ~3s, so by the time a chorus/drop arrives the "recent average" has already absorbed the new material and novelty rarely clears 0.22. Net: only a handful of look changes per song.
2. **A held look is referentially frozen between switches.** `recomputeLive()` returns the owned `target` config by reference once `fade >= 1` (a deliberate GC fix). Correct for performance, but it means *all* visual change between sections comes only from per-frame audio reactivity through fixed bindings — the look's own parameters never evolve.

The variety machinery is not missing; it is under-triggered and non-evolving between triggers.

## Decision (from brainstorming)

- **Hybrid model:** add a MilkDrop-style **timer floor** that forces a fresh look on an interval, AND tune the detector so real musical sections fire more often. Structure leads; the timer is the floor.
- **Add gentle intra-section drift** so even a held look breathes rather than freezing.

## Approach — three coordinated changes

All changes sit behind existing module boundaries and default-on, so neither `createDirector` call site needs to change:
- `src/components/Visualizer.tsx:407`
- `src/visualizer/eviland-producer.ts:144`

### A. Section detector fires more readily — `src/visualizer/eviland-audio.ts`

Around lines 384–429 (the structural-memory block).

- Extract the inline tuning constants into named module-level constants.
- Slow the `recentAvg` EMA: **0.18 → 0.06** (`STRUCT_RECENT_ALPHA`). Genuine musical changes now register as novel instead of being absorbed within ~3s.
- Relax the dual time guards: **6000ms → 3500ms** (`SECTION_MIN_GAP_MS`, `SECTION_MIN_LEN_MS`).
- Keep the novelty threshold at **0.22** (`SECTION_NOVELTY_THRESH`) — the slower EMA already raises measured novelty, so the threshold need not drop.
- **No change** to the fingerprint capture, `sectionReturn` matching, `sectionId` increment, or onset/tempo logic.

Outcome: real verse→chorus→drop transitions fire roughly twice as often, with no new spurious-trigger risk (the slower EMA makes novelty *more* selective for sustained change, not less).

### B. Director timer rotation (the MilkDrop floor) — `src/visualizer/eviland-director.ts`

New `DirectorOptions`:
- `rotateMs?: number` — interval for the forced-rotation floor. Default `ROTATE_INTERVAL_MS = 20000`. `0` disables.
- `rotateJitterPct?: number` — deterministic ±jitter so rotation isn't metronomic. Default `0.15`.

New state:
- `msSinceSwitch` — accumulates `dtMs`; **reset to 0 in `startFade`** (i.e., on every look change, whether section- or timer-driven).
- `rotationIndex` — monotonic counter of timer-forced rotations within the current audio section; **reset to 0** on a real section boundary.

Logic in `update()` (only when `enabled`):
- After the existing section-boundary / first-look handling and `advanceFade`, if `rotateMs > 0`, **not mid-fade** (`fade >= 1`), and `msSinceSwitch >= effectiveRotateMs` (interval with deterministic jitter derived from `rotationIndex`), call a new `onForcedRotation(frame)`.
- `onForcedRotation`:
  - `rotationIndex++`.
  - `tier = tierFor(frame)` (so a loud passage rotates into energetic looks).
  - Generate a fresh look for the **current audio `sectionId`** but with `rotationIndex` folded into the seed, via an extended `seedFor(sectionId, rotationIndex)` / `generateForSection(sectionId, tier, rotationIndex)`. The look *sequence* stays deterministic; each rotation is a different look.
  - Forced rotations do **not** write to the `sections` recall map at all. Chorus recall is driven solely by the audio `sectionReturn`, which forced rotations never set — so leaving the recall map untouched is correct and keeps visual rhyme intact.
  - `startFade(nextConfig, 1, frame.bpm)` — reuses the existing beat-quantized crossfade.
- A real section boundary continues to run `onSectionBoundary` unchanged, additionally resetting `rotationIndex = 0`.

Forced rotations **never** touch the audio `sectionId`, fingerprints, or `sectionReturn` — visual rhyme on a returning chorus is fully preserved.

### C. Gentle intra-section drift — `src/visualizer/eviland-director.ts`

New `DirectorOptions`:
- `drift?: number` — drift strength. Default `DRIFT_AMOUNT = 0.12`. `0` disables (preserves the current zero-alloc fast path exactly).

New constants: `DRIFT_PERIOD_MS = 14000`, `DRIFT_TICK_MS = 100`.

New state: `driftTarget: OperatorConfig`, `driftPhaseMs`, `driftAccumMs`, `driftCache: OperatorConfig`.

Logic:
- In `startFade`, after setting `target`, compute `driftTarget = mutate(target, DRIFT_AMOUNT, deterministicDriftSeed)` once. Reset `driftPhaseMs`.
- In `recomputeLive` steady state (`fade >= 1`):
  - If `drift <= 0`: keep `live = target` (unchanged fast path, zero alloc).
  - Else: advance `driftPhaseMs` by frame dt; compute a slow triangle wave `tri ∈ [0,1]` over `DRIFT_PERIOD_MS`; **throttle** the actual `lerpConfig(target, driftTarget, tri)` to once per `DRIFT_TICK_MS`, caching the result in `driftCache` and returning it by reference between ticks. → ~10 allocations/sec, not 60. The look oscillates target↔driftTarget and back — it breathes and **returns**, never wanders off.
- Drift does not run during a crossfade (`fade < 1`) — the fade itself is the motion.

### Honesty / determinism note

Update the Director module header: the look **sequence** remains deterministic from `(songId, sectionId, rotationIndex)`; only the **timing** of timer-forced rotations now follows the playback clock (`dtMs`). This is the intended, chosen relaxation of the previous "platform clock never read" contract. Drift is deterministic given the per-look `driftTarget` and accumulated playback time.

### Source-of-truth sync

Edit `src/visualizer/*` (the canonical source). Run `node packages/eviland-core/sync.mjs` to copy into the package; `prebuild` runs `sync.mjs --check` and fails the build on drift. Do not edit `packages/eviland-core/src/*` directly.

## Testing (TDD — failing tests first)

Extend `scripts/eviland-director-test.mjs` (esbuild-bundles the module for Node; has `mockFrame`/`settle` helpers):

1. **Timer rotation** — feed ~50s of steady frames (no `sectionChanged`); assert ≥2 distinct looks emerge after the opener (today: 0). Fails before, passes after.
2. **Drift on** — in steady state, assert `live` changes across a ~5s window but stays bounded near `target` (not a runaway). **Drift off** — assert `live` is referentially stable frame-to-frame.
3. **Structure still leads** — a real `sectionChanged` resets rotation; existing per-section-distinct-looks, chorus-recall, and passthrough assertions stay green. Confirm the existing ~4s `settle()` windows do **not** trip the 20s timer (backward compatibility).
4. **Detector** — extend `eviland-smoke` (or add a minimal esbuild harness mirroring the director test) feeding a synthetic 24-band stream with one real mid-point change; assert a boundary fires within the relaxed window and not before the min-length guard.

Verification gate:
- `npm run typecheck`
- `node scripts/eviland-director-test.mjs`
- `npm run smoke:visualizer`
- `npm run smoke:eviland` (live Electron) to confirm non-blank, reactive, **and visibly evolving** over ~60s.
- `node packages/eviland-core/sync.mjs --check` green.

## Defaults (all tunable)

| Knob | Default | Meaning |
|------|---------|---------|
| `STRUCT_RECENT_ALPHA` | 0.06 | detector EMA (was 0.18) |
| `SECTION_MIN_GAP_MS` / `SECTION_MIN_LEN_MS` | 3500 | detector time guards (was 6000) |
| `SECTION_NOVELTY_THRESH` | 0.22 | unchanged |
| `rotateMs` | 20000 | timer floor; 0 disables |
| `rotateJitterPct` | 0.15 | ±15% deterministic jitter |
| `drift` | 0.12 | intra-section drift strength; 0 disables |
| `DRIFT_PERIOD_MS` | 14000 | breathe out-and-back period |
| `DRIFT_TICK_MS` | 100 | drift recompute throttle (GC) |

## Out of scope (recommended follow-ups)

- **WebGL context-loss handling** in `eviland.ts` / `particle-flow.ts` (audit P-HIGH): no `webglcontextlost`/`restored` listeners → black canvas with no recovery on GPU reset. Separate robustness fix.
- `prefers-reduced-motion` support (spec'd, never implemented) — would gate drift/aberration/shockwaves.
- Per-frame `getAttribLocation`/`getUniformLocation` caching in `eviland.ts` (minor perf).
- Optional Settings UI to expose `rotateMs` / `drift` (defaults first).
