# Eviland — Vision & Build Plan

> From a player feature to a marketable, instrument-aware **generative visual engine**
> for live performance and video production.

## The thesis

Music visualizers have been stuck for 20 years. MilkDrop (2001) is still the gold
standard, and everything since (butterchurn, projectM, Magic, Resolume generators)
is a re-implementation of the same idea: *per-pixel warp equations over a feedback
buffer, driven by 3 crude audio bands (bass/mid/treb)*.

Eviland breaks three things open at once:

1. **Causal, per-instrument reactivity.** A 24-band mel spectral-flux onset detector
   classifies *which instrument* fired (kick / snare / hat / vocal / bass) and gives
   each its own visual event. No other engine sees the music this granularly.
2. **A self-directing generative engine.** A randomizer mints unexpected-but-coherent
   looks; an autonomous **Director** conducts them to the song's structure (intro →
   build → drop → breakdown), with chorus looks that *rhyme* when sections return.
3. **Built for the stage.** Live mic/line-in input, projector/second-display output,
   and high-quality video recording — so it's a real VJ / performance / production
   tool, not just a desktop toy.

Shareable seeds make every great look a short code you can post, recall, and remix.

## Why now

Claude Opus 4.8 + the Eviland architecture means the *creative system itself* — the
operator grammar, the randomizer, the Director — can be designed and tuned at a depth
that was previously a multi-person, multi-month effort. This is the "AI doing
creativity, not just code" moment for the digital-audio space.

## The six phases

| # | Phase | Outcome |
|---|-------|---------|
| 1 | **Lock the look** | Cream → structured color/shape. ✅ done; stutter triage pending. |
| 2 | **Native MilkDrop** | Composable **warp-operator engine** + the iconic bright **waveform layer** + scriptable shapes. Depend on butterchurn for *nothing*. |
| 3 | **Randomizer** | Generative grammar over operator configs; seedable, lockable, shareable, ephemeral-by-default; live mutate/evolve. |
| 4 | **Live I/O** | Mic/line-in device picker; **detached/undocked visualizer window** (push to a 2nd monitor/projector & fullscreen while NewAmp stays browsable); canvas+audio video recorder. |
| 5 | **`@eviland/core`** | Zero-dep, framework-agnostic library (embeddable like butterchurn) + **Eviland Studio** standalone app. NewAmp consumes the lib. |
| 6 | **The Director** | Autonomous AI that reads song structure and conducts the generative engine with narrative arc. The crown. + brand/identity to ship it. |

## Visualizer surfaces (user-facing modes)

1. **Inline** — the visualizer panel inside NewAmp (today).
2. **Fullscreen** — visualizer takes the whole NewAmp window (today).
3. **Visualizer-only** — a clean, chrome-free performance surface.
4. **Detached / undocked** *(new)* — the visualizer pops into its own window you
   can drag to a second monitor or projector and fullscreen there, **while the
   main NewAmp window stays fully browsable**. Architecture: the main window owns
   audio + the reactor and streams the small per-frame `EvilandFrame` (+ palette +
   active generative config / Director state) over IPC to the detached window,
   which is a thin renderer. "Send to projector" = move the detached window to a
   chosen display and fullscreen. The recorder can capture either surface.

## Non-negotiables

- The working renderer must keep working at every step. Verify with
  `scripts/eviland-capture.mjs` (PNG — proves *structure*) **and**
  `scripts/eviland-smoke.mjs` (proves *reactivity*) + `npm run typecheck`.
- Zero-dep core. ES modules only. No stubs, no slop.
- Every config is serializable JSON → a shareable seed.
- The default Eviland look must be expressible as one operator config (regression anchor).

## Specs (this folder)

- `research-milkdrop.md` — authentic warp/wave/shape math
- `research-live-io.md` — Web Audio / Electron / MediaRecorder APIs
- `map-integration.md` — verbatim integration points (source of truth for edits)
- `design-operators.md` — the operator engine
- `design-live-io.md` — live input/output/recording modules
- `design-package.md` — `@eviland/core` extraction + Studio app
- `design-randomizer.md` — generative grammar + seed system
- `design-director-brand.md` — the Director + brand/market positioning
