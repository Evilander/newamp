// Eviland scene registry — the 25 audio-reactive overlay scenes composited
// over the MilkDrop field in 'eviland-live' mode (see scene-overlay.ts).
//
// CONTRACT for every scene file in this directory:
//  - export a single `SceneDef` whose `frag` implements
//        vec4 scene(vec2 uv, vec2 p)
//    uv: 0..1 screen coords. p: centered, aspect-corrected (-1..1 short axis).
//  - The shader body may ONLY declare functions/constants — the runtime
//    provides the uniforms + helpers (see PRELUDE in scene-overlay.ts):
//    hash11/hash21/hash22, vnoise, fbm, rot2, hsv2rgb, paletteRamp, bandAvg,
//    u_time/u_globalTime/u_dt/u_seed/u_fade, u_energy, u_kick/u_bass/u_snare/
//    u_hat/u_vocal (envelopes), u_kickPulse/u_snarePulse/u_hatPulse/
//    u_vocalPulse (decaying onset impulses), u_centroid, u_flatness, u_crest,
//    u_beatPhase, u_beatConf, u_novelty, u_pan, u_width, u_bands[24],
//    u_accent/u_light/u_dark/u_bg, u_res.
//  - Output: vec4 straight (non-premultiplied) color; alpha is the scene's
//    coverage over the MilkDrop field below. Favor alpha < 0.85 overall so
//    the field stays visible; pure black (alpha 0) areas show MilkDrop raw.
//  - DO NOT apply u_fade yourself — the runtime multiplies it into output.
//  - Must visibly react to audio: silence (all audio uniforms 0) should look
//    dim/sparse; an energetic frame should be obviously alive. The scene
//    smoke (scripts/scene-overlay-smoke.mjs) enforces both.
//  - mood: 'calm' | 'mid' | 'high' | 'any' — rotation affinity by energy.

export interface SceneDef {
  id: string;
  name: string;
  mood: 'calm' | 'mid' | 'high' | 'any';
  /** Fragment shader body: helper functions + `vec4 scene(vec2 uv, vec2 p)`. */
  frag: string;
}

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

export const SCENES: SceneDef[] = [
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
];
