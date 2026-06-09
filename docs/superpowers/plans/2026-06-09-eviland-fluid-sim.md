# Eviland Real Fluid Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Eviland a real GPU stable-fluids solver — audio injects momentum, vorticity confinement + pressure projection produce liquid, momentum-conserving motion — composed with the existing MilkDrop transforms and wired into the operator/randomizer variety system.

**Architecture:** New self-contained `src/visualizer/eviland-fluid.ts` (GL solver + pure Node-testable `fluidForcesFromFrame` audio→impulse seam). `eviland.ts` steps the sim before the field pass and adds `u_velocity`/`u_fluid` to the dye advection (fluid=0 ⇒ bit-identical current rendering; low tier / unsupported GPU ⇒ no sim). `fluid`/`vorticity` become full operator channels; the randomizer mints them from a **derived RNG** so existing shared seed codes keep their exact look (golden-value test enforces this).

**Tech Stack:** WebGL2 (RG16F/R16F render targets, EXT_color_buffer_float — already required), TypeScript, esbuild Node test harnesses, `packages/eviland-core/sync.mjs` staging copy.

Spec: `docs/superpowers/specs/2026-06-09-eviland-fluid-sim-design.md`. Branch `eviland-fluid-sim` (created; spec committed). All eviland edits go in `src/visualizer/*` (source of truth); sync the package copy in Task 4.

---

## File Structure
- Create `src/visualizer/eviland-fluid.ts` — `fluidForcesFromFrame` (pure) + `createFluidSim` (GL).
- Create `scripts/eviland-fluid-test.mjs` — forces-seam unit test.
- Create `scripts/eviland-operators-test.mjs` — channel plumbing + golden seed-stability test.
- Modify `src/visualizer/eviland-operators.ts` — `fluid`/`vorticity` channels through Channel/EvilandDynamics/default/clone/lerp/eval.
- Modify `src/visualizer/eviland-randomizer.ts` — template specs, derived-RNG minting in `generate()`, SAFE_RANGES, `mutate()`.
- Modify `src/visualizer/eviland.ts` — sim construction/tiering, step-before-field, shader uniforms, resize/dispose.
- Modify `packages/eviland-core/sync.mjs` — add `eviland-fluid.ts` to MODULES.
- Modify `package.json` + `.github/workflows/ci.yml` — new `test:*` scripts, CI steps.

---

## Task 1: `eviland-fluid.ts` — forces seam (TDD) + GL solver

**Files:** Create `src/visualizer/eviland-fluid.ts`, `scripts/eviland-fluid-test.mjs`; Modify `package.json`.

- [ ] **Step 1: Write the failing test**

Create `scripts/eviland-fluid-test.mjs`:

```js
// Unit test for fluidForcesFromFrame (pure audio→impulse mapping; no GL).
// esbuild harness like eviland-director-test. Run: node scripts/eviland-fluid-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-fluid-test-result.txt');
writeFileSync(RESULT, '[eviland-fluid-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-fluid.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-fluid-bundle.mjs'), logLevel: 'silent',
});
const { fluidForcesFromFrame, MAX_FLUID_FORCES } = await import(pathToFileURL(resolve('tmp/eviland-fluid-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

function frame(over = {}) {
  return {
    kick: 0, bass: 0, snare: 0, hat: 0, vocal: 0,
    energy: 0.3, centroid: 0.4, flatness: 0.3, crest: 0.3, rolloff: 0.5,
    width: 0.4, pan: 0, novelty: 0.1, beatPhase: 0.2, beatConfidence: 0.3, bpm: 120,
    sectionId: 0, sectionChanged: false, sectionReturn: -1,
    bands: new Array(24).fill(0.2),
    onsets: [],
    ...over,
  };
}
const mag = (f) => Math.hypot(f.dx, f.dy);

// Silent frame: only the baseline bass/pan entries (small) — never empty-crash.
const quiet = fluidForcesFromFrame(frame());
log.push(`quiet forces: ${quiet.length}`);
if (quiet.length > 4) fail('quiet frame should produce at most a few baseline forces');
if (quiet.some((f) => !Number.isFinite(f.x + f.y + f.dx + f.dy + f.radius))) fail('non-finite force fields');

// Kick onset → multiple outward radial spokes anchored low-center.
const kick = fluidForcesFromFrame(frame({ onsets: [{ band: 1, group: 'kick', intensity: 1, sharpness: 0.8 }], kick: 1 }));
const spokes = kick.filter((f) => f.y < 0.5 && mag(f) > 0.001);
log.push(`kick spokes: ${spokes.length}`);
if (spokes.length < 4) fail('kick should emit ≥4 radial spokes in the lower half');
// Outward: each spoke's direction points away from the shared anchor.
const cx = spokes.reduce((s, f) => s + f.x, 0) / spokes.length;
const cy = spokes.reduce((s, f) => s + f.y, 0) / spokes.length;
if (!spokes.every((f) => (f.x - cx) * f.dx + (f.y - cy) * f.dy >= -1e-6)) fail('kick spokes must point outward from their anchor');

// Snare onset → exactly one strong angled jet, off-center.
const snare = fluidForcesFromFrame(frame({ onsets: [{ band: 7, group: 'snare', intensity: 1, sharpness: 1 }], snare: 1 }));
const jets = snare.filter((f) => mag(f) > 0.001 && Math.abs(f.x - 0.5) > 0.05);
log.push(`snare jets: ${jets.length}`);
if (jets.length !== 1) fail(`snare should emit exactly 1 off-center jet, got ${jets.length}`);

// Hat onset → small top-edge entries.
const hat = fluidForcesFromFrame(frame({ onsets: [{ band: 20, group: 'hat', intensity: 0.8, sharpness: 1 }], hat: 0.8 }));
if (!hat.some((f) => f.y > 0.7)) fail('hat should emit top-edge turbulence');

// Anticipation inhale: high confidence, phase just before the beat → inward pull.
const inhale = fluidForcesFromFrame(frame({ bpm: 124, beatConfidence: 0.8, beatPhase: 0.92 }));
const inward = inhale.filter((f) => {
  const rx = f.x - 0.5, ry = f.y - 0.5;
  return rx * f.dx + ry * f.dy < -1e-6; // pointing toward center
});
log.push(`inhale inward forces: ${inward.length}`);
if (inward.length < 2) fail('pre-beat inhale should emit inward forces');

// Cap: a maximal everything-at-once frame stays within MAX_FLUID_FORCES.
const busy = fluidForcesFromFrame(frame({
  onsets: [
    { band: 1, group: 'kick', intensity: 1, sharpness: 1 },
    { band: 7, group: 'snare', intensity: 1, sharpness: 1 },
    { band: 20, group: 'hat', intensity: 1, sharpness: 1 },
    { band: 21, group: 'hat', intensity: 1, sharpness: 1 },
    { band: 12, group: 'vocal', intensity: 1, sharpness: 1 },
  ],
  kick: 1, snare: 1, hat: 1, bass: 1, pan: 0.5, bpm: 128, beatConfidence: 0.9, beatPhase: 0.9,
}));
log.push(`busy forces: ${busy.length} (cap ${MAX_FLUID_FORCES})`);
if (busy.length > MAX_FLUID_FORCES) fail(`forces exceed cap: ${busy.length} > ${MAX_FLUID_FORCES}`);

const report = log.join('\n') + '\n' + (pass ? '[eviland-fluid-test] PASS' : '[eviland-fluid-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 2: Run — verify FAIL** (`node scripts/eviland-fluid-test.mjs` → module missing). Confirm RED.

- [ ] **Step 3: Create `src/visualizer/eviland-fluid.ts`**

Write the full module: header comment (stable-fluids, why momentum matters vs the procedural warp), then:

(a) **Pure seam** (exact behavior the test pins):

```ts
import type { EvilandFrame } from './eviland-audio';

export interface FluidForce {
  x: number; y: number;      // splat center, UV space
  dx: number; dy: number;    // impulse (UV/s, pre-clamped)
  radius: number;            // splat radius, UV space
}

export const MAX_FLUID_FORCES = 16;

const KICK_SPOKES = 6;
const KICK_STRENGTH = 0.55;
const SNARE_STRENGTH = 0.7;
const HAT_STRENGTH = 0.12;
const BASS_SHEAR = 0.05;
const PAN_BIAS = 0.04;
const INHALE_STRENGTH = 0.10;
const INHALE_SPOKES = 4;

let snareSide = 1; // alternates per snare onset so jets trade sides

export function fluidForcesFromFrame(frame: EvilandFrame): FluidForce[] {
  const out: FluidForce[] = [];
  const push = (f: FluidForce) => { if (out.length < MAX_FLUID_FORCES) out.push(f); };

  // Baseline: bass shear along the bottom + pan bias (spatial truth).
  if (frame.bass > 0.05) {
    push({ x: 0.5, y: 0.15, dx: BASS_SHEAR * frame.bass * (frame.pan >= 0 ? 1 : -1), dy: 0, radius: 0.35 });
  }
  if (Math.abs(frame.pan) > 0.05) {
    push({ x: 0.5, y: 0.5, dx: PAN_BIAS * frame.pan, dy: 0, radius: 0.45 });
  }

  for (const onset of frame.onsets) {
    if (onset.group === 'kick') {
      // Radial shockwave: KICK_SPOKES outward impulses around a low-center anchor.
      const ax = 0.5 + frame.pan * 0.2;
      const ay = 0.3;
      const s = KICK_STRENGTH * onset.intensity;
      for (let i = 0; i < KICK_SPOKES; i++) {
        const a = (i / KICK_SPOKES) * Math.PI * 2;
        push({ x: ax + Math.cos(a) * 0.04, y: ay + Math.sin(a) * 0.04, dx: Math.cos(a) * s, dy: Math.sin(a) * s, radius: 0.12 });
      }
    } else if (onset.group === 'snare') {
      // One sharp angled jet, alternating sides.
      snareSide = -snareSide;
      const jx = 0.5 + snareSide * 0.22;
      const s = SNARE_STRENGTH * onset.intensity;
      push({ x: jx, y: 0.55, dx: -snareSide * s * 0.8, dy: s * 0.5, radius: 0.06 });
    } else if (onset.group === 'hat') {
      // Top-edge micro-turbulence: two small lateral jitters (deterministic from band).
      const s = HAT_STRENGTH * onset.intensity;
      const seedX = 0.2 + ((onset.band * 37) % 13) / 20;
      push({ x: seedX, y: 0.85, dx: s, dy: -s * 0.3, radius: 0.03 });
      push({ x: 1 - seedX, y: 0.88, dx: -s, dy: -s * 0.2, radius: 0.03 });
    }
    // vocal/bass-group onsets: covered by the envelope baselines; no extra splat.
  }

  // Anticipation: just before a confident beat, the scene inhales (inward pull).
  if (frame.bpm > 1 && frame.beatConfidence > 0.6 && frame.beatPhase > 0.85) {
    for (let i = 0; i < INHALE_SPOKES; i++) {
      const a = (i / INHALE_SPOKES) * Math.PI * 2 + 0.4;
      const px = 0.5 + Math.cos(a) * 0.3;
      const py = 0.5 + Math.sin(a) * 0.3;
      push({ x: px, y: py, dx: -Math.cos(a) * INHALE_STRENGTH, dy: -Math.sin(a) * INHALE_STRENGTH, radius: 0.18 });
    }
  }

  return out;
}
```

(b) **GL solver** `createFluidSim(gl, { width, height, pressureIterations }): FluidSim | null` with the standard stable-fluids passes. Mirror `eviland.ts`'s own `compile`/`link` helper style (small local copies — the module is self-contained like `particle-flow.ts`). Targets: velocity ping-pong RG16F, curl R16F, divergence R16F, pressure ping-pong R16F; return null if `EXT_color_buffer_float` is unavailable or FBO status incomplete (probe once with a 4×4 RG16F target). Shaders (GLSL 300 es, fullscreen-quad vertex shared):
- `ADVECT_FRAG`: `vel = texture(u_velocity, uv - texture(u_velocity, uv).xy * u_dt * u_texelScale).xy * u_dissipation`
- `SPLAT_FRAG`: additive Gaussian: `base + u_force * exp(-dot(p,p) / u_radius²)` (one draw per force, blending OFF, read prev ping)
- `CURL_FRAG`, `VORTICITY_FRAG` (confinement: `force = u_vorticity * normalize(∇|curl|)⊥ * curl * u_dt`), `DIVERGENCE_FRAG`, `PRESSURE_FRAG` (Jacobi), `GRADIENT_FRAG` (subtract ∇p)
- `step(dt, forces, { vorticity, dissipation })` runs the seven-pass sequence; clamp `dt` to [1/240, 1/30].
- `velocityTexture()` returns the current ping texture; `resize(w,h)` disposes+recreates targets (mirror `rebuildTargets` guard style); `dispose()` deletes everything.

Implement completely — every shader string and pass written out, no stubs. This file is GL code verified by typecheck + the live smoke (Task 5); only the pure seam has a unit test.

- [ ] **Step 4: Run — verify PASS** (`node scripts/eviland-fluid-test.mjs`). All seam assertions green.

- [ ] **Step 5: npm script + typecheck + commit**

`package.json` (next to the other eviland tests): `"test:eviland-fluid": "node scripts/eviland-fluid-test.mjs",`
Run `npm run typecheck` (clean).
```bash
git add src/visualizer/eviland-fluid.ts scripts/eviland-fluid-test.mjs package.json
git commit -m "Eviland: stable-fluids solver module + audio→force seam (unit-tested)

createFluidSim: velocity self-advection, force splats, vorticity confinement,
Jacobi pressure projection on RG16F/R16F ping-pongs; returns null when float
targets are unsupported. fluidForcesFromFrame maps the onset bus to momentum:
kick=radial shockwave, snare=alternating jets, hats=top turbulence, bass/pan=
shear+bias, pre-beat inhale. Pure seam unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Operator channels + randomizer (seed-stable)

**Files:** Modify `src/visualizer/eviland-operators.ts`, `src/visualizer/eviland-randomizer.ts`; Create `scripts/eviland-operators-test.mjs`; Modify `package.json`.

- [ ] **Step 1: Capture goldens from CURRENT code, write the two-part test**

FIRST run (against unmodified code) a quick capture:
```bash
node -e "
import('esbuild').then(async ({ build }) => {
  await build({ entryPoints: ['src/visualizer/eviland-randomizer.ts'], bundle: true, format: 'esm', platform: 'node', outfile: 'tmp/rand-cap.mjs', logLevel: 'silent' });
  const { generate } = await import('./tmp/rand-cap.mjs');
  for (const seed of [42, 1337]) {
    const c = generate(seed).config;
    console.log(seed, JSON.stringify({ zoom: c.zoom.base, rotate: c.rotate.base, swirl: c.swirl.base, hueCycle: c.hueCycle.base, decay: c.decay.base, warpAmp: c.warpAmp.base, mirrorMix: c.mirrorMix.base, archetype: c.archetype }));
  }
});"
```
Hardcode the printed values as `GOLDEN[42]` / `GOLDEN[1337]` in `scripts/eviland-operators-test.mjs`:

```js
// Channel plumbing + SEED-CODE STABILITY for the fluid channels. The goldens
// were captured from the randomizer BEFORE fluid/vorticity were added; they
// must never change, proving shared seed codes keep their exact look.
// Run: node scripts/eviland-operators-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-operators-test-result.txt');
writeFileSync(RESULT, '[eviland-operators-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/visualizer/eviland-randomizer.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-rand-bundle.mjs'), logLevel: 'silent',
});
const { generate, mutate } = await import(pathToFileURL(resolve('tmp/eviland-rand-bundle.mjs')).href);
await build({
  entryPoints: [resolve('src/visualizer/eviland-operators.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/eviland-ops-bundle.mjs'), logLevel: 'silent',
});
const { defaultConfig, cloneConfig, lerpConfig } = await import(pathToFileURL(resolve('tmp/eviland-ops-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const close = (a, b) => Math.abs(a - b) < 1e-9;

// --- GOLDENS (captured pre-change; replace with the real printed values) ---
const GOLDEN = {
  42: { /* paste captured object for seed 42 */ },
  1337: { /* paste captured object for seed 1337 */ },
};
for (const seed of [42, 1337]) {
  const c = generate(seed).config;
  const g = GOLDEN[seed];
  for (const k of ['zoom', 'rotate', 'swirl', 'hueCycle', 'decay', 'warpAmp', 'mirrorMix']) {
    if (!close(c[k].base, g[k])) fail(`seed ${seed} ${k}.base drifted: ${c[k].base} != ${g[k]}`);
  }
  if (c.archetype !== g.archetype) fail(`seed ${seed} archetype drifted`);
  log.push(`seed ${seed}: goldens hold (${c.archetype})`);
}

// --- fluid channels exist, in range, everywhere ---
for (const seed of [42, 1337, 7, 'NEON-RIVER']) {
  const c = generate(seed).config;
  if (!c.fluid || typeof c.fluid.base !== 'number') fail(`seed ${seed}: missing fluid channel`);
  if (!c.vorticity || typeof c.vorticity.base !== 'number') fail(`seed ${seed}: missing vorticity channel`);
  if (c.fluid && (c.fluid.base < 0 || c.fluid.base > 1)) fail(`seed ${seed}: fluid.base out of range`);
  if (c.vorticity && (c.vorticity.base < 0 || c.vorticity.base > 30)) fail(`seed ${seed}: vorticity.base out of range`);
}
log.push('fluid/vorticity present + in range across seeds');

// defaultConfig has them; clone/lerp roundtrip them.
const d = defaultConfig();
if (!d.fluid || !d.vorticity) fail('defaultConfig missing fluid channels');
const a = generate(42).config; const b = generate(1337).config;
const mid = lerpConfig(a, b, 0.5);
if (!close(mid.fluid.base, (a.fluid.base + b.fluid.base) / 2)) fail('lerpConfig does not interpolate fluid.base');
const cl = cloneConfig(a);
if (cl.fluid === a.fluid) fail('cloneConfig must deep-copy fluid channel');
if (!close(cl.fluid.base, a.fluid.base)) fail('cloneConfig fluid value mismatch');

// mutate keeps them in safe range.
const m = mutate(a, 1, 99);
if (m.fluid.base < 0 || m.fluid.base > 1) fail('mutate pushed fluid out of range');
log.push('default/clone/lerp/mutate plumbing OK');

const report = log.join('\n') + '\n' + (pass ? '[eviland-operators-test] PASS' : '[eviland-operators-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 2: Run — verify partial RED**: goldens PASS (unmodified code), fluid-channel assertions FAIL (channels don't exist). That split is the point.

- [ ] **Step 3: Add channels to `eviland-operators.ts`**

In `OperatorConfig` (after `flowY: Channel;` ~line 89): `fluid: Channel;` and `vorticity: Channel;` with doc comments (fluid = simulated-velocity influence on dye advection 0..1; vorticity = confinement strength 0..30). Add to `EvilandDynamics` (~118): `fluid: number; vorticity: number;`. Thread through `evalConfig` (~216; same `evalChannel` call pattern as zoom), `defaultConfig` (~266; `fluid: { base: 0.25, bindings: [{ feature: 'energy', gain: 0.2 }] }`-style matching existing channel literal shape — read a neighbor channel and copy its structure; `vorticity: { base: 8 }`-equivalent), `cloneConfig` (~308), `lerpConfig` (~340). Read each function and mirror exactly how `flowX` is handled in it.

- [ ] **Step 4: Randomizer — templates, derived-RNG minting, SAFE_RANGES, mutate**

In `eviland-randomizer.ts`:
- `ArchetypeTemplate` (~73) gains `fluid: ChannelSpec; vorticity: ChannelSpec;`. Add per-archetype values in `ARCHETYPE_TEMPLATES`: liquid/nebula fluid base range ~[0.5,1.0] vorticity [10,24]; tunnel/kaleidoscope [0.2,0.6]/[6,16]; lattice/strobe [0,0.25]/[0,8]. Match the existing ChannelSpec literal shape (read one to copy its fields).
- `generate()` (~858): after the existing `config` literal is built, mint the new channels from a **derived RNG** so the main draw sequence is untouched:
```ts
  // Derived RNG: existing shared seed codes must keep their exact look, so the
  // new channels must NOT consume draws from the main sequence.
  const fluidRng = new Rng(hashSeed(`${code}::fluid`));
  config.fluid = sampleChannel(fluidRng, template.fluid);
  config.vorticity = sampleChannel(fluidRng, template.vorticity);
```
(`hashSeed` import from './eviland-rng' if not present; `config` was `const` with all fields — either build these two before the literal and include them, or type the literal with them assigned after; keep it compiling cleanly with exactly this draw order.)
- `SAFE_RANGES` (~920): `fluid: { min: 0, max: 1 }, vorticity: { min: 0, max: 30 },`
- `mutate()` (~980): `next.fluid = mutateChannel(rng, 'fluid', next.fluid, a); next.vorticity = mutateChannel(rng, 'vorticity', next.vorticity, a);` alongside the existing channel lines.
- `decode()`/`classic()` need no change (they flow through `generate`/`defaultConfig`).

- [ ] **Step 5: Run — verify FULL GREEN** (`node scripts/eviland-operators-test.mjs`): goldens still hold AND fluid assertions pass. Also `node scripts/eviland-director-test.mjs` (still PASS — director just lerps configs).

- [ ] **Step 6: npm script + typecheck + commit**

`package.json`: `"test:eviland-operators": "node scripts/eviland-operators-test.mjs",`
`npm run typecheck` clean.
```bash
git add src/visualizer/eviland-operators.ts src/visualizer/eviland-randomizer.ts scripts/eviland-operators-test.mjs package.json
git commit -m "Eviland: fluid/vorticity operator channels, seed-stable randomizer wiring

fluid (sim influence) + vorticity (confinement) are full channels through
default/clone/lerp/eval/mutate with per-archetype ranges (liquid/nebula wet,
lattice/strobe crisp). Minted from a derived RNG so existing shared seed codes
render their exact prior look — enforced by golden-value test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Renderer integration

**Files:** Modify `src/visualizer/eviland.ts`.

- [ ] **Step 1: Construct the sim with tiering**

Near the quality knobs (~669-672) add:
```ts
  const fluidGrid = quality === 'high' ? 0.5 : quality === 'medium' ? 0.375 : 0;
  const fluidIterations = quality === 'high' ? 20 : 12;
```
After targets are first built (where field FBOs exist; read `rebuildTargets` ~786 and the initial sizing), create:
```ts
  let fluid = fluidGrid > 0
    ? createFluidSim(gl, { width: Math.max(64, Math.round(fieldW * fluidGrid)), height: Math.max(64, Math.round(fieldH * fluidGrid)), pressureIterations: fluidIterations })
    : null;
```
(import `createFluidSim`, `fluidForcesFromFrame` from './eviland-fluid'; use the actual field width/height variable names found in the file). In `rebuildTargets`, after the field targets resize, call `fluid?.resize(...)` with the same formula. In `dispose()`, call `fluid?.dispose()` before the context-loss teardown. Set `fluid = null` if creation returned null.

- [ ] **Step 2: Step the sim + new uniforms**

`FIELD_FRAG`: add `uniform sampler2D u_velocity;` and `uniform float u_fluid;` and change line ~198 from
```glsl
  src = clamp(src - u_flow + w, 0.001, 0.999);
```
to
```glsl
  vec2 simFlow = texture(u_velocity, src).xy * u_fluid;
  src = clamp(src - u_flow + w - simFlow, 0.001, 0.999);
```
Add `velocity`/`fluid` to the cached `fieldUni` map (~828-841). In `render()` before the field pass (~1171 where `evalConfig` runs): 
```ts
  const FLUID_ADVECT_SCALE = 0.9; // velocity is UV/s; premultiply by dt CPU-side
  if (fluid) fluid.step(dt, fluidForcesFromFrame(frame), { vorticity: dyn.vorticity, dissipation: 0.985 });
```
and when binding field uniforms: bind `fluid.velocityTexture()` to a free texture unit (follow the existing texture-unit usage in the field pass — `u_prev` is unit 0; use the next free unit) with `gl.uniform1i(fieldUni.velocity, UNIT)`, and `gl.uniform1f(fieldUni.fluid, fluid ? dyn.fluid * FLUID_ADVECT_SCALE * dt : 0)`. When `fluid` is null bind any existing texture (e.g. the prev field) to the unit and set `u_fluid = 0` — sampling is then multiplied by zero, exactly current math.

- [ ] **Step 3: Verify + commit**

`npm run typecheck` clean; `npm run smoke:visualizer` (module exports) PASS; `node scripts/eviland-director-test.mjs` + `node scripts/eviland-audio-test.mjs` still PASS.
```bash
git add src/visualizer/eviland.ts
git commit -m "Eviland: advect the dye through the simulated fluid velocity

Step the stable-fluids sim before the field pass and displace the feedback
sample by velocity * fluid-channel (premultiplied by dt). Composes with the
procedural warp/kaleido; u_fluid=0 (low tier / unsupported GPU / crisp looks)
is bit-identical to the previous math. Tiered grid + Jacobi iterations.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Sync, CI, full gate

**Files:** Modify `packages/eviland-core/sync.mjs`, `.github/workflows/ci.yml`.

- [ ] **Step 1:** Add `'eviland-fluid.ts',` to the MODULES list in `packages/eviland-core/sync.mjs` (lines ~23-29). Run `node packages/eviland-core/sync.mjs` then `--check` → expect **8/8 in sync**.
- [ ] **Step 2:** `.github/workflows/ci.yml` — after the Eviland Director test step add:
```yaml
      - name: Test — Eviland fluid forces + operator channels
        run: |
          npm run test:eviland-fluid
          npm run test:eviland-operators
```
- [ ] **Step 3: Full gate** — `npm run typecheck`; `test:eviland-fluid`; `test:eviland-operators`; `test:eviland-audio`; `test:eviland-director`; `smoke:visualizer`; sync `--check` 8/8. All green.
- [ ] **Step 4: Commit**
```bash
git add packages/eviland-core/sync.mjs packages/eviland-core/src/ .github/workflows/ci.yml
git commit -m "Eviland: sync fluid module into eviland-core (8/8) + gate fluid tests in CI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Live visual evidence

**Files:** none (verification only; controller runs this — needs the repaired local Electron).

- [ ] **Step 1:** `npm run smoke:eviland` → non-blank + reactive (the smoke's existing assertions).
- [ ] **Step 2:** `scripts/eviland-capture.mjs` — capture frames on a fixture track; visually confirm: kick produces an expanding momentum wave that keeps swirling after the hit; liquid/nebula looks visibly more fluid than lattice/strobe; low tier renders as before. Save before/after captures for the report.
- [ ] **Step 3:** No commit; report observations honestly (including any tuning needed — constants in `eviland-fluid.ts` are the knobs).

---

## Self-Review Notes
- **Spec coverage:** solver+seam→T1; channels+randomizer+seed-stability→T2; renderer integration+tiering→T3; sync+CI→T4; live evidence→T5. All spec sections mapped.
- **Name consistency:** `createFluidSim`/`FluidSim`/`FluidForce`/`fluidForcesFromFrame`/`MAX_FLUID_FORCES`, channels `fluid`/`vorticity`, uniforms `u_velocity`/`u_fluid`, knobs `fluidGrid`/`fluidIterations`, `FLUID_ADVECT_SCALE` — defined once, used consistently.
- **Honesty:** only the pure seam + operator plumbing are unit-tested; the GL solver and visual quality are verified by typecheck, smokes, and the live capture (T5) — explicitly scoped that way.
- **Goldens protocol:** captured from UNMODIFIED code in T2 Step 1 before any randomizer edit; the test will print actual values on failure for easy diagnosis.
- **Execution-time verifications:** exact field width/height variable names and the free texture unit in the field pass must be read from `eviland.ts` at implementation time (anchors given); `sampleChannel`/`ChannelSpec` literal shapes must be copied from neighbors.
