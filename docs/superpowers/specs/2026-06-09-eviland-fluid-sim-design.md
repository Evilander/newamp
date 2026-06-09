# Eviland Real Fluid Simulation — Design

**Date:** 2026-06-09
**Status:** Approved (design via standing user trust; "Full solver + variety wiring" chosen explicitly)
**Goal:** Replace Eviland's purely procedural motion with a real GPU stable-fluids solver whose velocity field is *pushed* by the music, composed with the existing MilkDrop-style transforms and wired into the operator/randomizer variety system.

## Problem

Eviland's feedback field (`src/visualizer/eviland.ts`, `FIELD_FRAG` ~114-205) advects dye through a **procedural** velocity: curl noise + zoom/rotate/swirl/kaleido (`src = clamp(src - u_flow + w, …)` at ~198). There is no simulated velocity state — no momentum, no force memory, no incompressibility. Onset emitters splat **color**, not **force**, so a kick never *pushes* the scene; motion intensity tracks the audio only through per-frame uniform values. It reads as warp, not fluid.

## Decision (user-confirmed)

**Full solver + variety wiring**: complete stable-fluids pipeline (velocity self-advection, audio force injection, vorticity confinement, Jacobi pressure projection), with `fluid`/`vorticity` as first-class operator channels so the randomizer/Director vary fluidity per archetype/section. Tiered: low tier (and unsupported GPUs) = solver off = **bit-identical to today's rendering**. Composition default: simulated velocity **composes with** (does not replace) the existing procedural warp/kaleido.

## Architecture

### New module: `src/visualizer/eviland-fluid.ts`
Self-contained, zero-dep, mirrors `eviland.ts`'s factory style. **Must be added to `packages/eviland-core/sync.mjs` MODULES (becomes 8 entries).**

```
createFluidSim(gl: WebGL2RenderingContext, opts: {
  width: number; height: number;        // sim grid size (fraction of field res)
  pressureIterations: number;           // Jacobi iterations per step
}): FluidSim | null                      // null when RG16F/R16F render unsupported

interface FluidSim {
  step(dt: number, forces: FluidForce[], params: { vorticity: number; dissipation: number }): void;
  velocityTexture(): WebGLTexture;       // RG16F, current velocity (UV-space units)
  resize(width: number, height: number): void;
  dispose(): void;
}

interface FluidForce {
  x: number; y: number;                  // splat center, UV space (0..1)
  dx: number; dy: number;                // impulse direction * strength (UV/s)
  radius: number;                        // splat radius, UV space
}
```

Internal targets: velocity ping-pong (RG16F), curl (R16F), divergence (R16F), pressure ping-pong (R16F); all `CLAMP_TO_EDGE`, NEAREST-or-LINEAR per `OES_texture_float_linear` like the existing field. Pass sequence per `step` (each a fullscreen quad, standard stable-fluids):
1. **Advect velocity** by itself (semi-Lagrangian backtrace, dissipation multiply).
2. **Splat forces** (additive Gaussian impulses from `forces`).
3. **Curl** (scalar vorticity of velocity).
4. **Vorticity confinement** (force toward curl gradients × `params.vorticity` — restores the small-scale swirl numeric dissipation kills).
5. **Divergence** of velocity.
6. **Jacobi pressure solve** × `pressureIterations` (ping-pong, zero initial guess).
7. **Gradient subtract** → divergence-free velocity.

### Pure audio→forces seam (Node-testable): `fluidForcesFromFrame`
Exported from `eviland-fluid.ts`; no GL. Maps the existing `EvilandFrame` (`eviland-audio.ts`) to impulses, preserving Eviland's causal/spatial-truth thesis:
- **kick onset** → radial burst at (0.5 + pan*0.2, 0.30): N spokes of outward impulses, strength ∝ onset intensity (the shockwave finally has *momentum*).
- **snare onset** → one angled jet from an off-center point (side alternates deterministically by onset count), sharp radius.
- **hat onset** → 2-3 weak, small-radius jitter impulses along the top edge (y≈0.85), direction mostly lateral.
- **bass envelope** → broad slow horizontal shear near the bottom (y≈0.15), direction = sign(pan) biased.
- **pan** → small global lateral bias force at center.
- **anticipation "inhale"** → when `bpm>1 && beatConfidence>0.6 && beatPhase>0.85`: gentle inward radial pull (negative spokes) — the scene breathes in just before the beat lands.
All magnitudes scaled so total injected energy per frame is bounded (clamp forces list to ≤16 entries, strength clamps documented in-code).

### Integration — `src/visualizer/eviland.ts`
- Construct the sim when `quality !== 'low'`: high → grid 0.5× field res, 20 iterations; medium → 0.375×, 12. `null`/low → no sim; all fluid uniforms 0.
- In `render()`, before the field pass: `fluid.step(dt, fluidForcesFromFrame(frame), { vorticity: dyn.vorticity, dissipation: VELOCITY_DISSIPATION })` where `VELOCITY_DISSIPATION` is a fixed module constant (≈0.985/frame) for v1 — only `fluid` and `vorticity` are per-look channels.
- `FIELD_FRAG` additions: `uniform sampler2D u_velocity; uniform float u_fluid;` and the advection line becomes
  `src = clamp(src - u_flow + w - texture(u_velocity, src).xy * u_fluid * ADVECT_SCALE, 0.001, 0.999);`
  — simulated flow displaces the dye sample *in addition to* the procedural warp; `u_fluid = 0` ⇒ exactly current math.
- Resize: sim grid follows `rebuildTargets` (same dimension-change guard); `dispose()` chained into the renderer's dispose.
- Uniform/location caching follows the existing `fieldUni` pattern (no per-frame `getUniformLocation`).

### Variety wiring — `eviland-operators.ts`, `eviland-randomizer.ts`
- `OperatorConfig` gains `fluid: Channel` and `vorticity: Channel`; added to `SAFE_RANGES` (fluid 0..1, vorticity 0..30), `defaultConfig` (fluid base ≈0.25 gently audio-bound to energy; vorticity ≈8), `cloneConfig`, `lerpConfig`, `evalConfig` output (`dyn.fluid`, `dyn.vorticity`), and `mutate()`.
- Randomizer per-archetype ranges: liquid/nebula 0.5–1.0 fluid (high vorticity), tunnel/kaleidoscope 0.2–0.6, lattice/strobe 0–0.25 (crisp looks stay crisp).
- **Seed-code stability (critical):** the new channels draw from a *derived* RNG — `new Rng(hashSeed(String(lookSeed) + '::fluid'))` — so the main draw sequence is unchanged and **every existing shared seed code reproduces its exact prior look** (plus deterministic fluid defaults). A golden-value test enforces this.
- Director needs no changes — channels flow through generate/lerp/mutate/drift automatically, so fluidity crossfades between sections and breathes with drift.

## Tiering & fallback
| Tier | Sim grid | Jacobi iters | Behavior |
|------|----------|--------------|----------|
| high | 0.5× field | 20 | full fluid |
| medium | 0.375× field | 12 | full fluid, coarser |
| low | — | — | no sim; `u_fluid=0`; identical to current rendering |
| RG16F unsupported | — | — | `createFluidSim` returns null; same as low |

## Testing
- **`scripts/eviland-fluid-test.mjs`** (esbuild harness): `fluidForcesFromFrame` — kick onset yields outward radial spokes at the kick anchor; snare yields a single angled jet; hat yields top-edge entries; `beatPhase=0.9, beatConfidence=0.8` yields inward pull; force count ≤16 and strengths within clamps; silent frame yields ≤ the pan/bass baseline entries.
- **`scripts/eviland-operators-test.mjs`** (extend or create): `fluid`/`vorticity` present in `generate()` output within SAFE_RANGES across archetypes; `lerpConfig`/`cloneConfig` roundtrip them; **golden seed-stability** — `generate(42)` (and one more seed) must produce the same `zoom/rotate/swirl/hueCycle/decay/warpAmp/mirrorMix` values as before the change (goldens captured from current code at implementation time, committed in the test).
- Existing gates: `test:eviland-audio`, `test:eviland-director`, `smoke:visualizer`, `sync.mjs --check` (8/8), typecheck. New tests wired into CI.
- **Live evidence:** `npm run smoke:eviland` (non-blank, reactive) and `scripts/eviland-capture.mjs` before/after captures on the same track section for the report.

## Out of scope (unchanged known follow-ups)
- WebGL context-loss recovery (`eviland.ts`/`particle-flow.ts`).
- `prefers-reduced-motion`.
- AlbumsView virtualization, audio-correctness + security passes (next roadmap items).
