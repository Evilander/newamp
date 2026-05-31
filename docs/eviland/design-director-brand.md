# Eviland — The Director + Brand & Market Positioning

> Phase 6 design. Read `00-VISION.md`, `map-integration.md`, and `design-operators.md` first.
> All paths absolute / repo-relative from `B:\projects\claude\newamp`.
> Status: design spec, not yet implemented. The Director sits on top of the operator engine; it never touches GL state, only swaps the `OperatorConfig` the renderer is reading.
> Owner: `src/visualizer/eviland-director.ts` (NEW) + one wiring change in `src/components/Visualizer.tsx`.
> Risk: LOW. The Director is OPT-IN — when disabled, Eviland renders exactly as in v1.7.x using whatever config the user (or randomizer, or default) supplied.

---

## Part A — THE AI DIRECTOR

### A.0 What this is (and what it is NOT)

**Is:** a deterministic, audio-only, zero-LLM, zero-network state machine that watches the reactor's `EvilandFrame` stream and decides, on every frame, *which* `OperatorConfig` the renderer should be evaluating, and *how loud* the visuals should be right now. It gives a performance a **narrative arc** — calm intros, building verses, screaming drops, restful breakdowns — without the user ever touching a knob. It also gives a song **visual rhymes**: when the reactor reports a section *returning* (chorus 2, chorus 3, final chorus), the Director recalls the look that section had the first time and plays a variation of it.

**Is NOT:** an ML model, a cloud service, an LLM agent, or a song-section classifier trained on labels. There is no model file. There is no network call. There is no `await`. The Director is one class with O(sections_seen_so_far) memory and a 60 Hz `update()` method that returns a config the renderer can read this frame.

This matters because:
1. The Director runs in a hot rAF loop inside `Visualizer.tsx`. Anything async or non-deterministic kills the frame budget.
2. The Director ships inside `@eviland/core`. Zero deps is a hard constraint (see `design-package.md` §0).
3. Determinism + audio-only inputs means the same song + same seed always produces the same arc, which is what makes seeds shareable and the demo-reel reproducible.

### A.1 Why this is the crown

The reactor (`eviland-audio.ts`) already gives us four signals nobody else uses:

| Signal | What it means | Director uses it for |
|---|---|---|
| `novelty` | structural change vs slow-moving recent average (0..1) | "something just changed" trigger |
| `sectionChanged` | a sustained novelty spike that crossed the boundary heuristic | "cut/morph NOW" trigger |
| `sectionReturn` | index of a fingerprinted prior section this one matches, or -1 | "we're back — replay that look" |
| `energy` (smoothed) + `crest` + `flatness` | loudness, peakiness, noisiness | the **intensity surface** that drives palette/operator choices |

Every other visualizer (MilkDrop, butterchurn, Resolume generators, Magic) treats every frame independently — they have no concept of "where are we in the song." The Director closes that loop. It is the first visualizer with **episodic memory of the song it is watching**.

### A.2 Public surface — the contract

The render loop calls exactly one function per frame:

```ts
// packages/eviland-core/src/director.ts  (final home; src/visualizer/eviland-director.ts during NewAmp dev)

import type { EvilandFrame } from './reactor';
import type { OperatorConfig } from './operators';

/** Section archetypes the Director classifies into. Closed string union — the
 *  state machine is small enough that an enum-style switch reads cleanly. */
export type Phase =
  | 'silence'      // < ~ -50 LUFS-equivalent, energy < 0.04 sustained
  | 'intro'        // first section, or post-silence ramp-in
  | 'verse'        // low-to-mid energy, narrow stereo, vocal-dominant
  | 'build'        // rising energy gradient over >= 4 s
  | 'drop'         // post-build kick punch + crest spike + width expand
  | 'chorus'       // sustained high energy + sectionReturn matching prior chorus
  | 'breakdown'    // mid-song energy collapse with vocal/pad remaining
  | 'outro';       // monotonic decay over >= 12 s near end

/** What the renderer reads each frame. Plain data — no functions, no GL state. */
export interface DirectorState {
  /** The config the renderer should evaluate this frame.
   *  Either the active config, or a per-frame crossfade between two configs
   *  during a section transition. The Director owns the crossfade math; the
   *  renderer just sees one OperatorConfig. */
  config: OperatorConfig;
  /** 0..1 — the Director's macro intensity for this frame. Renderer-side
   *  post-stage knobs (bloom intensity, aberration ceiling, waveform glow)
   *  may scale on this; field operators ALREADY react via reactor bindings
   *  so most of intensity is already in the config. */
  intensity: number;
  /** Diagnostic — for the HUD overlay + smoke scripts + recorder metadata. */
  phase: Phase;
  /** 0..1 — confidence in `phase`. Below 0.4 the renderer should not surface it
   *  in the HUD. Confidence is the smoothed agreement of the classifiers. */
  phaseConfidence: number;
  /** Set on the frame the phase changed; cleared the next frame. Used by the
   *  recorder for chapter markers and by the HUD for the transition flash. */
  phaseChanged: boolean;
  /** -1 if not a section-return frame; else the prior section index whose
   *  look this config was recalled from. Pass-through from reactor.sectionReturn
   *  AT THE MOMENT OF SECTION CHANGE — the Director latches it for the whole
   *  section so the HUD can show "Chorus (rhyme of §2)". */
  recallOf: number;
}

/** The pool of configs the Director chooses from for each phase. Caller-supplied
 *  so the same Director instance works for: the default look (one config in every
 *  pool), a randomized session (the randomizer fills each pool with seeded
 *  variations), or a hand-curated set (Studio user picks 6 favorites). */
export interface DirectorConfigPool {
  silence:   readonly OperatorConfig[];   // length >= 1
  intro:     readonly OperatorConfig[];
  verse:     readonly OperatorConfig[];
  build:     readonly OperatorConfig[];
  drop:      readonly OperatorConfig[];
  chorus:    readonly OperatorConfig[];
  breakdown: readonly OperatorConfig[];
  outro:     readonly OperatorConfig[];
}

export interface DirectorOptions {
  /** Section-change crossfade duration in BEATS. Default 4. The Director will
   *  convert to ms using the reactor's current bpm; if bpm is unknown (< 1)
   *  it falls back to crossfadeMsFallback. */
  crossfadeBeats?: number;
  /** Fallback crossfade ms when bpm is unknown. Default 1800. */
  crossfadeMsFallback?: number;
  /** Beat-synced cut threshold. If novelty >= this AND sectionChanged AND
   *  beatConfidence >= 0.55, the Director snaps the swap to the next downbeat
   *  rather than crossfading. Default 0.55. Set to 1.1 to disable beat cuts
   *  (always crossfade). */
  beatCutNoveltyThreshold?: number;
  /** When a section returns, the Director should recall the EARLIER look but
   *  with a small mutation so chorus 3 is not byte-identical to chorus 1. This
   *  is a [0..1] strength applied to the per-binding coefficients of the
   *  recalled config (small jitter only — base values are not touched).
   *  Default 0.08. Set 0 for exact recall. */
  recallMutation?: number;
  /** Hands-off mode. When false, the Director.update() pass-through returns
   *  the caller's last setOverride() config. Default true. */
  enabled?: boolean;
}

export interface EvilandDirector {
  /** Hot path. Allocation-free. Returns a DirectorState whose `config` is
   *  either a pool entry directly, or a module-scoped scratch config that
   *  contains the per-frame crossfade. The renderer reads .config and feeds
   *  it to evalConfig() unchanged. */
  update(frame: EvilandFrame, dtMs: number): DirectorState;

  /** Replace the config pool atomically. Used when the user picks a different
   *  randomizer seed mid-song or swaps presets in Studio. Currently-playing
   *  crossfade is cancelled cleanly (snap to target). */
  setPool(pool: DirectorConfigPool): void;

  /** Hands-free but overridable. When override is non-null, update() returns
   *  it verbatim (no crossfade, no phase analysis is suppressed — phase still
   *  ticks so the HUD can show what the Director WOULD have done). Pass null
   *  to release back to autonomous control.
   *
   *  This is how the "user dragged the operator panel slider" path lives next
   *  to the Director: Studio sets override on first touch and releases it on
   *  a button press. */
  setOverride(config: OperatorConfig | null): void;

  /** For the HUD + smoke + recorder metadata. Returns a snapshot — never the
   *  internal mutable state. */
  inspect(): {
    phase: Phase;
    phaseConfidence: number;
    framesInPhase: number;
    sectionsSeen: number;
    energyShort: number;
    energyLong: number;
    nextCrossfadeMs: number;   // remaining ms in the current crossfade, 0 if none
  };
}

export function createEvilandDirector(
  pool: DirectorConfigPool,
  options?: DirectorOptions,
): EvilandDirector;
```

The render loop change is one line. From `Visualizer.tsx:261-332` (the Eviland branch):

```diff
- const renderer = createEvilandRenderer(canvas, { quality: evilandQuality, smoke });
+ const renderer = createEvilandRenderer(canvas, { quality: evilandQuality, smoke });
+ const director = createEvilandDirector(directorPool, { enabled: directorEnabled });

  // ...inside the rAF loop, after reactor.analyze(...):
- renderer.render(evFrame, palette, dtMs);
+ const ds = director.update(evFrame, dtMs);
+ renderer.setConfig(ds.config);                 // method from design-operators.md §6.1
+ renderer.render(evFrame, palette, dtMs);
```

Nothing else in `Visualizer.tsx` changes. The director-disabled path is `directorEnabled=false`, which makes `update()` a pass-through that returns `{ config: override ?? pool.verse[0], intensity: frame.energy, phase: 'verse', ... }`. The renderer keeps using its existing default config; the only cost is one no-op call per frame.

### A.3 The state machine — phases, transitions, evidence

```
            ┌──────────────┐
            │   silence    │◄──────────────────── energyLong < 0.04 for >= 1500 ms
            └──────┬───────┘
                   │ energy > 0.06 sustained
                   ▼
            ┌──────────────┐
   ┌──────► │    intro     │ ◄────── first section after createDirector OR after silence
   │        └──────┬───────┘
   │               │ framesInPhase >= 90 (1.5 s @ 60fps) AND energy stable
   │               ▼
   │        ┌──────────────┐
   │   ┌───►│    verse     │ ◄─────────────────── energyShort - energyLong ∈ [-0.06, +0.04]
   │   │    └──────┬───────┘                       AND vocal env > kick env
   │   │           │ energy gradient > +0.025 over 60 frames (1 s)
   │   │           ▼
   │   │    ┌──────────────┐
   │   │    │    build     │
   │   │    └──┬─────────┬─┘
   │   │       │         │
   │   │   drop trigger  │ build stalls / no kick spike → fall back to verse
   │   │       │         │
   │   │       ▼         ▼
   │   │   ┌─────────┐   ┌──────────┐
   │   └───┤  drop   ├──►│  chorus  │◄── sectionChanged AND sectionReturn >= 0
   │       └────┬────┘   └────┬─────┘
   │            │             │
   │  energy collapse: short-window energy drops > 0.18 in 600 ms
   │            ▼             ▼
   │       ┌──────────────────────┐
   └───────┤      breakdown        │
           └──────────┬───────────┘
                      │
              monotonic energy decay >= 12 s near end (last 20% of song
              if duration known; else sustained low energy for >= 18 s)
                      ▼
                  ┌────────┐
                  │ outro  │
                  └────────┘
```

**Per-phase entry conditions, evaluated each frame.** Conditions are checked in priority order (top wins). Once a phase fires, the Director enforces a minimum dwell of `minDwellMs[phase]` (next table) before any non-emergency transition; emergency transitions (`silence`, `sectionChanged`-with-high-confidence) bypass dwell.

| Phase | Entry test (all must hold unless noted) | Min dwell |
|---|---|---|
| `silence`     | `energyLong < 0.04` for `>= 1500 ms` | 800 ms |
| `intro`       | first section after construction OR exiting silence | 1200 ms |
| `verse`       | `\|energyShort - energyLong\| < 0.05` AND `vocal > kick * 0.9` AND not in build/drop | 2400 ms |
| `build`       | `gradient(energyShort, 60 frames) > +0.025` AND `centroidShort` rising AND `kick env count` rising | 1200 ms |
| `drop`        | within 800 ms of a `build` AND `kick > 0.55` AND `crest > 0.45` AND `widthShort > widthLong + 0.10` | 1500 ms |
| `chorus`      | `sectionChanged` this frame AND `sectionReturn >= 0` AND prior section was tagged as a chorus-class phase (drop/chorus) | 2400 ms |
| `breakdown`   | short-window energy drop `> 0.18` over `<= 600 ms` AND post-chorus/drop | 1500 ms |
| `outro`       | song-position known and `pos > 0.80` AND energy monotonically decaying for `>= 12 s`. If position unknown, energy decaying `>= 18 s` AND no kick onsets for `>= 6 s` | 4000 ms |

Two rolling estimators back this:
- `energyShort` — single-pole EMA of `frame.energy`, time constant **350 ms**.
- `energyLong`  — single-pole EMA of `frame.energy`, time constant **8000 ms**.
The signed difference `(energyShort - energyLong)` is the "is the song growing or shrinking right now" lever. The Director never reads raw `frame.energy` for phase decisions — only the EMAs.

`gradient(energyShort, 60)` is the slope of the last 60 stored `energyShort` samples — kept in a 60-slot circular buffer (small constant memory, no allocation per frame).

**`phaseConfidence`** is the smoothed proportion of the last 30 frames that voted for the current phase. It rises to 1.0 over half a second of stable evidence and drops on contention. The HUD threshold of 0.4 (in `inspect()`) keeps it from flashing while the song is in a genuinely transitional moment.

### A.4 Energy / section → intensity surface

`DirectorState.intensity` is a single 0..1 scalar derived from:

```
intensity =
    0.55 * energyShort
  + 0.20 * smoothedCrest                 // peakiness — punchier songs read higher
  + 0.15 * (kickRate / 4)                // kick onsets per second, capped at 4
  + 0.10 * widthShort                    // wider mixes read more cinematic
  + phaseBias[phase]
all then clamped to [0, 1]
```

`phaseBias` is small (+/-0.08 max) and gives the phase a stylistic floor/ceiling so a calm verse never accidentally drives bloom to a chorus level even if the song's `energyShort` briefly spikes from a single loud sample. Values:

| Phase | bias |
|---|---|
| silence   | -0.08 |
| intro     | -0.06 |
| verse     |  0.00 |
| build     | +0.04 |
| drop      | +0.08 |
| chorus    | +0.06 |
| breakdown | -0.04 |
| outro     | -0.06 |

`intensity` does NOT directly modulate operator outputs — those already react to `frame.energy` etc via their bindings (see `design-operators.md` §3). It is exposed so post-stage knobs and the future "Waveform layer" / "bloom intensity" config slots (also from `design-operators.md` §8) can scale themselves. It is also what the recorder writes into chapter metadata so a video editor can find "the drop" by scrubbing the intensity curve, not by ear.

### A.5 Phase → config-pool mapping (the creative choice surface)

When a phase change is confirmed, the Director picks a config from `pool[phase]`. **The choice is deterministic** based on the `sectionId` and a stable per-pool index — same song + same pool always picks the same config in the same order:

```
idx = ((sectionId * 2654435761) >>> 0) % pool[phase].length
chosen = pool[phase][idx]
```

The constant `2654435761` is Knuth's multiplicative hash; mixes section index entropy without an RNG instance. This is the *only* selection arithmetic — there is no `Math.random()` in the Director. Reproducibility is non-negotiable.

**The Randomizer** (separate spec, future PR) is what fills `pool[phase]` with musically-coherent variations. The Director does not generate configs; it picks from a list the caller supplied. This split keeps each module testable:
- Randomizer test: given a seed, the pools are deterministic and pass `prepareConfig` clamps.
- Director test: given a frame sequence and a fixed pool, the phase progression and config choices are deterministic.

#### Default pool guidance (what the Randomizer should be aiming for)

These are stylistic constraints, NOT hardcoded operator values. Implemented inside `eviland-randomizer.ts` as feature weights. The Director itself never enforces them — it trusts the pool — but they document the contract.

| Phase | Palette | Field operators (typical envelope) | Kaleido | Bloom | Waveform layer (future) |
|---|---|---|---|---|---|
| silence   | very desaturated, dark | decay high (~0.90), zoom small, mirror off | off | low | off |
| intro     | cool, low-saturation | gentle zoom (~0.002), slow hue cycle, mirror off or 4-fold low mix | low | low | thin, dim |
| verse     | song palette, mid-saturation | moderate zoom + rotate, mirror 4/6 mid mix | mid | mid | mono, dim |
| build     | song palette, rising saturation | rotate accelerating, hue cycle rising, mirror 6/8 | mid | rising | mono, brightening |
| drop      | high-saturation, accent-dominant | zoom + rotate strong, swirl high, mirror 8/12 strong mix | strong | high | stereo, bright |
| chorus    | recalled from prior chorus + slight mutation (see §A.6) | the recalled config's envelopes | recalled | recalled | recalled |
| breakdown | dropped saturation, dark accent | zoom shrunk, rotate slowed, mirror reduced | reduced | low | thin, glow boosted |
| outro     | desaturating toward dark | decay rising, zoom shrinking, mirror off | off | falling | thin, fading |

### A.6 Section recall — the "chorus rhymes" feature

This is what makes the Director feel *intentional* rather than reactive. The reactor already does the hard part: when a section returns, `frame.sectionReturn >= 0` is the index of the matching prior fingerprint.

The Director maintains a **section memory** alongside its phase state:

```ts
interface RememberedSection {
  sectionId: number;            // reactor's monotonic id at first appearance
  phase: Phase;                 // what the Director called it
  configRef: OperatorConfig;    // the exact pool entry it used (frozen — pools are frozen by prepareConfig)
  intensityPeak: number;        // max intensity reached in that section
}
```

Bounded to the last 24 sections (matches reactor's `fingerprints` cap on line 413).

On `sectionChanged` AND `sectionReturn >= 0`:
1. Look up the remembered section by its `sectionId` (NOT the reactor's `sectionReturn` index — that's an index into the reactor's bounded array which can be stale by the time we look; the Director stores the resolved id at first sighting and uses *that* as the lookup key). If not found in memory (we evicted it), fall back to normal phase selection.
2. If the remembered phase was `drop` or `chorus`, **classify the new section as `chorus`** even if other evidence is mixed. This is what makes "the chorus comes back" feel right.
3. Recall `configRef` and apply a small mutation:

```
mutated = structuredClone(remembered.configRef)        // pools are frozen; clone before mutation
for each binding in mutated.field.<op>.bindings:
  binding.coef *= 1 + (hashMix(sectionId, op, i) - 0.5) * 2 * recallMutation
clampOutput-equivalent ranges are enforced by prepareConfig on the way out
```

`hashMix(sectionId, op, i)` is a tiny deterministic hash (one `Math.imul` chain) that returns 0..1 — same section returning twice with the same Director instance gets the same mutated config, but two chorus returns are not identical, and recall mutation of 0 gives exact-replay (deliberate for testing the "perfect rhyme" case). The renderer never sees the mutation — it just receives the new `OperatorConfig` reference via the next `setConfig` crossfade target.

4. Set `DirectorState.recallOf = remembered.sectionId` for the whole duration of this section. The HUD reads this and renders "Chorus (rhyme of §2)".

If `sectionChanged` AND `sectionReturn < 0` (a *novel* section that scored a high enough novelty to be its own thing), the Director picks a fresh config from `pool[chosenPhase]` as in §A.5 and stores it as a `RememberedSection` for future returns.

### A.7 Crossfade — how two configs become one

Configs are pure JSON. Crossfading them is a per-field lerp, done once per frame into a module-scoped scratch config that the renderer reads. The renderer never knows a crossfade is happening.

```ts
// allocation-free per-frame interpolation
function lerpConfig(a: OperatorConfig, b: OperatorConfig, t: number, out: OperatorConfig): void {
  // t ∈ [0,1], 0 = pure a, 1 = pure b
  for (const op of ['decay','warpAmp','warpScale','flowX','flowY','zoom','rotate','hueCycle','swirl','mirrorMix'] as const) {
    out.field[op].base = lerp(a.field[op].base, b.field[op].base, t);
    // bindings: zip by index, lerp coef. If lengths differ, use the longer length
    // and lerp missing entries from coef=0 (entering) or to coef=0 (leaving). This
    // means adding a new binding fades it in, not snaps it in.
    lerpBindings(a.field[op].bindings ?? EMPTY, b.field[op].bindings ?? EMPTY, t, out.field[op].bindings);
    // time block: lerp amp + hz if both present; else fade the present one against 0
    out.field[op].time = lerpTimeBlock(a.field[op].time, b.field[op].time, t);
  }
  // section behaviour: NOT interpolated — switched at t >= 0.5 with a one-frame jolt
  // because mirrorN is an integer and rotateSign is ±1 (no in-between). The crossfade
  // hides the discontinuity behind the field operators' continuous lerp.
  out.section = (t < 0.5) ? a.section : b.section;
  // palette: lerp colour stops if both 'fixed'; if either is 'css' the renderer
  // continues reading CSS each frame and the crossfade only affects field operators
  // (palette crossfade ships with the post-stage operators PR).
  out.palette = (a.palette.source === 'fixed' && b.palette.source === 'fixed')
    ? lerpFixedPalette(a.palette.fixed!, b.palette.fixed!, t)
    : (t < 0.5 ? a.palette : b.palette);
  // emitters, waveform: stepwise at t >= 0.5 (waveform mode 'off' vs 'mono' has no smooth midpoint)
  out.emitters = (t < 0.5) ? a.emitters : b.emitters;
  out.waveform = (t < 0.5) ? a.waveform : b.waveform;
  out.version = 1;
}
```

The scratch config is `prepareConfig`'d ONCE at director construction and then kept un-frozen (Object.isFrozen check passes only on the pool entries, never on the scratch). The mutation only touches numeric fields that already exist; structure never changes after construction, so V8's hidden-class stays stable.

**Crossfade timing curve.** The raw `t = elapsedMs / totalMs` is shaped with a smooth easing before being fed to `lerpConfig`:

```
tCurved = t * t * (3 - 2 * t)       // smoothstep — no derivative discontinuities
```

This avoids the audible "snap" at the start and end that a linear lerp produces on rotate/zoom (those are integrated into the field, so even a small kink reads as a jolt).

**Crossfade duration.** Chosen at crossfade START:

```
beatMs = bpm > 1 ? 60000 / bpm : 0
totalMs = beatMs > 0
  ? max(crossfadeBeats * beatMs, 600)        // floor at 600 ms so 30 BPM doesn't lock us up
  : crossfadeMsFallback
```

Default `crossfadeBeats: 4` at 120 BPM = 2000 ms — long enough to feel intentional, short enough that a fast song doesn't outrun the transition. The 600 ms floor matters: a chill 40 BPM song would otherwise take 6 seconds to crossfade which dries out the energy.

### A.8 Beat-synced cuts — the "drop" trigger

For the highest-impact transitions (drops, big section changes), a crossfade can be the wrong choice — the human ear expects a *cut*, locked to the next downbeat. The Director's beat-cut path:

When `update()` detects a phase transition INTO `drop` or `chorus` AND `frame.beatConfidence >= 0.55` AND `frame.novelty >= beatCutNoveltyThreshold` (default 0.55):
1. Compute ms-to-next-downbeat from `frame.beatPhase` and `frame.bpm`:
   `msToBeat = (1 - frame.beatPhase) * 60000 / frame.bpm`
2. If `msToBeat <= 180` (about a quarter of a 120-BPM beat), **defer** the swap by `msToBeat`. During the defer window the Director keeps returning the OLD config — no crossfade.
3. On the next frame after the deferred deadline, swap to the NEW config in a single frame (`t = 1` immediately, no interpolation). This is the *cut*.
4. Set `DirectorState.phaseChanged = true` on the cut frame so the HUD / recorder can mark it.

If `msToBeat > 180`, the cut would feel late; fall back to a normal crossfade and accept the brief out-of-time start.

This is the difference between a Director that "knows the song" and one that just morphs continuously. Drops *must* land on a beat. Verses and intros *should not* try — a crossfade reads as more musical for ambient transitions.

### A.9 Hands-off, but overridable

`setOverride(config)` is the door through which Eviland Studio lets a human take the wheel:

```ts
// Studio panel: user drags the "zoom base" slider
director.setOverride(currentEditedConfig);
// ... user clicks "release to Director"
director.setOverride(null);
```

While override is non-null:
- `update()` returns `{ config: override, intensity: <computed>, phase: <still computed>, ... }`. Phase analysis keeps running so the HUD can show what the Director would have chosen — useful for live tweaking a chorus look while listening to a build.
- `setConfig` on the renderer always receives `override`. The currently-running crossfade (if any) is dropped silently — Studio interaction is high-priority.
- Any pending beat-cut defer is cancelled.

On release (`setOverride(null)`):
- The Director resumes with whatever phase it currently thinks the song is in.
- A 2-second crossfade is queued from `override` to the phase-appropriate pool entry so handoff is smooth.

### A.10 Memory / allocation budget

The Director holds:
- Two EMA scalars (`energyShort`, `energyLong`).
- A 60-slot Float32Array circular buffer for the energy gradient.
- A 30-slot Uint8Array circular buffer of recent phase votes.
- A `RememberedSection[]` capped at 24 entries (~24 * 48 bytes ≈ 1.2 KB).
- One `OperatorConfig` scratch object for crossfade output.
- One frozen reference to the active `DirectorConfigPool`.

**Total steady-state ≈ 3 KB.** No allocations on the hot path; `update()` mutates the scratch config in place and returns a stable `DirectorState` object whose own fields are reused.

### A.11 Verification

New unit test file `packages/eviland-core/tests/director.spec.ts` (or `src/visualizer/__tests__/eviland-director.spec.ts` during NewAmp dev):

1. **Phase progression**. A canned frame sequence representing the EDM-template "intro → verse → build → drop → chorus → breakdown → outro" (28 seconds at 60 fps = 1680 frames) drives the Director. Assert the phase enum changes in exactly that order, and no phase fires before its `minDwellMs`.
2. **Crossfade math**. Two distinct configs A and B. Force a transition at frame 0. At frames matching `t = 0, 0.25, 0.5, 0.75, 1.0`, evaluate the scratch config's `field.zoom.base` and assert it matches `lerp(A.zoom.base, B.zoom.base, smoothstep(t))` to 1e-9.
3. **Recall**. A frame sequence where the reactor reports `sectionReturn = 0` on the 4th sectionChange. Assert the Director's scratch config equals the *mutated* version of the section-0 config (mutation strength 0 → byte-equal; mutation 0.5 → bindings.coef differ but stay inside `prepareConfig` clamps).
4. **Determinism**. Run the canned sequence twice with the same pool; assert every frame's `config` reference is `Object.is`-equal or the scratch config's numeric content is bit-identical.
5. **Override**. Force `setOverride(X)` mid-crossfade; assert next `update()` returns `config === X`. Release; assert a fresh 2 s crossfade begins toward the phase-appropriate pool entry.
6. **Beat-cut defer**. Synthesise `frame.beatPhase = 0.85`, `bpm = 120`, `beatConfidence = 0.7`; trigger a drop transition. Assert the cut frame is delayed by `(1-0.85) * 60000/120 ≈ 75 ms` and lands with `t=1` (no interpolation pixels in between).

Integration into existing smoke:
- `scripts/eviland-smoke.mjs` — add a Director assertion: with the default pool and a kick-heavy synthetic track, the Director must enter at least 2 distinct phases over 90 frames AND the lit-pixel count gate must still pass. The Director must not break the existing assertion.
- `scripts/eviland-capture.mjs` — capture WITH Director enabled (default) and WITHOUT. Both PNGs must show distinct emitter shapes against near-black background (the "gold/cream smoke" guard still applies). Visual diff is allowed — the configs are different by construction.

### A.12 Files added / changed

| Path | Change | Notes |
|---|---|---|
| `src/visualizer/eviland-director.ts` (later `packages/eviland-core/src/director.ts`) | **NEW** | The Director — types, state machine, crossfade, recall, override. Zero deps. |
| `src/visualizer/__tests__/eviland-director.spec.ts` | **NEW** | Unit tests per §A.11. |
| `src/components/Visualizer.tsx` | EDIT (~6 lines) | Wire `createEvilandDirector`, call `update()`, call `renderer.setConfig()`. |
| `src/components/FullscreenVisualizer.tsx` | EDIT (one toggle row + one HUD line) | "Director" toggle in the settings popover; HUD line "Phase: chorus (rhyme of §2)" under existing reactivity readout. |
| `shared/types.ts` | EDIT (one settings key) | `directorEnabled: boolean` in `AppSettings` so the toggle persists. |
| `scripts/eviland-smoke.mjs` | EDIT | Add the Director phase-progression assertion. |
| `docs/eviland/design-director-brand.md` | **NEW** | This document. |

No other file touches. Renderer (`eviland.ts`), reactor (`eviland-audio.ts`), RNG (`eviland-rng.ts`), audio engine (`engine.ts`), electron host — all untouched.

### A.13 Critical notes for the implementer

- **Determinism over cleverness.** Every selection in the Director is a deterministic function of `(frame, sectionId, pool)`. Never reach for `Math.random()`. The shareable-seed promise depends on this.
- **The reactor already does the hard signal processing.** The Director must not re-implement onset detection, BPM estimation, or section fingerprinting. If a phase decision needs a signal the reactor doesn't expose, the right move is to add it to `EvilandFrame` (and the operator engine's `EvilandFeature` union), not to compute it inside the Director.
- **`sectionReturn` is a reactor INDEX, not an ID.** The reactor's `fingerprints[]` is bounded to 24 and oldest entries are shifted out (`eviland-audio.ts:413`). Always resolve `sectionReturn` to the reactor's `sectionId` AT THE MOMENT OF THE RETURN, then store that id. Don't store the index.
- **The crossfade scratch config is mutable; pool entries are frozen.** `prepareConfig` (operators spec §4.7) deep-freezes pool entries. The director's scratch config is built once with `prepareConfig` and then explicitly *un*-frozen at the top level (the field operators stay frozen; we only re-assign their numeric leaves). If a future contributor tries to `Object.freeze(out)` thinking it's safer, the crossfade silently no-ops in production.
- **`silence` is a real phase, not a no-op.** A silent passage in the middle of a song should look quiet (slow decay, mirror off, dark palette) — not the previous chorus's look frozen in place. Test with a 30-second WAV that goes loud → 5 s silence → loud and confirm the Director slips into and out of `silence` cleanly.
- **Phase classification must NOT lean on `sectionReturn` alone.** It's tempting to say "if sectionReturn matched, it's chorus." But the reactor's threshold (cosine ≥ 0.86, see `eviland-audio.ts:404`) sometimes false-positives on highly similar verses. The Director only classifies as `chorus` when both `sectionReturn >= 0` AND the prior remembered section was a drop/chorus.
- **Never block the render loop.** The Director cannot perform any IO. If a future feature wants "save this look as a preset on user click," the IO happens in the React layer; the Director just hands out `DirectorState.config` (which is JSON-serializable already).
- **`enabled: false` must be a true no-op.** When the Director is disabled the rAF loop should pay one virtual function call and no more — no EMA updates, no buffer writes, no pool reads. This is what makes "Director toggle off" a zero-regression path back to v1.7.1 behaviour.
- **Pool inputs are NOT validated by the Director.** Pools must already have been `prepareConfig`-validated by the caller. Validating again per frame would be wasteful; validating at `setPool()` would force the Director to import `prepareConfig`. Leave the contract to the caller — they always know the pool came from either the default config builder, the Randomizer (which calls `prepareConfig`), or Studio (which calls `prepareConfig` on save).

### A.14 What this unlocks

- **Live performance**: a VJ drags Eviland to the projector, hits play on the set, and the Director does the visual mix. The VJ touches `setOverride` only when they want to push it harder than the Director would.
- **Streamer mode**: the HUD line ("Phase: chorus (rhyme of §2)") is meta the streamer's chat will react to — the visualizer is *commenting on the song* in real time.
- **Demo reel**: 60-second clips of "Eviland directs <track>" with the phase progression overlay become the marketing asset (see Part B §B.6).
- **Studio**: users can drop a `.wav` in, watch the Director play it, scrub to a section, freeze the look as a preset, then publish it as a seed.
- **Live mic/line-in** (`design-live-io.md`): the Director works identically on a real-time mic input. There is no "song duration" needed; the `outro` heuristic gracefully degrades to never-firing for an open-ended live set.

---

## Part B — BRAND + MARKET POSITIONING

### B.1 Name + identity

**Product name:** **Eviland** (already established; keep it).

**Standalone product name:** **Eviland Studio** for the desktop app; **`@eviland/core`** for the embeddable library. NewAmp keeps using "Eviland" as the visualizer name internally.

**Wordmark treatment:** lowercase `eviland` in a geometric mono (JetBrains Mono / Berkeley Mono weight 500), with a stylised dot over the first `i` rendered as the Eviland kaleidoscope motif (4-fold mirror cell). The dot is the only ornament — the wordmark itself stays clean so it reads at 16 px.

**Color identity:**
- Primary: Eviland Black `#05060A` (matches the renderer's `bg`).
- Accent: Eviland Lime `#39FF14` (the renderer's default `--accent`).
- Secondary accent (light theme docs only): Eviland Cream `#F4EEDA` — earned back from the regression that prompted the v1.7.4 fix; the cream is now an *intentional* secondary, not an accident.

**Voice (for marketing copy, docs, error messages):** direct, specific, technically precise, no hype words. Compare:
- Bad: "Experience next-gen audio visualization powered by AI."
- Good: "Eviland sees each instrument and conducts the visual to the song."

**Sound:** none. Eviland does not ship a startup chime, a UI sound, or any auditory branding. It is a visual tool that listens.

### B.2 One-line pitch

> **Eviland is a generative music visualizer that hears every instrument and conducts the visual to the song.**

That's the line for the homepage hero, README first paragraph, and the bio of every social account. It compresses the three things nobody else has: per-instrument reactivity ("hears every instrument"), generative engine ("generative"), and the Director ("conducts the visual to the song").

**Longer variant (300 chars)** for app-store listings:
> Eviland reacts to *each instrument* — kick, snare, hat, vocal, bass — not just one bass thump. A self-directing AI conducts the visuals through the song's arc, with chorus looks that rhyme when sections return. Shareable seeds. Live input. Projector output. Recorder built in.

### B.3 Target users — who this is actually for

| Segment | Why Eviland | What they pay attention to |
|---|---|---|
| **VJs / live visual artists** | Detached projector output + live mic/line-in + override surface = a real performance instrument, not a screensaver. | Latency, output stability, MIDI/OSC hooks (Phase 7), DMX-out (future). The Director means a solo VJ can run a 2-hour set without manually preset-hopping. |
| **Live musicians (DJ/producer playing out)** | One laptop, one cable to the projector. The DJ plays music; Eviland VJs the night for free. The instrument-aware reactor finally makes the visual move with the *kick* instead of pulsing on every bass tone. | Reliability on stage; "doesn't crash mid-set" is the #1 feature. Audio routing from CDJ-style line-in. |
| **Streamers (Twitch / YouTube Live)** | A second monitor with Eviland fullscreen + OBS browser-source-style capture = production polish without paying for Resolume. The HUD phase line is unique stream meta the chat reacts to. | Low GPU cost (the existing quality tiers), OBS capture compatibility, low-pixel-cost lurking idle screens. |
| **Video producers / music-video editors** | The recorder writes MP4 with chapter markers at every phase transition. The shareable seed means a producer can lock a look across multiple takes. The randomizer + seed is faster than hand-keyframing in After Effects. | Frame-accurate recording, deterministic playback from seed, exportable timeline metadata. |
| **Audio devs / hobbyists / NewAmp users** | NewAmp's flagship visualizer, free, ES modules. Also the embeddable library for "I want a visualizer in my own app" people. | API quality of `@eviland/core`, doc quality, example apps. |

**Anti-targets** (people Eviland is NOT for, on purpose): casual users who want a single "looks cool" preset and walk away; users on Linux without WebGL2 (fallback is butterchurn); anyone wanting realtime collaboration / cloud sync (out of scope — the seed *is* the sync layer).

### B.4 Differentiators — Eviland vs everyone

| Capability | butterchurn / MilkDrop | projectM | Magic Music Visuals | Resolume Wire | **Eviland** |
|---|---|---|---|---|---|
| Per-instrument reactivity (kick vs snare vs hat vs vocal vs bass) | no (3 bands) | no (3 bands) | partial (FFT bands user-wired) | no (audio bands) | **yes (24-band semantic onset bus)** |
| Causal anticipation (lead the beat, not chase) | no | no | no | no | **yes (kick IOI tempo + beatPhase)** |
| Structural memory (chorus rhymes) | no | no | no | no | **yes (section fingerprints + sectionReturn)** |
| Autonomous Director (intro→drop→chorus arc) | no | no | partial (manual scenes) | partial (manual cue lists) | **yes (deterministic state machine + recall)** |
| Shareable, deterministic seeds | partial (.milk presets are static, not seeds) | partial | no | no (project files) | **yes (32-bit seed → identical look forever)** |
| Live mic/line-in input | partial (Web Audio mic in some forks) | partial | yes | yes (paid) | **yes (Web Audio MediaStreamSource, free)** |
| Detached projector window | no | partial | yes | yes (paid) | **yes (Electron BrowserWindow popout, free)** |
| Built-in recorder (MP4 with chapter markers per phase) | no | no | no | partial | **yes (ffmpeg-static + Director phase markers)** |
| Embeddable library (any web app) | yes (butterchurn) | no | no | no | **yes (`@eviland/core`, zero-dep ES modules)** |
| Price | free | free | $79–$329 | $399+ | **free (MIT)** |

The three diamond-hard differentiators to lead with in copy: **per-instrument**, **self-directing**, **shareable seeds**. The other rows are either parity (live input, detached window) or table stakes for a 2026 launch.

### B.5 README / landing-page outline

A single landing page at `eviland.dev` (placeholder). Same outline doubles as `packages/eviland-core/README.md` and the Studio app's "About" pane.

```
HERO
  Wordmark + the one-line pitch + a 6-second looping clip of the Director progressing
  through intro → drop → chorus (the demo-reel's opening shot). One CTA button:
  "Download Eviland Studio (Win / macOS / Linux)". One link: "Embed @eviland/core".

SECTION 1 — IT HEARS EACH INSTRUMENT
  Animated diagram: waveform → 24 mel bands → 5 instrument groups → 5 distinct visual events.
  Caption: "Every other visualizer pulses on one bass band. Eviland's reactor knows the
  kick from the snare from the vocal — and fires a different visual for each."
  Inline 4-second clip: a drum loop where each hit triggers a visibly different emitter
  shape (ring/burst/sparkle/blob/core).

SECTION 2 — IT CONDUCTS THE SONG
  Animated diagram: song timeline with the Director's phase enum changing colour blocks
  along it. Caption: "The Director watches the song's structure — energy, novelty, returning
  sections — and chooses the look. Drops land on the beat. Choruses rhyme."
  Inline 8-second clip: the same song twice, side by side — left half "Director: off" (single
  look the whole song), right half "Director: on" (visible phase progression).

SECTION 3 — SHARE A LOOK IN 8 CHARACTERS
  Static image: "K7Q2-9XMF" → screenshot of the resulting look. Caption: "Every Eviland
  look is a 32-bit seed. Lock it, share the code, anyone gets the identical visual."
  CTA: "Paste a seed → preview it in the browser" (a small WebGL embed of @eviland/core
  running an OperatorConfig built from the seed).

SECTION 4 — BUILT FOR THE STAGE
  Three icons + captions, 60 chars each:
    • Live mic / line-in — "Visualize what's playing in the room, not just files."
    • Detached projector window — "Push to a second display while NewAmp stays browsable."
    • MP4 recorder with chapter markers — "Export with per-section markers built in."

SECTION 5 — TWO PRODUCTS
  Card 1: "Eviland Studio" — desktop app, full UI, recorder, randomizer, Director toggle.
    CTA: "Download" (Win / macOS / Linux).
  Card 2: "@eviland/core" — zero-dep ES-modules library, embeddable in any web/Electron app.
    CTA: "npm install @eviland/core" + a copy-button code snippet (3 lines).

SECTION 6 — UNDER THE HOOD (for the devs)
  Four bullets:
    • 24-band mel spectral-flux onset detector (per-instrument bus)
    • WebGL2 RGBA16F ping-pong feedback field (MilkDrop-class)
    • Deterministic Director state machine (audio-only, zero ML)
    • All configs are JSON; every look is a shareable seed
  Link: "Architecture deep-dive →" (link to docs/eviland/00-VISION.md).

FOOTER
  GitHub link · Discord link · changelog · MIT license · "Built by Tyler Eveland".
```

The page does NOT have: a pricing table (it's free), testimonial cards (no one's used it yet — replace with "Used as the default visualizer in NewAmp since 1.7.1"), or a hype-words section. The page IS: short, dense, with three actual playable artifacts (the seed paste-and-preview is the killer one).

### B.6 Demo-reel plan

A 90-second demo reel is the single most important marketing asset. Use the built-in recorder (`design-live-io.md` recorder module + ffmpeg-static MP4 output). The reel is produced by running Eviland over a curated playlist and stitching the recorder output — no After Effects, no manual editing for the visuals themselves (only for the cuts between songs).

**The reel structure (90 seconds, 6 segments × 15 s):**

| # | Segment | Audio | Visual content | Director state | Why it sells |
|---|---|---|---|---|---|
| 1 | "The 24-band reactor" (0:00–0:15) | A solo drum loop: kick-kick-snare-hat-kick-snare-hat-vocal (synth vocal stab) | Tight crop of the visualizer with the HUD ON showing "kick / snare / hat / vocal" envelopes lighting up in sync with each hit. Each instrument gets a *visibly different* emitter shape. | Director off; default config; randomizer locked seed for reproducibility. | Proves the moat in 15 seconds. No competitor visualizer does this. |
| 2 | "The Director" (0:15–0:30) | 15 seconds excerpted from a single song that includes a build + drop (e.g., a representative dance/rock track the creator owns rights to) | Full-screen Eviland with the phase HUD line visible. The label changes "verse → build → drop" exactly when the song does. The drop transition is a beat-cut, not a crossfade. | Director on; default pool. Recorded with phase markers in the MP4. | The "self-directing" claim becomes undeniable. |
| 3 | "Chorus rhymes" (0:30–0:45) | A song with two distinct choruses ~30 s apart, edited together end-to-end | First chorus: a particular kaleidoscope+palette look. Second chorus: the *same* look returns with the Director's HUD now reading "chorus (rhyme of §2)". Side-by-side split-screen with the first chorus's recording playing on the left half so the rhyme is visually obvious. | Director on; recall mutation 0.08 (slight variation). | "Visual rhyme" goes from claim to demonstration. |
| 4 | "Share a look" (0:45–1:00) | Background ambient pad | Screen recording: paste "K7Q2-9XMF" into the seed field; the visualizer instantly switches to the look that seed represents. Three different seeds shown back to back. | Director off (seeds are the focus). | Activates the "share / collect / curate" loop. |
| 5 | "Built for the stage" (1:00–1:15) | The build/drop song continues | Time-lapsed screen recording: Eviland fullscreen on a laptop monitor; a second monitor (projector) shows the detached window in fullscreen with no chrome; the recorder button is visible recording MP4 in the background. Bottom corner shows the recorder's elapsed timer ticking. | Director on; live state. | Proves the production claim — this is a tool, not a toy. |
| 6 | "Two products" (1:15–1:30) | Soft outro tail | Split: left half = Eviland Studio desktop app UI with the operator panel + randomizer + Director toggle. Right half = a browser tab running a code editor with `import { createEvilandRenderer } from '@eviland/core'` and the same visual mid-render on a canvas in the page. End frame: wordmark + the one-line pitch + URL. | Same active config both sides — proves the lib is the engine. | Closes the loop: this is shippable in two forms. |

**Production approach.** Every segment is produced by:
1. Selecting/composing the audio (no licensing nightmares — use Creative Commons drum loops + a track the creator licensed).
2. Locking the seed (or pool) for that segment.
3. Hitting record in Eviland.
4. Stopping after exactly 15 seconds.
5. The resulting MP4s are concatenated with `ffmpeg -f concat` and titled with a single fixed-width type animation in CapCut/Resolve.

Total production time: ~3 hours including audio prep. The reel ships alongside the v2.0.0 announcement and becomes the OG `<meta>` preview on `eviland.dev`.

**Distribution:**
- YouTube (full 90 s; pinned on channel).
- Twitter/X (90 s upload + a separate 15 s "Director" segment cut as a hook).
- Hacker News post: title "Show HN: Eviland — a music visualizer that hears every instrument", with the reel as the lead and a link to the GitHub release. Comments lead with the technical claims (24-band onset detector, deterministic Director, ES-modules lib).
- /r/musicvisualizer, /r/vjing, /r/edmproduction subreddits — same hook, link to the GitHub.
- An "Eviland Seeds" Twitter account that posts one notable seed per day with a 15-second clip + the seed code. This is the long-tail content engine — every seed shared is a re-shareable artifact.

### B.7 What to ship before claiming "v2.0 Eviland launched"

1. The Director (this spec) implemented + tested + on by default.
2. The Randomizer (separate spec, in flight) with the 8 default pools covering each phase.
3. Live mic/line-in (already designed in `design-live-io.md`).
4. Detached projector window (already designed).
5. MP4 recorder with phase chapter markers (already designed; just needs the Director to feed it).
6. `@eviland/core` published to npm (Phase 5b in `design-package.md`).
7. Eviland Studio standalone Electron app (Phase 5 / Phase 6 in vision).
8. Landing page at `eviland.dev` matching the §B.5 outline.
9. The 90-second demo reel.
10. README.md updated to lead with the one-line pitch and the reel embed.

When all ten are done, NewAmp is bumped to v2.0.0 and Eviland is announced as a standalone product. Anything less is a point release.

### B.8 Critical notes — marketing edition

- **Don't say "AI" in the homepage hero.** The Director is a deterministic state machine. Saying "AI" sets the wrong expectation and invites bad-faith readers to demand a model card. The Director is honestly called "autonomous" or "self-directing" or "conducts" — those are accurate. Reserve "AI" for the *Eviland team's process* (Claude + Codex co-designed the engine), not the runtime.
- **Lead with the moat, not the polish.** "Hears every instrument" is the differentiator nobody else can claim. "Smooth UI" is parity. The hero shot should be a kick/snare/hat split, not a settings panel.
- **The seed is the social object.** Every seed shared on Twitter, Discord, or in a comment is a re-runnable visual experiment. Treat seeds as first-class — make sure the seed code is copyable everywhere it appears, and make sure the seed-paste field is the single most prominent input in Studio's UI.
- **No fake testimonials.** Until real users say real things, the social proof slot is filled with "Used as the default visualizer in NewAmp since 1.7.1" and the GitHub star count. Astroturfing burns trust faster than it builds it.
- **The Director's name in copy is "the Director" (definite article, capital D).** Not "Director Mode," not "Auto-VJ," not "AI Conductor." One name everywhere.
- **The brand is not the visualizer.** Eviland's brand is *the engine that conducts the song*. The visualizer is one expression of it. This phrasing makes future products (Eviland-for-lighting, Eviland-for-stage-LED) feel like natural extensions, not pivots.
