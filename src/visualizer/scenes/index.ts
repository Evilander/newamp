// Eviland scene registry — the procedural scenes the scene runtime
// (scene-overlay.ts) draws as sources: into the Eviland engine's feedback
// field, and into MilkDrop's feedback texture in 'eviland-live'.
//
// CONTRACT for every scene file in this directory:
//  - export a single `SceneDef` whose `frag` implements
//        vec4 scene(vec2 uv, vec2 p)
//    uv: 0..1 screen coords. p: centered, aspect-corrected (-1..1 short axis).
//  - The shader body may ONLY declare functions/constants — the runtime
//    provides the uniforms + helpers (see PRELUDE in scene-overlay.ts):
//    hash11/hash21/hash22, vnoise, fbm, rot2, hsv2rgb, paletteRamp, paletteRamp2,
//    bandAvg, bandClock (bandAvg's twin over the band integrals), bandPan(lo, hi)
//    (the mean stereo position of a band range, -1 left .. +1 right),
//    u_time/u_globalTime/u_dt/u_seed/u_fade, u_phase (this scene's integrated
//    `speed`), u_energyTime/u_panTime/u_bandTime[24] (integrals of energy, pan
//    and each band), u_contrast, u_energy, u_kick/u_bass/u_snare/
//    u_hat/u_vocal (envelopes), u_kickPulse/u_snarePulse/u_hatPulse/
//    u_vocalPulse (decaying onset impulses), u_kickCount (kicks so far, at
//    most ~3 per second: re-roll a pattern on floor(u_kickCount), never on a
//    fixed timer), u_centroid, u_flatness, u_crest,
//    u_beatPhase, u_beatConf, u_novelty, u_pan, u_width, u_bands[24],
//    u_bandPan[24] (where each band sits in the stereo image),
//    u_accent/u_accent2/u_light/u_dark/u_bg, u_res.
//  - Output: vec4 straight (non-premultiplied) color; alpha is the scene's
//    coverage over the feedback it is drawn into. Favor alpha < 0.85 overall
//    so the field stays visible; alpha 0 leaves the feedback untouched. How
//    much of the trail beneath that coverage removes is `occlusion` below.
//  - Colour comes from the palette uniforms (paletteRamp, paletteRamp2,
//    u_accent, u_accent2, u_light, u_dark). A scene that brings its own hues
//    fights whatever palette the user picked; test:eviland-diversity fails it.
//    paletteRamp(t) is perceptual (an OKLCh table: equal steps in t are equal
//    steps in lightness, and the middle of a hue change stays coloured), so a
//    fixed t is no longer an sRGB quarter point of dark/accent/light.
//    paletteRamp2 runs the same dark -> light line through u_accent2, a second
//    accent in harmony with the first; u_accent2 is u_accent when the palette
//    has none, so a scene using it never needs a fallback of its own.
//  - Highlights must be tinted by the palette: use mix(u_light, vec3(1.0), 0.35)
//    for the hottest point, not a bare vec3(1.0) or an added white. MAIN rolls
//    the peak channel off past 0.85, so a pile-up of plain white goes grey-white
//    and a tinted one keeps its hue to the top.
//  - NEVER animate with `time * speed(audio)`: once a track has been playing
//    a while, a small change in the audio jumps the animation by seconds.
//    Declare `speed` below and animate with u_phase, or use the integrals
//    (u_energyTime, u_bandTime, bandClock). The same goes for u_phase and the
//    integrals themselves: never multiply them by an audio value.
//    scripts/eviland-scene-clock-test.mjs checks every scene for this.
//  - DO NOT apply u_fade yourself — the runtime multiplies it into output.
//  - Must visibly react to audio: silence (all audio uniforms 0) should look
//    dim/sparse; an energetic frame should be obviously alive. The scene
//    smoke (scripts/scene-overlay-smoke.mjs) enforces both.
//  - mood: 'calm' | 'mid' | 'high' | 'any' — rotation affinity by energy.

import type { EvilandFrame } from '../eviland-audio';

export interface SceneDef {
  id: string;
  name: string;
  mood: 'calm' | 'mid' | 'high' | 'any';
  /** Fragment shader body: helper functions + `vec4 scene(vec2 uv, vec2 p)`. */
  frag: string;
  /**
   * Animation speed for this frame (1 = real time). The runtime integrates it
   * into u_phase, so audio changes how fast the scene moves, never where it is.
   */
  speed?: (frame: EvilandFrame, pulses: { kick: number; snare: number; hat: number; vocal: number }) => number;
  /**
   * How much of the field beneath the scene it covers, 0..1: 1 is source-over
   * (a solid that hides the trail under it), 0 is additive (light that lets
   * the trail through). Defaults to DEFAULT_OCCLUSION in scene-overlay.ts.
   */
  occlusion?: number;
}

import { volumeGarden } from './volume-garden';
import { starfieldWarp } from './starfield-warp';
import { silkWaves } from './silk-waves';
import { spectroRain } from './spectro-rain';
import { lightningVeins } from './lightning-veins';
import { voronoiPulse } from './voronoi-pulse';
import { kaleidoBloom } from './kaleido-bloom';
import { plasmaAurora } from './plasma-aurora';
import { particleFountain } from './particle-fountain';
import { ribbonFlow } from './ribbon-flow';
import { tunnelRings } from './tunnel-rings';
import { glitchBars } from './glitch-bars';
import { liquidMetal } from './liquid-metal';
import { orbitSwarm } from './orbit-swarm';
import { fractalZoom } from './fractal-zoom';
import { neonGrid } from './neon-grid';
import { smokeInk } from './smoke-ink';
import { crystalShards } from './crystal-shards';
import { supershapePulse } from './supershape-pulse';
import { fireSpires } from './fire-spires';
import { moireWeave } from './moire-weave';
import { cometTrails } from './comet-trails';
import { hexPulse } from './hex-pulse';
import { eyeOfStorm } from './eye-of-storm';
import { pixelBloom } from './pixel-bloom';
import { constellation } from './constellation';
import { spiralGalaxy } from './spiral-galaxy';
import { cityPulse } from './city-pulse';
import { laserStorm } from './laser-storm';
import { deepJelly } from './deep-jelly';
import { phosphorScope } from './phosphor-scope';
import { vuCathedral } from './vu-cathedral';
import { cellColony } from './cell-colony';
import { neuralBloom } from './neural-bloom';
import { radiolaria } from './radiolaria';
import { ciliaReef } from './cilia-reef';
import { capillaryBloom } from './capillary-bloom';

import { medusaBloom } from './medusa-bloom';
import { chromatinFlow } from './chromatin-flow';
import { featherPolyp } from './feather-polyp';
import { planktonDrift } from './plankton-drift';
import { muscleFibres } from './muscle-fibres';

import { spectralSlit } from './spectral-slit';
import { bokehField } from './bokeh-field';
import { dataRaster } from './data-raster';
import { causticFloor } from './caustic-floor';
import { thinFilm } from './thin-film';
import { cymaticPlate } from './cymatic-plate';
import { rippleTank } from './ripple-tank';
import { trussChase } from './truss-chase';
import { goboHeads } from './gobo-heads';
import { prismDispersal } from './prism-dispersal';
import { iceHalo } from './ice-halo';

export const SCENES: SceneDef[] = [
  volumeGarden,
  starfieldWarp,
  silkWaves,
  spectroRain,
  lightningVeins,
  voronoiPulse,
  kaleidoBloom,
  plasmaAurora,
  particleFountain,
  ribbonFlow,
  tunnelRings,
  glitchBars,
  liquidMetal,
  orbitSwarm,
  fractalZoom,
  neonGrid,
  smokeInk,
  crystalShards,
  supershapePulse,
  fireSpires,
  moireWeave,
  cometTrails,
  hexPulse,
  eyeOfStorm,
  pixelBloom,
  constellation,
  spiralGalaxy,
  cityPulse,
  laserStorm,
  deepJelly,
  phosphorScope,
  vuCathedral,
  cellColony,
  neuralBloom,
  radiolaria,
  ciliaReef,
  capillaryBloom,
  medusaBloom,
  chromatinFlow,
  featherPolyp,
  planktonDrift,
  muscleFibres,
  spectralSlit,
  bokehField,
  dataRaster,
  causticFloor,
  thinFilm,
  cymaticPlate,
  rippleTank,
  trussChase,
  goboHeads,
  prismDispersal,
  iceHalo,
];
