# Eviland — Operator Engine Design

Status: design spec, not yet implemented.
Owner: `src/visualizer/eviland-operators.ts` (NEW) + a 1-block surgical edit inside `src/visualizer/eviland.ts`.
Risk: LOW (additive). The existing default look is reproducible verbatim as one `OperatorConfig` (the "default" preset). That preset is the regression anchor for `scripts/eviland-capture.mjs` and `scripts/eviland-smoke.mjs`.

This document is the contract for the first piece of the **MilkDrop-class generative engine**: the data-driven warp/motion layer that replaces today's hardcoded per-frame formulas in `eviland.ts` (lines 1067-1105). It is the foundation that the Randomizer, Director, and "Eviland Studio" preset editor all sit on. A preset becomes a small JSON object → fully serializable → a 32-bit seed via `eviland-rng.ts` → shareable as a short code (`encodeSeedCode`).

---

## 1. Goals & non-goals

### Goals
1. **Replace** the hardcoded warp/motion block (`eviland.ts:1067-1105`) with a pure evaluator call. The replacement is a single 9-line block that calls `evalConfig(config, frame, time, sectionSeed)` and applies the result via the existing `fieldUni.*` uniforms. The uniform calls below `drawFullscreen()` stay byte-for-byte identical.
2. **Composable & audio-bindable** preset model. Every operator has a `base` value plus a list of feature bindings — each binding multiplies an `EvilandFrame` field (`kick`, `bass`, `centroid`, `width`, …) by a coefficient through an optional easing curve. Bindings sum, then a hard clamp keeps the engine safe.
3. **Zero-dep** TS. Same lift profile as `eviland-audio.ts` and `eviland-rng.ts`. Drops cleanly into the future `@eviland/core` package without dragging anything from `src/`.
4. **Pure** evaluator. No allocations on the hot path. No randomness — the only stochastic input is `sectionSeed` (which is already pre-baked per-section by the renderer).
5. **Safe by construction**. Even a hostile JSON config cannot crash or white-out the renderer: every field is `Number.isFinite`-checked, every output is clamped to ranges proven safe in the smoke tests.
6. **Regression anchor**. The function `defaultOperatorConfig()` reproduces today's formulas exactly. `scripts/eviland-capture.mjs` PNG output stays visually identical after the refactor.

### Non-goals (deliberately out of scope for this first PR)
- MilkDrop `.milk` equation parsing (per-pixel / per-frame string equations). The operator engine is a *fixed* set of binding slots — the same closed surface MilkDrop's `q1..q32` users compose against — but it is not a general expression VM. That is a follow-on (`eviland-equation.ts`) that compiles `.milk` to operator configs.
- The Randomizer (`eviland-randomizer.ts`), the Director, the shape/waveform layer beyond the existing 24-band spectrum sun. Those each take an `OperatorConfig` as their *output* and are designed in separate specs.
- Palette runtime swapping (palette is still read from CSS variables once per mount — out of scope until the Randomizer needs it).

---

## 2. Architecture summary

```
┌──────────────────────┐    EvilandFrame      ┌───────────────────────┐
│  Reactor (audio)     │ ───────────────────► │   Operator Engine     │
│  src/visualizer/     │                      │  eviland-operators.ts │
│  eviland-audio.ts    │                      │                       │
└──────────────────────┘                      │ evalConfig(cfg,frame, │
                                              │   time, sectionSeed)  │
┌──────────────────────┐    OperatorConfig    │   → OperatorOutput    │
│  Preset / Randomizer │ ───────────────────► │                       │
│  / Director          │                      │   pure, zero-dep      │
└──────────────────────┘                      └────────────┬──────────┘
                                                           │
                                                           ▼
                                              ┌───────────────────────┐
                                              │   eviland.ts render() │
                                              │   PASS 1 prelude      │
                                              │   gl.uniform1f(...)   │
                                              └───────────────────────┘
```

A `OperatorConfig` is a plain JSON document. It carries no functions, no class instances. The evaluator is the *only* code that reads it. Any UI, randomizer, director, file-save, or seed-share path can produce or consume the same config without coupling to the renderer.

---

## 3. Data model — `OperatorConfig`

All numeric fields are `number` and finite. All optional fields have well-defined defaults baked into the evaluator (never `undefined` at the gl boundary). The schema is versioned for forward-compatibility.

### 3.1 Top-level shape

```ts
// src/visualizer/eviland-operators.ts (NEW)

/**
 * Stable feature names from EvilandFrame that operators may bind to.
 * Kept as a closed string union so the evaluator can compile bindings into
 * direct field reads at config-prepare time (no string lookups on the hot path).
 */
export type EvilandFeature =
  | 'kick' | 'bass' | 'snare' | 'hat' | 'vocal'
  | 'energy' | 'centroid' | 'flatness' | 'crest' | 'rolloff'
  | 'width' | 'pan' | 'beatPhase' | 'beatConfidence' | 'novelty'
  | 'sectionReturn';

/**
 * A response curve applied to the feature value *before* it is multiplied by
 * the binding's coefficient. Keeps presets musical without needing to bake the
 * shape into the coefficient itself.
 */
export type EvilandCurve =
  | 'linear'    // x
  | 'square'    // x*x  — emphasises peaks
  | 'sqrt'      // √x   — emphasises quiet content
  | 'invert'    // 1-x
  | 'bipolar'   // 2x-1, clamped to [-1,1]
  | 'pulse';    // smoothstep(0.4, 0.6, x) — gated punch

/**
 * One audio-feature contribution to an operator's value.
 * value += curve(frame[feature]) * coef
 */
export interface FeatureBinding {
  feature: EvilandFeature;
  coef: number;             // signed; range typically [-2, 2]
  curve?: EvilandCurve;     // default 'linear'
}

/**
 * The composable unit. `base` is the resting value (what the operator outputs
 * when audio is silent), `bindings` are the audio-driven contributions, and
 * `time` is a fixed sinusoidal contribution to keep things alive even on a
 * silent track (used sparingly — most presets leave it 0).
 */
export interface OperatorSpec {
  base: number;
  bindings?: FeatureBinding[];
  time?: { amp: number; hz: number; phase?: number } | null;
}

/**
 * Per-section pseudo-random behaviour. `sectionSeed` is provided by the
 * renderer; the engine reads it through these knobs rather than hardcoding
 * `Math.floor(sectionSeed * 7) % 2 === 0` etc. all over the place.
 *
 * - `rotateSignFromSeed`: if true, the sign of `rotate` flips per section.
 * - `hueDirectionFromSeed`: if true, the sign of `hueCycle` flips per section.
 * - `rotateDriftFromSeed`: amplitude (radians/sec) of section-stable rotation
 *   drift derived from `sectionSeed`; the existing default is 0.0028.
 * - `mirrorCounts`: the kaleidoscope rotation order, picked per section.
 *   Empty array → mirror disabled (`mirrorN = 1`, `mirrorMix = 0`).
 */
export interface SectionBehaviour {
  rotateSignFromSeed?: boolean;
  hueDirectionFromSeed?: boolean;
  rotateDriftFromSeed?: number;
  mirrorCounts?: number[];
}

/**
 * Palette specification. v1 stores only role colours so the engine remains
 * compatible with the existing `EvilandPalette` consumed by render(). The
 * `source` field marks where the renderer should obtain the runtime palette;
 * for the regression anchor it is 'css', meaning "read from CSS vars as today".
 * A 'fixed' palette becomes the seed-driven Randomizer's hook.
 */
export interface PaletteSpec {
  source: 'css' | 'fixed';
  fixed?: {
    accent: [number, number, number];
    dark:   [number, number, number];
    light:  [number, number, number];
    bg:     [number, number, number];
  };
}

/**
 * Emitter / shape mapping. v1 is descriptive only — the operator engine does
 * not yet rewrite routeOnsets() — but the field is present so the JSON shape
 * is forward-compatible with the next PR that moves onset routing into config.
 * `routing` maps a reactor VoiceGroup to an emitter `kind` (0..4) and an
 * intensity scale; absent entries fall back to today's hardcoded routing.
 */
export interface EmitterSpec {
  routing?: Partial<Record<
    'kick' | 'bass' | 'snare' | 'hat' | 'vocal',
    { kind: 0 | 1 | 2 | 3 | 4; intensityScale?: number; jitter?: number }
  >>;
}

/**
 * Waveform / shape layer. v1: stub. The "bright reactive waveform layer"
 * lands in a follow-on PR; the spec is reserved here so configs are stable.
 * `mode = 'off'` keeps today's exact look (no waveform pass).
 */
export interface WaveformSpec {
  mode: 'off' | 'mono' | 'stereo';
  thickness?: number;   // px equivalent in NDC, default 0.004
  glow?: number;        // 0..1, default 0.5
}

/**
 * The whole preset. JSON-safe. `seed` is optional metadata — it is the seed
 * the Randomizer used to mint this config; the evaluator never reads it.
 */
export interface OperatorConfig {
  version: 1;
  id?: string;            // human label, e.g. 'default-eviland'
  seed?: string | number; // metadata only; renderer's sectionSeed is separate

  field: {
    decay:     OperatorSpec;
    warpAmp:   OperatorSpec;
    warpScale: OperatorSpec;
    flowX:     OperatorSpec;
    flowY:     OperatorSpec;
    zoom:      OperatorSpec;
    rotate:    OperatorSpec;
    hueCycle:  OperatorSpec;
    swirl:     OperatorSpec;
    mirrorMix: OperatorSpec;
  };

  section: SectionBehaviour;
  palette: PaletteSpec;
  emitters?: EmitterSpec;
  waveform?: WaveformSpec;
}
```

### 3.2 Output shape — `OperatorOutput`

The evaluator's return type matches the existing `fieldUni.*` set 1:1 so the renderer can `gl.uniform1f` each field without bookkeeping:

```ts
export interface OperatorOutput {
  decay:     number;  // [0.80, 0.91]   — see clamps §5
  warpAmp:   number;  // [0,     0.01]
  warpScale: number;  // [0.5,   8.0]
  flowX:     number;  // [-0.01, 0.01]
  flowY:     number;  // [-0.01, 0.01]
  zoom:      number;  // [-0.05, 0.10]
  rotate:    number;  // [-0.05, 0.05]   (radians/frame)
  hueCycle:  number;  // [-0.05, 0.05]
  swirl:     number;  // [0,     0.20]
  mirrorN:   number;  // integer in [1, 24] — derived from section.mirrorCounts
  mirrorMix: number;  // [0,     0.96]
}
```

Every range above is the proven-safe envelope from the existing smoke tests. The clamps in §5 enforce them on every frame, so a config with absurd `coef` values (whether human-typed, randomised, or director-generated) cannot punch through.

---

## 4. The evaluator — `evalConfig`

### 4.1 Signature

```ts
/**
 * Pure. Allocation-free on the hot path (the output object is supplied by the
 * caller via `out`, defaulting to a single module-scoped scratch object). Does
 * not read `Math.random`. Does not touch any GL state.
 *
 *  - `frame`        — current EvilandFrame from the reactor.
 *  - `time`         — seconds since renderer construction (same `time` that
 *                     today is passed to `gl.uniform1f(fieldUni.time, time)`).
 *  - `sectionSeed`  — float in [0, ~10) already baked by render() (see
 *                     eviland.ts:1023-1042). The evaluator treats it as opaque.
 *  - `out`          — optional pre-allocated `OperatorOutput`. The renderer
 *                     keeps one scratch instance per `EvilandRenderer` and
 *                     passes it every frame.
 */
export function evalConfig(
  config: OperatorConfig,
  frame: EvilandFrame,
  time: number,
  sectionSeed: number,
  out?: OperatorOutput,
): OperatorOutput;
```

### 4.2 Per-operator evaluation

```
value = base
     + Σ over bindings: curve(frame[feature]) * coef
     + (time.amp * sin(2π * time.hz * time + time.phase))   // if time block present
```

Each binding's `feature` is fetched via a tiny `featureOf(frame, name)` switch — compiled by V8 into a jump table; no object key string lookup on the hot path. `curve` is a tiny function (5 cases, all monomorphic). `coef` is the signed gain.

### 4.3 Curves — exact definitions

```ts
linear : x
square : x * x
sqrt   : Math.sqrt(Math.max(0, x))
invert : 1 - x
bipolar: clamp(2 * x - 1, -1, 1)
pulse  : (() => {
           const t = (x - 0.4) / 0.2;
           const u = t < 0 ? 0 : t > 1 ? 1 : t;
           return u * u * (3 - 2 * u);   // smoothstep(0.4, 0.6, x)
         })()
```

### 4.4 Section behaviour resolution

```
rotateSign = section.rotateSignFromSeed
              ? ((Math.floor(sectionSeed * 7) % 2) === 0 ? 1 : -1)
              : 1
rotateDrift = (section.rotateDriftFromSeed ?? 0) * (sectionSeed * 0.5 + 0.5)
hueSign    = section.hueDirectionFromSeed
              ? (sectionSeed < 0.5 ? -1 : 1)
              : 1
```

Final composition:
```
out.rotate   = rotateSign * (rotateDrift + evaluatedRotate)
out.hueCycle = hueSign    * evaluatedHueCycle
```

This keeps the regression formulas in *the operator engine* rather than the renderer — the renderer just does `gl.uniform1f`.

### 4.5 Mirror count resolution

```
counts = section.mirrorCounts ?? []
if counts.length === 0:
  out.mirrorN  = 1
  out.mirrorMix = 0
else:
  idx = Math.floor(sectionSeed * 13) % counts.length    // same modulus the
                                                        // current renderer
                                                        // uses (line 1101)
  raw = counts[idx]                                     // already validated
                                                        // by prepareConfig()
  out.mirrorN  = clampMirror(raw)                       // integer [1, 24]
  out.mirrorMix = evaluatedMirrorMix
```

### 4.6 Clamping (the safety floor)

After every operator is evaluated, the values are passed through `clampOutput(out)`:

```ts
out.decay     = clamp(out.decay,     0.80,  0.91);
out.warpAmp   = clamp(out.warpAmp,   0,     0.01);
out.warpScale = clamp(out.warpScale, 0.5,   8.0);
out.flowX     = clamp(out.flowX,    -0.01,  0.01);
out.flowY     = clamp(out.flowY,    -0.01,  0.01);
out.zoom      = clamp(out.zoom,    -0.05,   0.10);
out.rotate    = clamp(out.rotate,  -0.05,   0.05);
out.hueCycle  = clamp(out.hueCycle, -0.05,  0.05);
out.swirl     = clamp(out.swirl,     0,     0.20);
out.mirrorMix = clamp(out.mirrorMix, 0,     0.96);
out.mirrorN   = Math.max(1, Math.min(24, Math.round(out.mirrorN)));
```

`Number.isFinite` is checked once per output field; any NaN/Infinity is replaced by the operator's `base` (or 0 for flow/mirrorMix, 1 for mirrorN). This guarantees no `gl.uniform1f` ever receives a non-finite value — the existing renderer has no such guard today.

### 4.7 `prepareConfig` (one-time)

```ts
export function prepareConfig(input: OperatorConfig): OperatorConfig;
```

`prepareConfig` runs **once** when a preset is loaded (not per frame). It:
- Validates the top-level `version === 1` (throws on mismatch — Studio surfaces the error).
- Replaces `undefined`/missing operator sub-fields with the regression-anchor defaults.
- Filters `bindings[]` to keep only entries whose `feature` is in the `EvilandFeature` union and whose `coef`/`curve` are sane.
- Sanitises `section.mirrorCounts` to integers in [1, 24].
- Returns a frozen `OperatorConfig` — deep-frozen so the runtime can't accidentally mutate a preset.

The renderer holds one `OperatorConfig` reference + one `OperatorOutput` scratch, both built at `createEvilandRenderer()` time. Swapping presets is a single ref reassignment.

---

## 5. Defaults — the regression anchor

`defaultOperatorConfig()` returns the config that reproduces today's `eviland.ts:1067-1105` block exactly. This is the value `createEvilandRenderer` uses when no config is passed, so behaviour is byte-for-byte identical until a caller opts in.

```ts
export function defaultOperatorConfig(): OperatorConfig {
  return {
    version: 1,
    id: 'eviland-default',
    field: {
      // const decay = 0.84 + 0.05 * (1 - frame.flatness) - 0.02 * frame.crest;
      decay: {
        base: 0.84,
        bindings: [
          { feature: 'flatness', coef: -0.05 },   // 0.05 * (1-flatness) = 0.05 - 0.05*flatness
          { feature: 'crest',    coef: -0.02 },
        ],
        // baked constant: +0.05 absorbed into base → base 0.89? NO — see note.
      },
      // NOTE: the binding-only formulation can't add a bare +constant, so
      // `base` for `decay` is 0.84 + 0.05 = 0.89, and the `flatness` binding
      // becomes `coef: -0.05` (since 0.89 - 0.05*flatness ≡ 0.84 + 0.05*(1-flatness)).
      // The implementation MUST use base=0.89, coef=-0.05 — checked in the
      // regression unit test.
      //
      //          0.84 + 0.05*(1 - flatness) - 0.02*crest
      //        = 0.89 - 0.05*flatness - 0.02*crest
      //
      // The same equivalence pattern is applied to every operator below.

      // warpAmp: 0.0003 + frame.bass * 0.0010
      warpAmp:   { base: 0.0003, bindings: [{ feature: 'bass',  coef: 0.0010 }] },
      // warpScale: 2.5 + frame.width * 1.8
      warpScale: { base: 2.5,    bindings: [{ feature: 'width', coef: 1.8    }] },
      // flow: (frame.pan * 0.0008 + 0.00012, -0.00018)
      flowX:     { base: 0.00012, bindings: [{ feature: 'pan',  coef: 0.0008 }] },
      flowY:     { base: -0.00018 },
      // zoom: 0.0018 + kick*0.038 + bass*0.012
      zoom: {
        base: 0.0018,
        bindings: [
          { feature: 'kick', coef: 0.038 },
          { feature: 'bass', coef: 0.012 },
        ],
      },
      // rotate (pre-sign / pre-drift): energy*0.0090 + beatPhase*0.0014
      // The sign and the section-stable drift are applied by the evaluator
      // using `section.rotateSignFromSeed` and `section.rotateDriftFromSeed`.
      rotate: {
        base: 0,
        bindings: [
          { feature: 'energy',    coef: 0.0090 },
          { feature: 'beatPhase', coef: 0.0014 },
        ],
      },
      // hueCycle (pre-sign): 0.0028 + centroid*0.0090 + energy*0.0055
      hueCycle: {
        base: 0.0028,
        bindings: [
          { feature: 'centroid', coef: 0.0090 },
          { feature: 'energy',   coef: 0.0055 },
        ],
      },
      // swirl: 0.012 + width*0.030 + novelty*0.020
      swirl: {
        base: 0.012,
        bindings: [
          { feature: 'width',   coef: 0.030 },
          { feature: 'novelty', coef: 0.020 },
        ],
      },
      // mirrorMix: Math.min(0.96, 0.70 + energy*0.26) — the clamp(0,0.96) at
      // §4.6 reproduces the Math.min ceiling; the evaluator clamps last.
      mirrorMix: { base: 0.70, bindings: [{ feature: 'energy', coef: 0.26 }] },
    },
    section: {
      rotateSignFromSeed:  true,
      hueDirectionFromSeed: true,
      rotateDriftFromSeed: 0.0028,                       // matches line 1088
      mirrorCounts:        [4, 6, 8, 5, 6, 12],          // matches line 1100
    },
    palette: { source: 'css' },                          // today's behaviour
    emitters: undefined,                                 // routeOnsets stays as-is
    waveform: { mode: 'off' },
  };
}
```

A unit test in `src/visualizer/__tests__/eviland-operators.spec.ts` (new) will:
1. Call `defaultOperatorConfig()` → `prepareConfig` → `evalConfig` for a hand-picked frame.
2. Re-compute the same uniforms by running the verbatim formulas from `eviland.ts:1067-1105` on that frame.
3. Assert every output is equal to 1e-9 (decay, hueCycle, etc. — these are deterministic floats).

This is the regression anchor.

---

## 6. The minimal `eviland.ts` edit

### 6.1 Adopt the evaluator (constructor)

Near the existing field-uniform cache (`eviland.ts:749-765`), add:

```ts
import { type OperatorConfig, type OperatorOutput, defaultOperatorConfig, prepareConfig, evalConfig } from './eviland-operators';

// ... inside createEvilandRenderer, after the WebGL setup, before `function render(...)`:
let activeConfig: OperatorConfig = prepareConfig(defaultOperatorConfig());
const opsOut: OperatorOutput = {
  decay: 0.86, warpAmp: 0, warpScale: 2.5,
  flowX: 0, flowY: 0,
  zoom: 0, rotate: 0, hueCycle: 0, swirl: 0,
  mirrorN: 1, mirrorMix: 0,
};
```

Expose `setConfig` on the returned `EvilandRenderer` so the Randomizer / Director / Studio UI can swap presets at runtime (additive — does not change today's external API):

```ts
return {
  resize,
  render,
  dispose,
  setConfig(cfg: OperatorConfig) { activeConfig = prepareConfig(cfg); },
};
```

The `EvilandRenderer` interface (`eviland.ts:26-30`) gains one optional method — non-breaking.

### 6.2 Replace the hardcoded block

**`old_string`** — quoted verbatim from `src/visualizer/eviland.ts:1067-1106` (lines 1067 through 1106 inclusive; the trailing `drawFullscreen();` stays):

```ts
    // Decay: SHORT trails so drawn shapes stay crisp instead of stacking into a
    // featureless haze (the "smoke cloud"). The geometric zoom/rotate motion
    // carries the look; trails only need to last a few frames, not seconds.
    const decay = 0.84 + 0.05 * (1 - frame.flatness) - 0.02 * frame.crest;
    gl.uniform1f(fieldUni.decay, Math.max(0.80, Math.min(0.91, decay)));
    // Curl turbulence is the #1 source of "smoke" — keep it near zero so field
    // motion is clean geometric zoom/rotate/kaleidoscope, not fluid warp.
    gl.uniform1f(fieldUni.warpAmp, 0.0003 + frame.bass * 0.0010);
    gl.uniform1f(fieldUni.warpScale, 2.5 + frame.width * 1.8);
    gl.uniform2f(fieldUni.flow, frame.pan * 0.0008 + 0.00012, -0.00018);
    gl.uniform1f(fieldUni.time, time);
    gl.uniform1f(fieldUni.novelty, frame.novelty);
    gl.uniform1f(fieldUni.sectionSeed, sectionSeed);
    // MilkDrop-style motion — bolder than the previous tuning:
    //  • zoom: stronger base tunnel + kick punches in deeper.
    //  • rotate: always drifting; energy + beatPhase accelerate it.
    //  • hue cycle: visibly sweeps the palette (~2x previous range).
    //  • swirl: pronounced edge spin.
    // Lower base zoom so constant inward pull doesn't pile feedback energy into
    // a permanent bright focal blob at centre; kick/bass still punch the tunnel.
    const zoom = 0.0018 + frame.kick * 0.038 + frame.bass * 0.012;
    const rotateBase = 0.0028 * (sectionSeed * 0.5 + 0.5); // section-stable drift
    const rotateSign = ((Math.floor(sectionSeed * 7) % 2) === 0) ? 1 : -1;
    const rotate = rotateSign * (rotateBase + frame.energy * 0.0090 + frame.beatPhase * 0.0014);
    const hueCycle = (0.0028 + frame.centroid * 0.0090 + frame.energy * 0.0055) * (sectionSeed < 0.5 ? -1 : 1);
    const swirl = 0.012 + frame.width * 0.030 + frame.novelty * 0.020;
    gl.uniform1f(fieldUni.zoom, zoom);
    gl.uniform1f(fieldUni.rotate, rotate);
    gl.uniform1f(fieldUni.hueCycle, hueCycle);
    gl.uniform1f(fieldUni.swirl, swirl);
    // Kaleidoscope: the single most "MilkDrop" trait. ALWAYS on (no 0 entries)
    // and strongly mixed so the mirror symmetry actually reads — previously it
    // was off ~1/3 of sections and too faint to see even when active.
    const mirrorCounts = [4, 6, 8, 5, 6, 12];
    const mirrorIdx = Math.floor(sectionSeed * 13) % mirrorCounts.length;
    const mirrorN = mirrorCounts[mirrorIdx]!;
    const mirrorMix = Math.min(0.96, 0.70 + frame.energy * 0.26);
    gl.uniform1f(fieldUni.mirror, mirrorN);
    gl.uniform1f(fieldUni.mirrorMix, mirrorMix);
    drawFullscreen();
```

**`new_string`** — the surgical replacement (12 lines including `time`/`novelty`/`sectionSeed` which remain renderer-owned since they are not operator outputs):

```ts
    // Operator engine: replace the hardcoded warp/motion block. Every value
    // below comes from the active OperatorConfig via a pure evaluator. The
    // regression-anchor default reproduces the previous formulas exactly; see
    // docs/eviland/design-operators.md and the unit test in
    // src/visualizer/__tests__/eviland-operators.spec.ts.
    evalConfig(activeConfig, frame, time, sectionSeed, opsOut);
    gl.uniform1f(fieldUni.decay,     opsOut.decay);
    gl.uniform1f(fieldUni.warpAmp,   opsOut.warpAmp);
    gl.uniform1f(fieldUni.warpScale, opsOut.warpScale);
    gl.uniform2f(fieldUni.flow,      opsOut.flowX, opsOut.flowY);
    gl.uniform1f(fieldUni.time,        time);
    gl.uniform1f(fieldUni.novelty,     frame.novelty);
    gl.uniform1f(fieldUni.sectionSeed, sectionSeed);
    gl.uniform1f(fieldUni.zoom,      opsOut.zoom);
    gl.uniform1f(fieldUni.rotate,    opsOut.rotate);
    gl.uniform1f(fieldUni.hueCycle,  opsOut.hueCycle);
    gl.uniform1f(fieldUni.swirl,     opsOut.swirl);
    gl.uniform1f(fieldUni.mirror,    opsOut.mirrorN);
    gl.uniform1f(fieldUni.mirrorMix, opsOut.mirrorMix);
    drawFullscreen();
```

Nothing else in `render()` changes. The `routeOnsets` call, the bloom/aberration envelopes, the spectrum sun, the ping-pong swap, the bloom pyramid, and the POST composite are all untouched.

### 6.3 Files added/changed

| Path                                              | Change       | Notes                                                                 |
|---------------------------------------------------|--------------|-----------------------------------------------------------------------|
| `src/visualizer/eviland-operators.ts`             | **NEW**      | The evaluator + types + `defaultOperatorConfig()` + `prepareConfig`.  |
| `src/visualizer/eviland.ts`                       | EDIT (one block + 4 lines of setup + 1 method on the return) | See §6.1 / §6.2.                                |
| `src/visualizer/__tests__/eviland-operators.spec.ts` | **NEW**   | Regression test: default config ≡ verbatim hardcoded formulas, plus clamp safety.  |
| `docs/eviland/design-operators.md`                | **NEW**      | This document.                                                         |

No other file touches. `Visualizer.tsx`, `FullscreenVisualizer.tsx`, `electron/main.ts`, `eviland-audio.ts`, `eviland-rng.ts` — all untouched.

---

## 7. Verification plan

1. `npm run typecheck` — must pass. The `EvilandRenderer` interface gains an optional `setConfig?`; any consumer that doesn't call it stays compatible.
2. `node scripts/eviland-smoke.mjs` — must keep printing `[eviland-smoke] PASS` with `groups.length >= 2`. The operator engine is on the default config, which reproduces today's formulas; the smoke gate (lit-pixel count + onsets + groups) should be identical.
3. `node scripts/eviland-capture.mjs` — open `tmp/eviland-capture.png`. Must be visually identical to the pre-refactor capture (use a saved baseline; do a per-pixel diff if anything looks off). The "gold/cream smoke" regression is the easiest failure mode; the clamps in §4.6 are the explicit guard against re-introducing it.
4. New unit test (Vitest, runs under `npm test`):
   - `evalConfig(prepareConfig(defaultOperatorConfig()), frame, time, sectionSeed)` ≡ the verbatim formulas for 8 hand-picked frames (silent, all-bass, full-energy, ⅛-pan, return-to-section-2, etc.).
   - Hostile configs (NaN coefficients, missing operators, `mirrorCounts: [99999]`, `coef: Infinity`) → outputs all stay inside the §4.6 ranges, no exceptions thrown.
5. Manual smoke: run the app, switch to Eviland, play a kick-heavy track, confirm the look is identical to v1.7.1. Open devtools, evaluate `(window as any).__eviland?.setConfig?.(…)` if a debug hook is wired (optional, not in this PR's surface).

---

## 8. What this unlocks (follow-on PRs, NOT in this one)

- **Randomizer** (`eviland-randomizer.ts`): `randomizeConfig(seed: string | number, opts) → OperatorConfig`. Uses `Rng` from `eviland-rng.ts`. Picks operator `base` values, binding coefficients, curves, and `section.mirrorCounts` from musically-coherent weighted distributions. A 32-bit seed mints an identical look forever → shareable as `encodeSeedCode(seed)` ("K7Q2-9XMF").
- **Lock & share**: a single "lock" toggle freezes `sectionSeed` and the current config; the seed code goes onto the clipboard. Paste anywhere → `decodeSeedCode` → `randomizeConfig` → identical visual.
- **Director**: an autonomous "AI VJ" that watches the reactor's `sectionChanged`, `bpm`, `energy`, and section-recurrence and *interpolates between configs* over musically-meaningful transitions. Because configs are pure JSON, interpolation is a per-field lerp; nothing in the renderer needs to know.
- **MilkDrop equation import** (`eviland-equation.ts`): compile `.milk` per-frame equations to `OperatorConfig`. The closed binding set above is the *target IR* — every `.milk` per-frame variable maps to one or more bindings on `zoom`, `rotate`, `decay`, `warpAmp`, etc.
- **Eviland Studio** preset editor: a simple form UI over `OperatorConfig`. Sliders for `base`, +Add Binding for `bindings[]`, a dropdown for `feature` and `curve`. Save/Load is `JSON.stringify` / `JSON.parse`.
- **Waveform layer, live mic/line-in, detached visualizer window, MP4 record** — each independent, each from `docs/eviland/map-integration.md` §8. None of them touch the operator engine after this PR lands.

---

## 9. Critical notes for the implementer

- **The regression-anchor unit test is mandatory.** Without it, the refactor is indistinguishable from a subtle behaviour change (e.g. forgetting that `0.84 + 0.05 * (1 - flatness)` collapses to `0.89 - 0.05 * flatness`). Bake the test before the renderer edit.
- **`flow` becomes two operators** (`flowX`, `flowY`) so the binding model stays uniform. The renderer reads both and packs them into `gl.uniform2f`. The default config keeps `flowY` as a bare `base` (no bindings) — exactly matching the `-0.00018` constant.
- **`mirror` is special**: it's an integer selected per *section*, not a continuous per-frame value. The evaluator computes it from `section.mirrorCounts` + `sectionSeed`; bindings on `mirrorMix` only affect the mix, not the count. Configs with `mirrorCounts: []` get `mirrorN = 1, mirrorMix = 0` (effectively kaleidoscope off).
- **`sectionSeed` is opaque to the engine.** Today the renderer derives it from `frame.sectionId` (line 1030); the operator engine never touches that derivation. This keeps the section-memory pillar — and the existing `sectionSeeds[]` replay-on-return behaviour — entirely renderer-owned.
- **No allocations on the hot path.** The evaluator writes into the caller-supplied `out` object. The renderer reuses `opsOut` for the lifetime of the `EvilandRenderer`. The only per-call object reads are `frame`, `config.field.<op>`, `config.section` — all stable refs since `prepareConfig` froze them at load time.
- **NaN/Infinity guard is non-optional.** The pre-refactor renderer trusts every `frame.*` value to be finite (the reactor enforces this) and every formula to be safe. The operator engine accepts third-party config JSON; one stray `coef: NaN` would propagate through `gl.uniform1f` and white-out the screen on some drivers. The §4.6 clamp + finite-check is the only barrier.
- **Don't expand the binding set in this PR.** Stick to the existing `fieldUni` surface (decay, warpAmp, warpScale, flow{X,Y}, zoom, rotate, hueCycle, swirl, mirror, mirrorMix). Bloom threshold, aberration ceiling, saturation floor, hueShift, terrain colour — those are tempting but each introduces a new GL uniform binding and a wider regression surface. They go in a follow-on "post-stage operators" PR with the same pattern.
- **`smoke` flag stays a renderer-level option.** The operator engine has no awareness of smoke mode; the existing `preserveDrawingBuffer: smoke` path is untouched.
- **No GL state inside the evaluator.** This sounds obvious but is the #1 way a "pure" function silently breaks. The evaluator's only side effect is writing into `out`. If a future contributor adds `gl.uniform1f` calls inside `evalConfig`, the file no longer belongs in `@eviland/core`.
