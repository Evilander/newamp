# Eviland — Randomizer Design

Status: design spec, not yet implemented.
Owner: `src/visualizer/eviland-randomizer.ts` (NEW).
Depends on (already shipped):
- `src/visualizer/eviland-operators.ts` — `OperatorConfig`, `Channel`, `Binding`, `AudioFeature`, `Curve`, `WaveformConfig`, `PaletteConfig`, `cloneConfig`, `lerpConfig`.
- `src/visualizer/eviland-rng.ts` — `Rng` (mulberry32), `hashSeed` (FNV-1a), `toSeedState`, `encodeSeedCode` / `decodeSeedCode` (Crockford-ish 8-char `XXXX-XXXX` codes).
- `src/visualizer/eviland.ts` — `setConfig(cfg)` on the renderer (already exposed by the operator-engine PR).

Risk: LOW (additive). The randomizer is a pure function; the only renderer touch is calling `renderer.setConfig(cfg)` from the Visualizer UI.

This module is the third pillar of the generative engine:
1. **Operator engine** (shipped) — turns a `OperatorConfig` + audio frame into uniforms.
2. **RNG toolkit** (shipped) — deterministic, seed-driven `Rng` + share codes.
3. **Randomizer** (this spec) — mints `OperatorConfig` values from a seed using a musically-coherent grammar; supports lock/recall, ephemeral default, and mutate/evolve.

The Director (Phase 6) consumes randomizer output too — it cross-fades between configs minted from different archetypes using `lerpConfig`. Nothing in the Director needs to know how a config was minted.

---

## 1. Goals & non-goals

### Goals
1. **Unexpected but coherent.** Every minted look must be visually distinct from the default and from other seeds, *but never broken*: no white-out, no black-out, no seizure-strobe, no stalled "frozen frame". Coherence comes from (a) hierarchical sampling within archetype templates, (b) correlated parameter draws (a high-energy archetype picks decay/zoom/swirl together, not independently), and (c) the operator-engine clamps as a final safety floor.
2. **Deterministic, shareable, recall-able.** A 32-bit state → exactly one config, forever, on any machine. Encoded as `encodeSeedCode(state)` → `K7Q2-9XMF`. Pasting that string back mints the identical visual.
3. **Ephemeral by default.** A user who hits Randomize without locking gets a seed they never see twice — derived from a monotonic *track-tick* counter (not the wall clock, which the runtime instructs us to avoid for determinism reasons and which would make captures non-reproducible). The current seed is always visible in the UI so the user can lock it after the fact.
4. **Two levels of variation.** *Parametric* (sample `Channel.base` + binding `gain` + `curve`) AND *structural* (which bindings exist at all; which `mirrorSet`; waveform `mode` on/off/which; palette tinting; emitter scale/gain).
5. **Mutate / evolve.** A small perturbation operator for live morphing (Director uses this between cross-fades; the UI uses it for an "evolve" button that nudges the current locked look without leaving its neighbourhood).
6. **Zero-dep, JSON-safe, pure.** Same lift profile as `eviland-operators.ts` and `eviland-rng.ts`. Drops into the future `@eviland/core` package unchanged.

### Non-goals (out of scope for this PR)
- The Director's beat-synced crossfade scheduler (Phase 6). The randomizer exposes the building blocks (`generate`, `mutate`, archetype labels); the Director composes them.
- The full Studio preset editor UI. The Randomize/Lock toolbar control specified in §7 is the *minimum* surface in NewAmp; Studio gets sliders later.
- `.milk` import. The randomizer mints native configs; `eviland-equation.ts` is a separate path.
- Palette generation from album art / cover image extraction. The randomizer's palette generator is procedural (§5); the album-art bridge is a follow-on.
- A back-end "preset zoo" or social share. Codes work locally + via copy-paste; no network.

---

## 2. Architecture summary

```
                              seed: string | number
                                       │
                                       ▼
                              ┌────────────────────┐
                              │  toSeedState +     │
                              │  mulberry32        │  ← shipped (eviland-rng.ts)
                              └────────┬───────────┘
                                       │ Rng
                                       ▼
   ┌──────────────────┐    pick    ┌────────────────────┐
   │  ARCHETYPES[]    │ ─────────► │ chooseArchetype()  │
   │  (§4 templates)  │            └────────┬───────────┘
   └──────────────────┘                     │ archetype
                                            ▼
                                  ┌────────────────────┐
                                  │ sampleConfig(arch, │
                                  │   rng)             │  ← §4: per-archetype
                                  └────────┬───────────┘    parametric+structural
                                           │ OperatorConfig
                                           ▼
                                  ┌────────────────────┐
                                  │ sanitiseConfig()   │  ← §6 belt-and-braces
                                  │   + freeze         │    (operator engine
                                  └────────┬───────────┘    clamps are the
                                           │                final floor)
                                           ▼
                              ┌────────────────────────┐
                              │ { config, seed,        │
                              │   state, code,         │
                              │   archetype }          │
                              └────────────────────────┘
```

A `GenerateResult` is the unit of share/recall:

```ts
export interface GenerateResult {
  config: OperatorConfig;   // ready for renderer.setConfig(...)
  seed: string | number;    // what the caller passed in (echo)
  state: number;            // 32-bit canonical state
  code: string;             // encodeSeedCode(state) — share string
  archetype: string;        // human label, e.g. 'tunnel-storm'
}
```

`config.seed` is also stamped with `code` and `config.archetype` with the label, so a config loaded later (without re-running the randomizer) still tells the UI what it is.

---

## 3. Public API — `src/visualizer/eviland-randomizer.ts`

```ts
import { type OperatorConfig, cloneConfig } from './eviland-operators';
import { Rng, toSeedState, encodeSeedCode, decodeSeedCode } from './eviland-rng';

/** Stable list of archetype ids — closed union so Studio / Director can switch on it. */
export type ArchetypeId =
  | 'tunnel-storm'    // hard kick-driven zoom punch, mirror 4/6, hot palette
  | 'aurora-drift'    // slow swirl, high hueCycle, cool palette, low mirror
  | 'lattice-bloom'   // high mirror (8/12/16), structured pulse, jewel palette
  | 'feedback-haze'   // soft decay, big warp, dreamy desaturated palette
  | 'spectrum-grid'   // waveform=bars on, low warp, neon palette
  | 'lissajous-pulse' // waveform=lissajous on, mid mirror, monochrome+accent
  | 'classic-plus';   // a perturbation around the default 'Eviland Classic'

export interface ArchetypeWeights {
  /** Override the uniform pick. Keys absent → use the default weight (1). */
  weights?: Partial<Record<ArchetypeId, number>>;
}

export interface GenerateOptions extends ArchetypeWeights {
  /** Force a specific archetype (overrides weights). */
  archetype?: ArchetypeId;
}

export interface GenerateResult {
  config: OperatorConfig;
  seed: string | number;
  state: number;
  code: string;
  archetype: ArchetypeId;
}

/**
 * Mint a config from a seed.
 *
 * Determinism contract:
 *   generate(seed) ≡ generate(seed)            for the same seed value.
 *   generate(seed).code = encodeSeedCode(state(seed))
 *   decodeSeedCode(generate(seed).code) = generate(seed).state
 *
 * Pure. No Math.random. No Date.now. No platform RNG. Uses only `Rng`.
 */
export function generate(seed: string | number, opts?: GenerateOptions): GenerateResult;

/**
 * Sugar: mint from a share code (`K7Q2-9XMF`). Falls back to FNV-1a hash of the
 * raw string if the code is malformed — so users can paste anything and it works.
 */
export function generateFromCode(code: string, opts?: GenerateOptions): GenerateResult;

/**
 * Perturb a config in place-of-value (returns a fresh frozen config). `amount`
 * is 0..1 — 0 is identity, 1 jumps ~ a full archetype distance. The Director's
 * inter-section morph uses `amount ≈ 0.08`; an "Evolve" UI button uses ~0.25.
 *
 * Determinism: mutate(cfg, amount, seed) ≡ mutate(cfg, amount, seed).
 *
 * `mutate` preserves the archetype label (it does not jump templates), so a
 * locked look stays *recognisably itself* across many mutations.
 */
export function mutate(cfg: OperatorConfig, amount: number, seed: string | number): OperatorConfig;

/**
 * Bidirectional bridge to `eviland-rng` so callers don't import two modules
 * for the basic "seed ↔ code" round-trip. These are thin re-exports.
 */
export function encodeConfigSeed(state: number): string;     // = encodeSeedCode
export function decodeConfigSeed(code: string): number | null; // = decodeSeedCode

/**
 * Ephemeral-seed helper. Caller passes a monotonic counter (e.g. `++randomizeTick`)
 * and an optional namespace (track id, session id) — the result is a seed that:
 *   - is unique per tick (so consecutive Randomize presses never repeat),
 *   - is deterministic given (namespace, tick), so a capture script can replay,
 *   - does NOT consult Date.now / Math.random (forbidden by the runtime contract).
 */
export function ephemeralSeed(tick: number, namespace?: string): number;
```

The functions above are the *entire* public surface. The renderer doesn't import this file at all — `Visualizer.tsx` calls `generate()` and passes `result.config` to `renderer.setConfig`.

---

## 4. The grammar — archetype templates

An archetype is a *correlated* slice of the OperatorConfig space. We sample within an archetype so the resulting look is internally consistent (decay × swirl × emitterScale move together, not independently), which is the difference between "unexpected" and "broken".

Each template is a plain object — no executable code at definition time — read by `sampleConfig(archetype, rng)`. The template lists, for each field that varies, a *distribution*. The randomizer picks from those distributions in a *fixed call order* so determinism is preserved.

### 4.1 Distribution primitives

Every field in a template is one of:

```ts
type DistU      = { kind: 'u'; min: number; max: number };               // uniform
type DistN      = { kind: 'n'; mean: number; std: number; min?: number; max?: number }; // gaussian + clip
type DistPick<T>= { kind: 'pick'; values: readonly T[]; weights?: readonly number[] };
type DistConst<T>= { kind: 'const'; value: T };
type Dist<T = number> = DistU | DistN | DistPick<T> | DistConst<T>;
```

A helper `sample(dist, rng): T` exists in the module (private, ~25 LOC); it uses `rng.range`, `rng.gaussian`, `rng.weighted`/`rng.pick`, or just returns the constant. All gaussians are clipped at `min`/`max` to keep tails inside the operator-engine clamp.

### 4.2 Binding template

A binding template lists candidate features and a per-feature distribution for the gain plus an optional curve picker:

```ts
interface BindingTemplate {
  feature: AudioFeature;
  gain: Dist<number>;
  curve?: Dist<Curve>;          // omitted = always 'linear'
  /** Probability this binding is included (default 1.0). */
  prob?: number;
}

interface ChannelTemplate {
  base: Dist<number>;
  bindings: BindingTemplate[];  // each included independently per `prob`
}
```

When sampling, a channel calls `sample(base)` then walks `bindings`: for each, draws `rng.bool(prob)`; if true, adds `{ feature, gain: sample(gain), curve: sample(curve) }`. This is the *structural* layer (which bindings exist) on top of the *parametric* layer (sampled values).

### 4.3 An archetype template

```ts
interface ArchetypeTemplate {
  id: ArchetypeId;
  weight: number;                            // default chooseArchetype() weight

  field: {
    zoom:      ChannelTemplate;
    rotate:    ChannelTemplate;
    swirl:     ChannelTemplate;
    hueCycle:  ChannelTemplate;
    decay:     ChannelTemplate;
    warpAmp:   ChannelTemplate;
    warpScale: ChannelTemplate;
    mirror:    ChannelTemplate;             // continuous fallback if no mirrorSet
    mirrorMix: ChannelTemplate;
    flowX:     ChannelTemplate;
    flowY:     ChannelTemplate;
    bloom:     ChannelTemplate;
  };

  /** Structural picks for the kaleidoscope. Empty = use continuous mirror. */
  mirrorSets: Dist<readonly number[]>;

  spinFromSection: Dist<boolean>;

  waveform: {
    mode:      Dist<WaveMode>;
    intensity: ChannelTemplate;
    thickness: Dist<number>;
    scale:     Dist<number>;
  };

  palette: PaletteTemplate;                  // see §5
  emitterScale: Dist<number>;
  emitterGain:  Dist<number>;
}
```

`ARCHETYPES: Record<ArchetypeId, ArchetypeTemplate>` lives at module scope. Adding an archetype = adding one object — no other code changes.

### 4.4 Required call order (the determinism contract)

`sampleConfig` *must* draw from `rng` in this order; changing the order changes every existing seed's output. **This order is the spec.**

```
1. field.zoom.base, then each zoom.binding in declared order (prob, gain, curve)
2. field.rotate (same pattern)
3. field.swirl
4. field.hueCycle
5. field.decay
6. field.warpAmp
7. field.warpScale
8. field.mirror
9. field.mirrorMix
10. field.flowX
11. field.flowY
12. field.bloom
13. mirrorSets
14. spinFromSection
15. waveform.mode, .intensity (base + bindings), .thickness, .scale
16. palette (see §5 for its own internal order)
17. emitterScale, emitterGain
```

A unit test asserts that re-running `sampleConfig` on the same archetype with the same seed produces a byte-equal config (after `JSON.stringify`).

### 4.5 The seven archetypes — descriptive intent (full templates ship in code)

The full numeric templates live in `eviland-randomizer.ts`. The intent guide for the implementer:

- **`classic-plus`** — A gentle perturbation around `defaultConfig()`. Used as the fallback when the user wants "different but familiar". All channel `base` distributions are gaussians of mean = default, std ≈ 10-15% of the operator's clamp range. Binding probabilities ≥ 0.8. Default palette source (`palette: null` ≈ host CSS). `mirrorSet` is one of `[4,6,8]`, `[4,6,8,5,6,12]` (the historical), `[6]`, `[8]`. Waveform `off` with prob 0.7, `line` with prob 0.3.
- **`tunnel-storm`** — Hot, kick-driven zoom punch. `zoom.base ~ u(0.005, 0.015)`, `zoom` bindings on `kick` (gain 0.05-0.10) and `bass` (0.015-0.030). `mirrorSets: [4,6], [6,8], [4]` — low counts, strong symmetry. `mirrorMix.base ~ u(0.85, 0.97)`. `decay.base ~ u(0.84, 0.90)` (short trails — keep punches crisp). Palette: hot — `accent` in red/orange wedge, `light` near white.
- **`aurora-drift`** — Slow, hue-saturated drift. `swirl.base ~ u(0.04, 0.12)`, `swirl` binding on `width` (gain 0.05-0.08). `hueCycle.base ~ u(0.008, 0.020)` (visibly sweeps palette). `mirrorSets` includes `[]` (no kaleidoscope) with prob 0.4. `decay.base ~ u(0.90, 0.95)` (long trails). Palette: cool — `accent` in cyan/teal/magenta wedge.
- **`lattice-bloom`** — Hard kaleidoscope geometry. `mirrorSets: [8,12], [12,16], [6,12,16]`. `mirrorMix.base ~ u(0.90, 0.97)`. Lower swirl (mirror does the work). `bloom.base ~ u(0.4, 0.9)` (jewel highlights). Palette: jewel — saturated, dark `bg`, bright `light`.
- **`feedback-haze`** — Soft, dreamy. `decay.base ~ u(0.92, 0.96)` (long trails). `warpAmp.base ~ u(0.003, 0.008)`, `warpScale.base ~ u(2.5, 5.0)` (visible curl detail). `mirrorMix.base ~ u(0.40, 0.70)` (kaleidoscope present but not dominant). Palette: desaturated — pastel, lifted `bg`.
- **`spectrum-grid`** — Waveform-led. `waveform.mode = 'bars'` (prob 0.7) or `'line'` (0.3). `mirrorMix.base ~ u(0.0, 0.4)` (low — let the bars read). `warpAmp.base ~ u(0, 0.0008)` (low warp — keep the grid crisp). Palette: neon — high-chroma `accent` against deep `dark`.
- **`lissajous-pulse`** — `waveform.mode = 'lissajous'`. `mirror` low (`mirrorSets: [4], [6]`). `swirl` mid. Palette: monochrome `dark`/`light` + a single saturated `accent`.

Each archetype gets a roughly equal default `weight: 1` except `classic-plus` (weight 0.6 — it's the "boring safety choice"). The caller can override via `opts.weights`.

---

## 5. Palette generator

Palettes use the existing `PaletteConfig` type (`bg, dark, accent, light` as `[r,g,b]` in 0..1). The generator runs in HSL space for musical control, then converts to RGB.

```ts
interface PaletteTemplate {
  /** 'css' uses null → host CSS vars; 'fixed' generates from HSL knobs. */
  source: Dist<'css' | 'fixed'>;
  /** Centre hue in degrees [0, 360). */
  hue: Dist<number>;
  /** Width of the hue band the four roles are spread across, in degrees. */
  hueSpread: Dist<number>;
  /** Saturation for accent/light. dark/bg use saturation*0.6. */
  saturation: Dist<number>;
  /** Lightness of the `light` colour. `accent` is light - 0.18 (clamped). */
  lightness: Dist<number>;
  /** Lightness of `dark`. `bg` is dark * 0.35 (clamped to ≥ 0.02). */
  darkness: Dist<number>;
  /** Hue rotation for `accent` relative to `light`, in degrees [-60, 60]. */
  accentSkew: Dist<number>;
}
```

### 5.1 Sampling order (palette internal)

1. `source` → if `'css'`, palette is `null` and the rest of the draws are *skipped*. (Important: the caller must skip them, not consume them, so the seed cost of `'css'` is exactly 1 draw — keeps archetypes that often pick CSS still varied across their non-palette draws. Document this in the implementation.)
2. If `'fixed'`: `hue`, `hueSpread`, `saturation`, `lightness`, `darkness`, `accentSkew`.

### 5.2 HSL → RGB

Standard formula — `hslToRgb(h, s, l)` is private in the file (~20 LOC). Inputs `h ∈ [0,360)`, `s,l ∈ [0,1]`; outputs `[r,g,b] ∈ [0,1]`. The four roles:

```
H_dark   = hue
H_bg     = hue
H_accent = (hue + accentSkew + 360) % 360
H_light  = (hue - hueSpread*0.3 + 360) % 360

S_low    = saturation * 0.6
S_high   = saturation

L_light  = lightness                  // typically 0.78..0.92
L_accent = clamp(lightness - 0.18, 0.45, 0.85)
L_dark   = darkness                   // typically 0.08..0.22
L_bg     = max(0.02, darkness * 0.35)

palette.bg     = hslToRgb(H_bg,     S_low,  L_bg)
palette.dark   = hslToRgb(H_dark,   S_low,  L_dark)
palette.accent = hslToRgb(H_accent, S_high, L_accent)
palette.light  = hslToRgb(H_light,  S_high, L_light)
```

### 5.3 Safety floor for palettes

The existing renderer (`postRamp`) cannot collapse the palette ramp when `dark ≈ light` (the "gold/cream smoke" bug fixed in v1.7.4 was a hue-collapse issue downstream of this exact pair). The randomizer must enforce a minimum *luminance contrast* between `dark` and `light`:

```
luminance(rgb) = 0.299*r + 0.587*g + 0.114*b
ensure: luminance(light) - luminance(dark) >= 0.45
if not: lift `L_light` and lower `L_dark` symmetrically until the gap is met.
```

This is the only post-hoc clamp inside the palette generator. Document the resampling step in the unit test — it's the regression guard for the smoke bug.

---

## 6. Sanitisation & safety

Even though `evalConfig` clamps every uniform to a GPU-safe range, the randomizer also clamps at sample time. Defense in depth:

1. **`sanitiseConfig(cfg)`** — runs once at the end of `generate()` and `mutate()`. Walks every numeric field, replaces `NaN`/`Infinity` with the corresponding default-config value, and clamps:
   - `Channel.base` to ± 10× the operator-engine clamp width (so even a hostile `base` survives `evalConfig`'s final clamp without erasing audio contribution).
   - `Binding.gain` to `[-3, 3]`.
   - `mirrorSet` entries to integers in `[1, 16]`; an empty set is preserved (means "continuous mirror").
   - `palette.*` components to `[0, 1]`.
   - `emitterScale` to `[0.2, 3]`, `emitterGain` to `[0, 2.5]` (mirrors `evalConfig`).
   - `waveform.thickness` to `[0.0015, 0.06]`, `waveform.scale` to `[0, 0.9]`.
2. **Freeze.** Returned configs are deep-frozen (`Object.freeze` on the root, every sub-object, every bindings array). The runtime cannot accidentally mutate a preset; `lerpConfig`/`mutate` always returns a *new* object.
3. **Stamp metadata.** Set `config.seed = code`, `config.name = `${archetypeLabel} ${code}``, `config.archetype = archetype`. Lets a saved JSON identify itself without a sidecar.

---

## 7. UI integration — Randomize + Lock + Share

The randomizer lives behind a tiny surface in `Visualizer.tsx` (and mirrored in `FullscreenVisualizer.tsx`). The integration is:

### 7.1 Toolbar control

A single button placed between Prev/Preset/Next (see `map-integration.md:535` for the exact slot). Visual: dice icon. Click = `randomize(currentTick++)`; long-press / right-click = open the **Eviland Generative** popover.

### 7.2 Popover contents

```
┌──────────────────────────────────────────────┐
│  Eviland Generative                          │
│                                              │
│  Seed:  K7Q2-9XMF        [Copy]  [Paste]     │
│  Archetype: tunnel-storm  ▾  (or "Auto")     │
│                                              │
│  [ Randomize ]  [ Evolve ]  [ Reset ]        │
│                                              │
│  ☐ Lock                                      │
│  ☑ Ephemeral (don't repeat on next track)    │
└──────────────────────────────────────────────┘
```

- **Randomize** — calls `generate(ephemeralSeed(++tick, trackId))` if Lock is off, or `generate(currentState)` (a no-op repeat) if Lock is on. Updates the Seed field.
- **Evolve** — calls `mutate(currentConfig, 0.25, ephemeralSeed(++mutationTick, currentState.toString()))`. Does *not* change the displayed seed (mutation is non-canonical); a small `*` is appended (`K7Q2-9XMF*`) to indicate the look has drifted. Hitting Randomize clears the asterisk.
- **Reset** — `renderer.setConfig(defaultConfig())`, seed cleared.
- **Paste** — accepts `XXXX-XXXX`, validates via `decodeSeedCode`, calls `generate(state)`.
- **Copy** — writes the current `code` to clipboard (just `navigator.clipboard.writeText`).
- **Lock** — when on, the renderer's `sectionSeed` derivation is frozen at its current value (so the section-stable spin/mirror picks stop changing too). Implementation hook: `setConfig` already replaces `activeConfig`; the lock toggle wraps the renderer's section logic with a fixed override. This needs a 3-line addition to `eviland.ts` (`lockSectionSeed(n: number | null)`); not in this PR's scope but listed here as a downstream dependency. Until it lands, **Lock** only freezes the config — the section spin still varies, which is acceptable UX.
- **Ephemeral** — when on (default), Randomize derives a fresh seed each click (the user "throws away" the seed). When off, Randomize re-uses `currentState` (no change), making Lock implicit.

### 7.3 Persistence

The current seed (`code`), archetype, and Lock state are persisted via the existing Zustand store (the visualizer-settings slice). A reload restores the locked look. Ephemeral seeds are *not* persisted (otherwise they would no longer be ephemeral).

### 7.4 Determinism for capture scripts

`scripts/eviland-capture.mjs` accepts `--seed <code>` (or `--seed <number>`). The capture harness calls `generate(seed)` and feeds `result.config` to the renderer before the first frame. This makes randomized looks reproducibly capturable, which is mandatory for regression baselines once we add per-archetype reference PNGs.

---

## 8. The mutate / evolve operator

`mutate(cfg, amount, seed)` perturbs every numeric channel by a Gaussian step scaled to its operator-engine clamp width, picks a single binding to add or drop (probability scales with `amount`), and never crosses archetype boundaries. Pseudocode:

```ts
function mutate(cfg, amount, seed) {
  const rng = new Rng(seed);
  const a = clamp(amount, 0, 1);
  const out = cloneConfig(cfg);

  // 1. Numeric perturbation. Step = a * (clampWidth/8). Box-Muller via rng.gaussian.
  for (const op of FIELD_OPS) {
    const w = CLAMP_WIDTH[op];                            // e.g. 0.37 for zoom
    out[op].base += rng.gaussian(0, a * w / 8);
    for (const b of out[op].bindings ?? []) {
      b.gain += rng.gaussian(0, a * 0.4);                 // 0.4 ≈ typical gain range
    }
  }

  // 2. Structural perturbation. With prob `a`, drop one random binding from a
  //    random channel; with prob `a`, add one random new binding (feature picked
  //    uniformly from AudioFeature; gain from rng.gaussian(0, 0.3)).
  if (rng.bool(a)) dropRandomBinding(out, rng);
  if (rng.bool(a)) addRandomBinding(out, rng);

  // 3. With prob `a * 0.5`, rotate the palette hue by ±a*60° (HSL-space rotate).
  if (out.palette && rng.bool(a * 0.5)) {
    out.palette = rotatePaletteHue(out.palette, rng.range(-60, 60) * a);
  }

  // 4. Keep archetype, name (with '*' suffix), and seed untouched.
  out.name = (cfg.name ?? 'preset') + '*';
  return sanitiseConfig(out);
}
```

`CLAMP_WIDTH` is a module-private record derived from the `evalConfig` clamps in `eviland-operators.ts`. The Director uses `mutate(currentConfig, 0.06, sectionSeed)` once per beat to make a locked look breathe; the UI's Evolve button uses `0.25`.

`mutate` is pure and deterministic for the same `(cfg, amount, seed)`. Calling it twice with the same seed but a slightly different starting `cfg` produces *different* outputs — that's the point; mutation is *neighbourhood-relative*.

---

## 9. Determinism & seed contract

The randomizer's whole value depends on this:

1. **No `Math.random`. No `Date.now`. No `performance.now`.** The runtime is single-threaded and the spec forbids platform clock/RNG. The only entropy enters through `seed`, which the *caller* supplies.
2. **Stable call order.** §4.4 fixes the order in which `rng` is drawn. Adding a new operator channel goes at the *end* (after `bloom`); reordering existing channels would invalidate every locked seed in the wild.
3. **Stable hash.** `hashSeed` is FNV-1a (already shipped). Don't switch it.
4. **Stable archetype list order.** `ARCHETYPES` is iterated in insertion order in `chooseArchetype`. Adding an archetype at the end is safe; reordering is not. New archetypes get a fresh `id` — never reuse a retired one.
5. **`encodeSeedCode` is alphabet-stable.** The Crockford-ish alphabet is fixed; do not extend it.
6. **JSON-safe configs.** Every minted config must round-trip through `JSON.parse(JSON.stringify(cfg))` to a byte-equal object (modulo key order). The freeze step is the last operation; freezing prevents accidental drift.

A `randomizer-determinism.spec.ts` test (Vitest) covers:
- `generate(42)` equals `generate(42)` for `JSON.stringify(result.config)`.
- `decodeSeedCode(generate(42).code) === generate(42).state`.
- `mutate(cfg, 0.25, 'evolve-1')` equals itself across runs.
- 1000 random integer seeds → every minted config survives `evalConfig` with finite outputs in clamp range (the "hostile config" smoke).

A `randomizer-coherence.spec.ts` test runs each archetype across 50 seeds and asserts:
- `decay` final value (after `evalConfig`) is in `[0.78, 0.97]` — no stalls, no strobes.
- `mirrorN` ∈ `[1, 16]`.
- Palette luminance contrast ≥ 0.45 (§5.3).
- `lerpConfig(a, b, 0.5)` is JSON-safe for any pair (so the Director's crossfade can never produce garbage).

---

## 10. Files added/changed (this PR)

| Path                                                | Change   | Notes |
|-----------------------------------------------------|----------|-------|
| `src/visualizer/eviland-randomizer.ts`              | **NEW**  | The whole grammar, generator, mutator, archetype templates. Zero deps. |
| `src/visualizer/__tests__/eviland-randomizer.spec.ts` | **NEW** | Determinism + coherence + hostile-config smoke (Vitest). |
| `src/components/Visualizer.tsx`                     | EDIT     | Wire the dice button + popover (§7). Imports `generate`, `mutate`, `defaultConfig`, `decodeSeedCode`. ~50 LOC. |
| `src/components/FullscreenVisualizer.tsx`           | EDIT     | Mirror the toolbar button so the chrome-free surface has it too. ~20 LOC. |
| `scripts/eviland-randomize-smoke.mjs`               | **NEW**  | Mints 7 archetypes × 3 seeds, renders 60 frames each, asserts PASS. Mirrors `eviland-smoke.mjs` shape. |
| `docs/eviland/design-randomizer.md`                 | **NEW**  | This document. |

Files explicitly NOT touched: `eviland.ts`, `eviland-operators.ts`, `eviland-audio.ts`, `eviland-rng.ts`, `electron/main.ts`, the Zustand audio slice. The renderer's existing `setConfig(cfg)` is sufficient.

---

## 11. Verification plan

1. `npm run typecheck` — must pass.
2. `npm test -- eviland-randomizer` — the two new spec files (determinism + coherence).
3. `node scripts/eviland-randomize-smoke.mjs` — mints, renders, asserts PASS for all 7 archetypes.
4. `node scripts/eviland-capture.mjs` (existing, default seed) — output must be **byte-identical** to the pre-randomizer capture. The randomizer is opt-in; the default look is `defaultConfig()`, untouched.
5. Manual smoke in NewAmp:
   - Toggle to Eviland.
   - Click dice → look changes (visibly distinct from default).
   - Note the seed code in the popover.
   - Reload NewAmp → if Lock was off, look is fresh; if Lock was on, identical look returns.
   - Copy seed, restart NewAmp, paste → identical look.
   - Cycle through all 7 archetypes from the dropdown; every one renders without white-out, stall, or seizure.
6. `node scripts/eviland-capture.mjs --seed K7Q2-9XMF` → PNG saved; running again produces a pixel-identical PNG (regression baseline for the locked-seed contract).

---

## 12. Critical notes for the implementer

- **Determinism first, beauty second.** Every change to call order, archetype list order, distribution kind, or `Rng` method invalidates every wild seed. Treat §4.4 as a hard contract. When in doubt, add the new draw at the *end* of the order — never in the middle.
- **The CSS-palette skip is the trickiest bit.** §5.1: if `source` draws `'css'`, the *other six palette draws are skipped*. This means an archetype where `source` is biased toward `'fixed'` will produce different downstream draws than one biased toward `'css'`, *only if the same `Rng` is shared*. Use a sub-`Rng` for the palette block (`new Rng(parentRng.int(0, 2**31))`) so the skip doesn't cascade into emitterScale/emitterGain. The unit test guards this.
- **`mutate` keeps the archetype label.** It does *not* re-pick an archetype, does *not* swap `mirrorSet`, does *not* flip `spinFromSection`. Structural identity stays put; only numerics drift. Otherwise the Director's per-beat mutation would feel like a hard cut every few beats.
- **`ephemeralSeed(tick, ns)` must not call `Date.now`.** Implementation: `hashSeed(${ns ?? ''}:${tick}) ^ (tick * 0x9E3779B9)` (golden-ratio prime — gives good bit-mixing for small ticks). Document this. The whole point of ephemeral is "the user didn't pick a seed"; the *system* picks one deterministically from a counter, so capture scripts can replay.
- **Lock without renderer support.** The renderer's `sectionSeed` derivation isn't frozen by `setConfig` alone. Until `lockSectionSeed` lands (downstream, 3-line `eviland.ts` change), the Lock toggle still freezes the config (which is the bulk of the look). Document this in the popover tooltip — "Section spin still varies until renderer update." Then add the 3 lines in a follow-up.
- **Palette luminance gate is non-optional.** §5.3 is the regression guard for the smoke bug; skipping it produces gold/cream blooms on ~5% of seeds. The unit test must fail loudly if the gate is removed.
- **Don't generate `bg = [0,0,0,0]` or `light = [1,1,1]`.** The POST pass does an ACES tonemap; perfect black and perfect white interact badly. The lightness clamps in §5 already enforce this (`L_light ≤ 0.92`, `L_bg ≥ 0.02`); don't widen them.
- **Hostile-config defence is mandatory.** A user pasting a malformed JSON via the (future) Studio import path must NOT crash the renderer. `sanitiseConfig` + `evalConfig`'s clamps are the two-layer defence. The `randomizer-determinism.spec.ts` "1000 random seeds" smoke is the proof.
- **No GL state. No DOM. No `window.*`.** The randomizer is pure. The UI calls it; the UI calls `renderer.setConfig`. The randomizer never imports `eviland.ts`. This keeps the module ready for `@eviland/core` extraction with zero edits (Phase 5).
- **Update `map-integration.md:535` once the dice button lands** — the table currently lists "Randomize seed" as planned; mark it shipped and pin the file/line of the actual button.
