// Eviland generative randomizer.
//
// The randomizer mints new OperatorConfigs from a seed. It is the engine that
// turns "press the dice" into a distinct, musically coherent look: an archetype
// (tunnel, kaleidoscope, liquid, lattice, nebula, strobe) picks the *character*
// of the visual (which channels are alive, which audio features drive them,
// what palette family fits), then per-channel samplers draw concrete values
// inside the operator engine's GPU-safe ranges (with a healthy safety margin so
// the look never white-outs or strobes the user).
//
// Everything is deterministic from the seed: same seed string/number → byte-for-
// byte identical config, every time, on every machine. This is what makes
// `encodeSeedCode`-based "share this look" actually work.
//
// Zero dependencies, ES modules, framework-free — part of the eviland core.

import {
  type AudioFeature,
  type Binding,
  type Channel,
  type Curve,
  type OperatorConfig,
  type PaletteConfig,
  type RGB,
  type WaveMode,
  type WaveformConfig,
  defaultConfig,
  cloneConfig,
} from './eviland-operators';
import {
  Rng,
  encodeSeedCode,
  decodeSeedCode,
  hashSeed,
  toSeedState,
} from './eviland-rng';

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------
//
// An archetype is an internal *template* — it doesn't literally produce a fixed
// config, it biases the sampler so the random look has a recognisable identity.
// "tunnel" wants zoom-in + mirror, "lattice" wants tight kaleidoscope + sharp
// bars, "liquid" wants warp + low decay, etc. The actual numbers are still
// drawn by the Rng, so two seeds against the same archetype look like cousins
// but never twins.

export const ARCHETYPES = [
  'tunnel',
  'kaleidoscope',
  'liquid',
  'lattice',
  'nebula',
  'strobe',
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

interface NumRange { min: number; max: number }
interface BindingSpec {
  feature: AudioFeature;
  gain: NumRange;
  curve?: Curve;
  /** Probability the binding actually appears in the sampled channel. */
  chance?: number;
}
interface ChannelSpec {
  base: NumRange;
  /** Pool of candidate bindings; sampler picks a subset by `chance`. */
  bindings: BindingSpec[];
}

interface ArchetypeTemplate {
  /** Per-channel base + binding pools, *all within* the clamp safety margin. */
  zoom: ChannelSpec;
  rotate: ChannelSpec;
  swirl: ChannelSpec;
  hueCycle: ChannelSpec;
  decay: ChannelSpec;
  warpAmp: ChannelSpec;
  warpScale: ChannelSpec;
  mirror: ChannelSpec;
  mirrorMix: ChannelSpec;
  flowX: ChannelSpec;
  flowY: ChannelSpec;
  fluid: ChannelSpec;
  vorticity: ChannelSpec;
  bloom: ChannelSpec;
  /** Allowed kaleidoscope segment counts when mirrorSet is used. */
  mirrorSets: number[][];
  /** Probability the archetype uses a discrete mirrorSet vs a continuous mirror channel. */
  mirrorSetChance: number;
  /** Whether spinFromSection is on (most archetypes want it). */
  spinFromSection: boolean;
  /** Weighted wave modes — bars feels lattice-y, lissajous feels liquid-y, etc. */
  waveModes: { mode: WaveMode; weight: number }[];
  waveform: {
    intensity: NumRange;
    intensityBindings: BindingSpec[];
    thickness: NumRange;
    scale: NumRange;
  };
  emitterScale: NumRange;
  emitterGain: NumRange;
  /** Palette scheme weights — which colour family fits this archetype. */
  paletteSchemes: { scheme: PaletteScheme; weight: number }[];
  /** Saturation/value envelope for palette generation. */
  paletteSat: NumRange;
  paletteVal: NumRange;
  /** Background lightness (kept dark to give bloom room). */
  paletteBgVal: NumRange;
}

type PaletteScheme = 'analogous' | 'complementary' | 'triadic' | 'splitComplementary' | 'monochrome' | 'tetradic';

// ---------------------------------------------------------------------------
// SAFETY: clamp limits from evalConfig are
//   zoom[-0.12,0.25], rotate[-0.06,0.06], swirl[-0.25,0.25], hueCycle[-0.05,0.05],
//   decay[0.78,0.97], warpAmp[0,0.02], warpScale[0.5,8],
//   mirror[1,16], mirrorMix[0,0.98], flow[-0.01,0.01], fluid[0,1], vorticity[0,30],
//   waveIntensity[0,3], bloom[0,1.2], emitterScale[0.2,3], emitterGain[0,2.5].
// All sampler ranges below stay *well* inside those, especially:
//   - decay base in [0.82,0.93] (audio bindings can dip it briefly)
//   - mirrorMix in [0,0.9]
//   - warpAmp small enough that bindings can't push past 0.02
// ---------------------------------------------------------------------------

const ARCHETYPE_TEMPLATES: Record<Archetype, ArchetypeTemplate> = {
  // ── tunnel ──────────────────────────────────────────────────────────────
  // Zoom-driven warp into the centre. High mirrorMix for kaleidoscopic depth.
  tunnel: {
    zoom: {
      base: { min: 0.012, max: 0.04 },
      bindings: [
        { feature: 'kick', gain: { min: 0.025, max: 0.05 }, chance: 0.9 },
        { feature: 'bass', gain: { min: 0.008, max: 0.018 }, chance: 0.75 },
        { feature: 'energy', gain: { min: 0.004, max: 0.012 }, chance: 0.5 },
      ],
    },
    rotate: {
      base: { min: -0.004, max: 0.004 },
      bindings: [
        { feature: 'energy', gain: { min: 0.005, max: 0.012 }, chance: 0.7 },
        { feature: 'beatPhase', gain: { min: 0.0008, max: 0.002 }, chance: 0.5 },
      ],
    },
    swirl: {
      base: { min: 0.01, max: 0.06 },
      bindings: [
        { feature: 'novelty', gain: { min: 0.015, max: 0.04 }, chance: 0.8 },
        { feature: 'width', gain: { min: 0.01, max: 0.025 }, chance: 0.5 },
      ],
    },
    hueCycle: {
      base: { min: 0.001, max: 0.004 },
      bindings: [
        { feature: 'centroid', gain: { min: 0.004, max: 0.012 }, chance: 0.85 },
        { feature: 'energy', gain: { min: 0.003, max: 0.008 }, chance: 0.6 },
      ],
    },
    decay: {
      base: { min: 0.88, max: 0.93 },
      bindings: [
        { feature: 'flatness', gain: { min: -0.06, max: -0.02 }, chance: 0.8 },
        { feature: 'crest', gain: { min: -0.025, max: -0.01 }, chance: 0.5 },
      ],
    },
    warpAmp: {
      base: { min: 0.0003, max: 0.0015 },
      bindings: [
        { feature: 'bass', gain: { min: 0.0006, max: 0.0014 }, chance: 0.7 },
      ],
    },
    warpScale: {
      base: { min: 1.8, max: 3.5 },
      bindings: [
        { feature: 'width', gain: { min: 0.8, max: 2.2 }, chance: 0.5 },
      ],
    },
    mirror: {
      base: { min: 6, max: 12 },
      bindings: [],
    },
    mirrorMix: {
      base: { min: 0.55, max: 0.78 },
      bindings: [
        { feature: 'energy', gain: { min: 0.08, max: 0.18 }, chance: 0.7 },
      ],
    },
    flowX: {
      base: { min: -0.0004, max: 0.0004 },
      bindings: [
        { feature: 'pan', gain: { min: 0.0004, max: 0.001 }, chance: 0.5 },
      ],
    },
    flowY: {
      base: { min: -0.0008, max: 0.0002 },
      bindings: [],
    },
    fluid: {
      base: { min: 0.2, max: 0.6 },
      bindings: [
        { feature: 'energy', gain: { min: 0.05, max: 0.18 }, chance: 0.6 },
      ],
    },
    vorticity: {
      base: { min: 6, max: 16 },
      bindings: [],
    },
    bloom: {
      base: { min: 0.15, max: 0.5 },
      bindings: [
        { feature: 'kick', gain: { min: 0.1, max: 0.3 }, chance: 0.6 },
      ],
    },
    mirrorSets: [[6, 8, 10, 12], [4, 6, 8, 12], [8, 8, 12, 16]],
    mirrorSetChance: 0.5,
    spinFromSection: true,
    waveModes: [
      { mode: 'off', weight: 1.5 },
      { mode: 'radial', weight: 2.5 },
      { mode: 'line', weight: 1 },
    ],
    waveform: {
      intensity: { min: 0.6, max: 1.4 },
      intensityBindings: [
        { feature: 'energy', gain: { min: 0.4, max: 0.9 }, chance: 0.7 },
      ],
      thickness: { min: 0.006, max: 0.018 },
      scale: { min: 0.18, max: 0.45 },
    },
    emitterScale: { min: 0.8, max: 1.4 },
    emitterGain: { min: 0.9, max: 1.6 },
    paletteSchemes: [
      { scheme: 'analogous', weight: 3 },
      { scheme: 'monochrome', weight: 2 },
      { scheme: 'splitComplementary', weight: 1 },
    ],
    paletteSat: { min: 0.6, max: 0.95 },
    paletteVal: { min: 0.7, max: 1 },
    paletteBgVal: { min: 0.02, max: 0.08 },
  },

  // ── kaleidoscope ────────────────────────────────────────────────────────
  // High mirror count, low warp, vivid palette. Symmetry is the star.
  kaleidoscope: {
    zoom: {
      base: { min: 0.001, max: 0.012 },
      bindings: [
        { feature: 'kick', gain: { min: 0.018, max: 0.035 }, chance: 0.7 },
        { feature: 'bass', gain: { min: 0.005, max: 0.012 }, chance: 0.5 },
      ],
    },
    rotate: {
      base: { min: -0.006, max: 0.006 },
      bindings: [
        { feature: 'energy', gain: { min: 0.006, max: 0.014 }, chance: 0.85 },
        { feature: 'beatPhase', gain: { min: 0.001, max: 0.003 }, chance: 0.6 },
      ],
    },
    swirl: {
      base: { min: -0.04, max: 0.08 },
      bindings: [
        { feature: 'novelty', gain: { min: 0.02, max: 0.06 }, chance: 0.85 },
        { feature: 'snare', gain: { min: 0.01, max: 0.03 }, chance: 0.5 },
      ],
    },
    hueCycle: {
      base: { min: 0.002, max: 0.006 },
      bindings: [
        { feature: 'centroid', gain: { min: 0.006, max: 0.014 }, chance: 0.9 },
        { feature: 'vocal', gain: { min: 0.003, max: 0.008 }, chance: 0.4 },
      ],
    },
    decay: {
      base: { min: 0.86, max: 0.92 },
      bindings: [
        { feature: 'flatness', gain: { min: -0.05, max: -0.02 }, chance: 0.7 },
      ],
    },
    warpAmp: {
      base: { min: 0.0001, max: 0.0008 },
      bindings: [
        { feature: 'bass', gain: { min: 0.0003, max: 0.001 }, chance: 0.5 },
      ],
    },
    warpScale: {
      base: { min: 2, max: 5 },
      bindings: [
        { feature: 'width', gain: { min: 0.6, max: 1.8 }, chance: 0.5 },
      ],
    },
    mirror: {
      base: { min: 8, max: 14 },
      bindings: [],
    },
    mirrorMix: {
      base: { min: 0.72, max: 0.88 },
      bindings: [
        { feature: 'energy', gain: { min: 0.05, max: 0.12 }, chance: 0.5 },
      ],
    },
    flowX: { base: { min: -0.0003, max: 0.0003 }, bindings: [] },
    flowY: { base: { min: -0.0003, max: 0.0003 }, bindings: [] },
    fluid: {
      base: { min: 0.2, max: 0.6 },
      bindings: [
        { feature: 'energy', gain: { min: 0.04, max: 0.15 }, chance: 0.5 },
      ],
    },
    vorticity: {
      base: { min: 6, max: 16 },
      bindings: [],
    },
    bloom: {
      base: { min: 0.1, max: 0.4 },
      bindings: [
        { feature: 'snare', gain: { min: 0.08, max: 0.2 }, chance: 0.5 },
      ],
    },
    mirrorSets: [
      [4, 6, 8, 12, 16],
      [6, 8, 8, 12, 12],
      [8, 10, 12, 14, 16],
      [5, 7, 9, 11],
    ],
    mirrorSetChance: 0.8,
    spinFromSection: true,
    waveModes: [
      { mode: 'radial', weight: 3 },
      { mode: 'lissajous', weight: 2 },
      { mode: 'off', weight: 1 },
    ],
    waveform: {
      intensity: { min: 0.5, max: 1.2 },
      intensityBindings: [
        { feature: 'hat', gain: { min: 0.3, max: 0.7 }, chance: 0.6 },
      ],
      thickness: { min: 0.005, max: 0.014 },
      scale: { min: 0.2, max: 0.4 },
    },
    emitterScale: { min: 0.7, max: 1.2 },
    emitterGain: { min: 0.8, max: 1.4 },
    paletteSchemes: [
      { scheme: 'triadic', weight: 3 },
      { scheme: 'tetradic', weight: 2 },
      { scheme: 'splitComplementary', weight: 2 },
    ],
    paletteSat: { min: 0.75, max: 1 },
    paletteVal: { min: 0.75, max: 1 },
    paletteBgVal: { min: 0.02, max: 0.06 },
  },

  // ── liquid ──────────────────────────────────────────────────────────────
  // Soft warp + low mirror + flow. Long decay → smearing trails.
  liquid: {
    zoom: {
      base: { min: -0.01, max: 0.01 },
      bindings: [
        { feature: 'bass', gain: { min: 0.015, max: 0.03 }, chance: 0.85 },
        { feature: 'kick', gain: { min: 0.01, max: 0.025 }, chance: 0.6 },
      ],
    },
    rotate: {
      base: { min: -0.003, max: 0.003 },
      bindings: [
        { feature: 'energy', gain: { min: 0.003, max: 0.009 }, chance: 0.7 },
      ],
    },
    swirl: {
      base: { min: 0.04, max: 0.12 },
      bindings: [
        { feature: 'width', gain: { min: 0.02, max: 0.05 }, chance: 0.85 },
        { feature: 'novelty', gain: { min: 0.015, max: 0.035 }, chance: 0.7 },
      ],
    },
    hueCycle: {
      base: { min: 0.0015, max: 0.005 },
      bindings: [
        { feature: 'centroid', gain: { min: 0.005, max: 0.012 }, chance: 0.85 },
      ],
    },
    decay: {
      base: { min: 0.90, max: 0.94 },
      bindings: [
        { feature: 'flatness', gain: { min: -0.05, max: -0.02 }, chance: 0.6 },
        { feature: 'crest', gain: { min: -0.02, max: -0.005 }, chance: 0.4 },
      ],
    },
    warpAmp: {
      base: { min: 0.0015, max: 0.005 },
      bindings: [
        { feature: 'bass', gain: { min: 0.001, max: 0.003 }, chance: 0.85 },
        { feature: 'energy', gain: { min: 0.0005, max: 0.0018 }, chance: 0.5 },
      ],
    },
    warpScale: {
      base: { min: 1.2, max: 3 },
      bindings: [
        { feature: 'width', gain: { min: 1, max: 2.5 }, chance: 0.7 },
      ],
    },
    mirror: {
      base: { min: 1, max: 5 },
      bindings: [],
    },
    mirrorMix: {
      base: { min: 0.1, max: 0.45 },
      bindings: [
        { feature: 'energy', gain: { min: 0.05, max: 0.18 }, chance: 0.6 },
      ],
    },
    flowX: {
      base: { min: -0.001, max: 0.001 },
      bindings: [
        { feature: 'pan', gain: { min: 0.001, max: 0.003 }, chance: 0.85 },
      ],
    },
    flowY: {
      base: { min: -0.0008, max: 0.0008 },
      bindings: [
        { feature: 'energy', gain: { min: 0.0005, max: 0.0015 }, chance: 0.4 },
      ],
    },
    fluid: {
      base: { min: 0.5, max: 1.0 },
      bindings: [
        { feature: 'energy', gain: { min: 0.05, max: 0.2 }, chance: 0.7 },
      ],
    },
    vorticity: {
      base: { min: 10, max: 24 },
      bindings: [],
    },
    bloom: {
      base: { min: 0.25, max: 0.6 },
      bindings: [
        { feature: 'energy', gain: { min: 0.1, max: 0.25 }, chance: 0.7 },
      ],
    },
    mirrorSets: [[1, 2, 3, 4], [2, 3, 4, 5]],
    mirrorSetChance: 0.25,
    spinFromSection: true,
    waveModes: [
      { mode: 'line', weight: 2 },
      { mode: 'lissajous', weight: 3 },
      { mode: 'off', weight: 1.5 },
    ],
    waveform: {
      intensity: { min: 0.4, max: 1.1 },
      intensityBindings: [
        { feature: 'vocal', gain: { min: 0.3, max: 0.8 }, chance: 0.6 },
      ],
      thickness: { min: 0.008, max: 0.022 },
      scale: { min: 0.25, max: 0.5 },
    },
    emitterScale: { min: 1.1, max: 1.8 },
    emitterGain: { min: 0.9, max: 1.5 },
    paletteSchemes: [
      { scheme: 'analogous', weight: 4 },
      { scheme: 'monochrome', weight: 2 },
      { scheme: 'complementary', weight: 1 },
    ],
    paletteSat: { min: 0.5, max: 0.85 },
    paletteVal: { min: 0.6, max: 0.95 },
    paletteBgVal: { min: 0.03, max: 0.1 },
  },

  // ── lattice ─────────────────────────────────────────────────────────────
  // Geometric, fast-decay, bars waveform. Crisp and percussive.
  lattice: {
    zoom: {
      base: { min: 0.002, max: 0.015 },
      bindings: [
        { feature: 'kick', gain: { min: 0.03, max: 0.05 }, chance: 0.9, curve: 'pulse' },
        { feature: 'snare', gain: { min: 0.005, max: 0.015 }, chance: 0.5 },
      ],
    },
    rotate: {
      base: { min: -0.003, max: 0.003 },
      bindings: [
        { feature: 'beatPhase', gain: { min: 0.0008, max: 0.0025 }, chance: 0.8 },
      ],
    },
    swirl: {
      base: { min: -0.02, max: 0.02 },
      bindings: [
        { feature: 'snare', gain: { min: 0.015, max: 0.04 }, chance: 0.7 },
      ],
    },
    hueCycle: {
      base: { min: 0.0015, max: 0.004 },
      bindings: [
        { feature: 'centroid', gain: { min: 0.005, max: 0.01 }, chance: 0.7 },
      ],
    },
    decay: {
      base: { min: 0.83, max: 0.88 },
      bindings: [
        { feature: 'crest', gain: { min: -0.02, max: -0.005 }, chance: 0.5 },
      ],
    },
    warpAmp: {
      base: { min: 0.0001, max: 0.0006 },
      bindings: [],
    },
    warpScale: {
      base: { min: 3, max: 6 },
      bindings: [],
    },
    mirror: {
      base: { min: 4, max: 10 },
      bindings: [],
    },
    mirrorMix: {
      base: { min: 0.5, max: 0.78 },
      bindings: [
        { feature: 'energy', gain: { min: 0.05, max: 0.12 }, chance: 0.5 },
      ],
    },
    flowX: { base: { min: -0.0002, max: 0.0002 }, bindings: [] },
    flowY: { base: { min: -0.0002, max: 0.0002 }, bindings: [] },
    fluid: {
      base: { min: 0, max: 0.25 },
      bindings: [],
    },
    vorticity: {
      base: { min: 0, max: 8 },
      bindings: [],
    },
    bloom: {
      base: { min: 0.05, max: 0.25 },
      bindings: [
        { feature: 'kick', gain: { min: 0.15, max: 0.35 }, chance: 0.7, curve: 'pulse' },
      ],
    },
    mirrorSets: [[4, 6, 8, 12], [6, 8, 12, 16], [4, 8, 8, 16]],
    mirrorSetChance: 0.6,
    spinFromSection: true,
    waveModes: [
      { mode: 'bars', weight: 4 },
      { mode: 'radial', weight: 1 },
      { mode: 'off', weight: 1 },
    ],
    waveform: {
      intensity: { min: 0.7, max: 1.4 },
      intensityBindings: [
        { feature: 'energy', gain: { min: 0.5, max: 1 }, chance: 0.8 },
      ],
      thickness: { min: 0.004, max: 0.012 },
      scale: { min: 0.3, max: 0.55 },
    },
    emitterScale: { min: 0.6, max: 1.1 },
    emitterGain: { min: 1, max: 1.6 },
    paletteSchemes: [
      { scheme: 'complementary', weight: 3 },
      { scheme: 'triadic', weight: 2 },
      { scheme: 'splitComplementary', weight: 1 },
    ],
    paletteSat: { min: 0.7, max: 1 },
    paletteVal: { min: 0.8, max: 1 },
    paletteBgVal: { min: 0.01, max: 0.05 },
  },

  // ── nebula ──────────────────────────────────────────────────────────────
  // Slow, dreamy, big emitters, gentle hue cycling. Background-friendly.
  nebula: {
    zoom: {
      base: { min: -0.005, max: 0.008 },
      bindings: [
        { feature: 'bass', gain: { min: 0.006, max: 0.015 }, chance: 0.7, curve: 'sqrt' },
      ],
    },
    rotate: {
      base: { min: -0.002, max: 0.002 },
      bindings: [
        { feature: 'energy', gain: { min: 0.002, max: 0.006 }, chance: 0.6 },
      ],
    },
    swirl: {
      base: { min: 0.02, max: 0.07 },
      bindings: [
        { feature: 'width', gain: { min: 0.01, max: 0.03 }, chance: 0.7 },
      ],
    },
    hueCycle: {
      base: { min: 0.003, max: 0.008 },
      bindings: [
        { feature: 'vocal', gain: { min: 0.003, max: 0.008 }, chance: 0.6 },
        { feature: 'centroid', gain: { min: 0.003, max: 0.007 }, chance: 0.5 },
      ],
    },
    decay: {
      base: { min: 0.91, max: 0.95 },
      bindings: [
        { feature: 'flatness', gain: { min: -0.04, max: -0.015 }, chance: 0.5 },
      ],
    },
    warpAmp: {
      base: { min: 0.0008, max: 0.003 },
      bindings: [
        { feature: 'energy', gain: { min: 0.0005, max: 0.0015 }, chance: 0.6 },
      ],
    },
    warpScale: {
      base: { min: 1, max: 2.5 },
      bindings: [
        { feature: 'width', gain: { min: 0.5, max: 1.5 }, chance: 0.5 },
      ],
    },
    mirror: {
      base: { min: 2, max: 6 },
      bindings: [],
    },
    mirrorMix: {
      base: { min: 0.2, max: 0.5 },
      bindings: [
        { feature: 'energy', gain: { min: 0.05, max: 0.15 }, chance: 0.4 },
      ],
    },
    flowX: {
      base: { min: -0.0006, max: 0.0006 },
      bindings: [
        { feature: 'pan', gain: { min: 0.0006, max: 0.0018 }, chance: 0.6 },
      ],
    },
    flowY: {
      base: { min: -0.0005, max: 0.0005 },
      bindings: [],
    },
    fluid: {
      base: { min: 0.5, max: 1.0 },
      bindings: [
        { feature: 'energy', gain: { min: 0.05, max: 0.2 }, chance: 0.6 },
      ],
    },
    vorticity: {
      base: { min: 10, max: 24 },
      bindings: [],
    },
    bloom: {
      base: { min: 0.35, max: 0.75 },
      bindings: [
        { feature: 'energy', gain: { min: 0.1, max: 0.25 }, chance: 0.7 },
      ],
    },
    mirrorSets: [[1, 2, 3, 4, 6]],
    mirrorSetChance: 0.3,
    spinFromSection: true,
    waveModes: [
      { mode: 'off', weight: 3 },
      { mode: 'line', weight: 1 },
      { mode: 'lissajous', weight: 1.5 },
    ],
    waveform: {
      intensity: { min: 0.3, max: 0.9 },
      intensityBindings: [
        { feature: 'vocal', gain: { min: 0.3, max: 0.7 }, chance: 0.7 },
      ],
      thickness: { min: 0.01, max: 0.025 },
      scale: { min: 0.2, max: 0.45 },
    },
    emitterScale: { min: 1.3, max: 2.2 },
    emitterGain: { min: 0.7, max: 1.3 },
    paletteSchemes: [
      { scheme: 'analogous', weight: 3 },
      { scheme: 'monochrome', weight: 2 },
      { scheme: 'tetradic', weight: 1 },
    ],
    paletteSat: { min: 0.4, max: 0.8 },
    paletteVal: { min: 0.6, max: 0.95 },
    paletteBgVal: { min: 0.02, max: 0.08 },
  },

  // ── strobe ──────────────────────────────────────────────────────────────
  // Pulse-driven flash. Low base intensity + huge kick-pulse gains so the
  // effect is *transient* (no sustained white-out). Stays safely under decay
  // bounds because base decay sits comfortably mid-range.
  strobe: {
    zoom: {
      base: { min: 0.005, max: 0.02 },
      bindings: [
        { feature: 'kick', gain: { min: 0.04, max: 0.055 }, chance: 1, curve: 'pulse' },
        { feature: 'snare', gain: { min: 0.01, max: 0.025 }, chance: 0.7, curve: 'pulse' },
      ],
    },
    rotate: {
      base: { min: -0.005, max: 0.005 },
      bindings: [
        { feature: 'beatPhase', gain: { min: 0.001, max: 0.003 }, chance: 0.7 },
        { feature: 'energy', gain: { min: 0.005, max: 0.012 }, chance: 0.6 },
      ],
    },
    swirl: {
      base: { min: -0.06, max: 0.06 },
      bindings: [
        { feature: 'novelty', gain: { min: 0.02, max: 0.05 }, chance: 0.85 },
      ],
    },
    hueCycle: {
      base: { min: 0, max: 0.005 },
      bindings: [
        { feature: 'snare', gain: { min: 0.005, max: 0.012 }, chance: 0.7, curve: 'pulse' },
        { feature: 'centroid', gain: { min: 0.004, max: 0.01 }, chance: 0.6 },
      ],
    },
    decay: {
      // Mid-range so kicks read clearly, never strobing the user.
      base: { min: 0.84, max: 0.88 },
      bindings: [
        { feature: 'crest', gain: { min: -0.02, max: -0.008 }, chance: 0.6 },
      ],
    },
    warpAmp: {
      base: { min: 0.0001, max: 0.0006 },
      bindings: [
        { feature: 'kick', gain: { min: 0.0006, max: 0.0014 }, chance: 0.6, curve: 'pulse' },
      ],
    },
    warpScale: {
      base: { min: 2, max: 5 },
      bindings: [],
    },
    mirror: {
      base: { min: 4, max: 10 },
      bindings: [],
    },
    mirrorMix: {
      base: { min: 0.5, max: 0.75 },
      bindings: [
        { feature: 'energy', gain: { min: 0.08, max: 0.18 }, chance: 0.7 },
      ],
    },
    flowX: { base: { min: -0.0003, max: 0.0003 }, bindings: [] },
    flowY: { base: { min: -0.0003, max: 0.0003 }, bindings: [] },
    fluid: {
      base: { min: 0, max: 0.25 },
      bindings: [],
    },
    vorticity: {
      base: { min: 0, max: 8 },
      bindings: [],
    },
    bloom: {
      base: { min: 0.05, max: 0.2 },
      bindings: [
        { feature: 'kick', gain: { min: 0.3, max: 0.7 }, chance: 0.9, curve: 'pulse' },
        { feature: 'snare', gain: { min: 0.15, max: 0.35 }, chance: 0.6, curve: 'pulse' },
      ],
    },
    mirrorSets: [[4, 6, 8, 12], [6, 8, 12, 16]],
    mirrorSetChance: 0.55,
    spinFromSection: true,
    waveModes: [
      { mode: 'bars', weight: 3 },
      { mode: 'radial', weight: 2 },
      { mode: 'line', weight: 1 },
    ],
    waveform: {
      intensity: { min: 0.6, max: 1.3 },
      intensityBindings: [
        { feature: 'kick', gain: { min: 0.5, max: 1 }, chance: 0.8, curve: 'pulse' },
      ],
      thickness: { min: 0.005, max: 0.013 },
      scale: { min: 0.3, max: 0.55 },
    },
    emitterScale: { min: 0.6, max: 1.1 },
    emitterGain: { min: 1.1, max: 1.8 },
    paletteSchemes: [
      { scheme: 'complementary', weight: 3 },
      { scheme: 'splitComplementary', weight: 2 },
      { scheme: 'triadic', weight: 1 },
    ],
    paletteSat: { min: 0.85, max: 1 },
    paletteVal: { min: 0.85, max: 1 },
    paletteBgVal: { min: 0.01, max: 0.05 },
  },
};

// ---------------------------------------------------------------------------
// HSV → RGB palette generation
// ---------------------------------------------------------------------------
//
// Eviland configs accept RGB in 0..1. We sample hues in HSV because the only
// way to mint *harmonious* multi-hue palettes is to think in colour-wheel
// relationships (analogous = ±30°, complementary = 180°, etc.).

function hsvToRgb(h: number, s: number, v: number): RGB {
  // h in [0,1), s/v in [0,1]
  const hh = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    case 5: return [v, p, q];
    default: return [v, v, v];
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function wrap01(v: number): number { return ((v % 1) + 1) % 1; }

function pickPaletteScheme(rng: Rng, schemes: ArchetypeTemplate['paletteSchemes']): PaletteScheme {
  return rng.weighted(schemes.map(s => s.scheme), schemes.map(s => s.weight));
}

/** Return three secondary hues (offsets in [0,1)) given a scheme. */
function schemeOffsets(scheme: PaletteScheme, rng: Rng): [number, number, number] {
  const jitter = () => rng.range(-0.02, 0.02);
  switch (scheme) {
    case 'analogous':
      return [jitter(), 0.083 + jitter(), -0.083 + jitter()]; // ~±30°
    case 'complementary':
      return [jitter(), 0.5 + jitter(), 0.5 + jitter() + 0.03];
    case 'triadic':
      return [jitter(), 0.333 + jitter(), 0.667 + jitter()];
    case 'splitComplementary':
      return [jitter(), 0.5 - 0.083 + jitter(), 0.5 + 0.083 + jitter()];
    case 'tetradic':
      return [jitter(), 0.25 + jitter(), 0.5 + jitter()];
    case 'monochrome':
    default:
      return [jitter(), jitter() + 0.02, jitter() - 0.02];
  }
}

function generatePalette(rng: Rng, template: ArchetypeTemplate): PaletteConfig {
  const scheme = pickPaletteScheme(rng, template.paletteSchemes);
  const rootHue = rng.next();
  const offsets = schemeOffsets(scheme, rng);

  // Saturation/value envelopes — accent/light are the brightest, dark is muted.
  const satA = rng.range(template.paletteSat.min, template.paletteSat.max);
  const valA = rng.range(template.paletteVal.min, template.paletteVal.max);
  const satL = clamp01(satA * rng.range(0.55, 0.85));
  const valL = clamp01(rng.range(0.9, 1));
  const satD = clamp01(satA * rng.range(0.45, 0.8));
  const valD = clamp01(rng.range(0.18, 0.38));

  const bgHue = wrap01(rootHue + (offsets[0] ?? 0));
  const darkHue = wrap01(rootHue + (offsets[2] ?? 0));
  const accentHue = wrap01(rootHue + (offsets[1] ?? 0));
  const lightHue = wrap01(rootHue + (offsets[0] ?? 0) * 0.5);

  const bgVal = rng.range(template.paletteBgVal.min, template.paletteBgVal.max);
  const bgSat = scheme === 'monochrome' ? rng.range(0.2, 0.5) : rng.range(0.3, 0.7);

  return {
    bg: hsvToRgb(bgHue, bgSat, bgVal),
    dark: hsvToRgb(darkHue, satD, valD),
    accent: hsvToRgb(accentHue, satA, valA),
    light: hsvToRgb(lightHue, satL, valL),
  };
}

// ---------------------------------------------------------------------------
// Channel sampler
// ---------------------------------------------------------------------------

function sampleNum(rng: Rng, r: NumRange): number {
  return rng.range(r.min, r.max);
}

function sampleChannel(rng: Rng, spec: ChannelSpec): Channel {
  const base = sampleNum(rng, spec.base);
  const bindings: Binding[] = [];
  for (const b of spec.bindings) {
    const p = b.chance ?? 1;
    if (!rng.bool(p)) continue;
    const gain = sampleNum(rng, b.gain);
    const out: Binding = { feature: b.feature, gain };
    if (b.curve) out.curve = b.curve;
    bindings.push(out);
  }
  return bindings.length > 0 ? { base, bindings } : { base };
}

function sampleWaveform(rng: Rng, template: ArchetypeTemplate): WaveformConfig {
  const mode = rng.weighted(
    template.waveModes.map(w => w.mode),
    template.waveModes.map(w => w.weight),
  );
  const intensity = sampleChannel(rng, {
    base: template.waveform.intensity,
    bindings: template.waveform.intensityBindings,
  });
  return {
    mode,
    intensity,
    thickness: sampleNum(rng, template.waveform.thickness),
    scale: sampleNum(rng, template.waveform.scale),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateResult {
  config: OperatorConfig;
  seed: string;
}

/**
 * Mint a complete OperatorConfig from a seed. Deterministic: same seed always
 * yields the same config. The returned `seed` is the human-shareable code
 * (e.g. "K7Q2-9XMF") produced by `encodeSeedCode`.
 */
export function generate(seed: string | number, archetype?: Archetype): GenerateResult {
  const state = toSeedState(seed);
  const code = encodeSeedCode(state);
  const rng = new Rng(state);

  // Archetype: caller can pin one (UI "pick a flavour"), else weighted draw.
  // Equal weights by default — every archetype is a first-class look.
  const chosen: Archetype = archetype && ARCHETYPES.includes(archetype)
    ? archetype
    : rng.pick(ARCHETYPES);
  const template = ARCHETYPE_TEMPLATES[chosen];

  const useMirrorSet = rng.bool(template.mirrorSetChance) && template.mirrorSets.length > 0;
  const mirrorChannel = sampleChannel(rng, template.mirror);

  const palette = generatePalette(rng, template);

  // Derived RNG: existing shared seed codes must keep their exact look, so the
  // new fluid channels must NOT consume draws from the main rng sequence.
  const fluidRng = new Rng(hashSeed(`${code}::fluid`));
  const fluid = sampleChannel(fluidRng, template.fluid);
  const vorticity = sampleChannel(fluidRng, template.vorticity);

  const config: OperatorConfig = {
    version: 1,
    name: `${chosen[0]!.toUpperCase()}${chosen.slice(1)} ${code}`,
    seed: code,
    archetype: chosen,
    zoom: sampleChannel(rng, template.zoom),
    rotate: sampleChannel(rng, template.rotate),
    swirl: sampleChannel(rng, template.swirl),
    hueCycle: sampleChannel(rng, template.hueCycle),
    decay: sampleChannel(rng, template.decay),
    warpAmp: sampleChannel(rng, template.warpAmp),
    warpScale: sampleChannel(rng, template.warpScale),
    mirror: mirrorChannel,
    mirrorMix: sampleChannel(rng, template.mirrorMix),
    flowX: sampleChannel(rng, template.flowX),
    flowY: sampleChannel(rng, template.flowY),
    fluid,
    vorticity,
    spinFromSection: template.spinFromSection,
    waveform: sampleWaveform(rng, template),
    palette,
    bloom: sampleChannel(rng, template.bloom),
    emitterScale: sampleNum(rng, template.emitterScale),
    emitterGain: sampleNum(rng, template.emitterGain),
  };

  if (useMirrorSet) {
    const set = rng.pick(template.mirrorSets);
    // Defensive copy — configs are JSON, callers may serialize/mutate.
    config.mirrorSet = set.slice();
  }

  return { config, seed: code };
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------
//
// `mutate` lets the UI/Director nudge a config without re-generating from
// scratch (live morphing slider, "evolve" button, drift between beats). It
// perturbs numeric bases/gains by a fraction of the requested `amount`, and
// occasionally rotates the palette hue. Output is always a valid config inside
// the safety margins enforced by SAFE_RANGES.

interface SafeRange { min: number; max: number }

const SAFE_RANGES: Record<string, SafeRange> = {
  zoom: { min: -0.1, max: 0.22 },
  rotate: { min: -0.05, max: 0.05 },
  swirl: { min: -0.22, max: 0.22 },
  hueCycle: { min: -0.04, max: 0.04 },
  decay: { min: 0.82, max: 0.95 },
  warpAmp: { min: 0, max: 0.018 },
  warpScale: { min: 0.6, max: 7.5 },
  mirror: { min: 1, max: 16 },
  mirrorMix: { min: 0, max: 0.9 },
  flowX: { min: -0.009, max: 0.009 },
  flowY: { min: -0.009, max: 0.009 },
  fluid: { min: 0, max: 1 },
  vorticity: { min: 0, max: 30 },
  bloom: { min: 0, max: 1.1 },
  emitterScale: { min: 0.3, max: 2.8 },
  emitterGain: { min: 0.1, max: 2.3 },
};

function clampSafe(key: keyof typeof SAFE_RANGES, v: number): number {
  const r = SAFE_RANGES[key]!;
  return v < r.min ? r.min : v > r.max ? r.max : v;
}

function jitterNum(rng: Rng, v: number, amount: number, scale: number): number {
  // Gaussian-ish jitter scaled to `amount` and the channel's natural scale.
  return v + rng.gaussian(0, 1) * amount * scale;
}

function mutateChannel(rng: Rng, key: keyof typeof SAFE_RANGES, ch: Channel, amount: number): Channel {
  const range = SAFE_RANGES[key]!;
  const span = range.max - range.min;
  const base = clampSafe(key, jitterNum(rng, ch.base, amount, span * 0.15));
  const bindings: Binding[] | undefined = ch.bindings?.map(b => {
    // Gain jitter is proportional to the original gain (preserves sign + character).
    const gainScale = Math.max(Math.abs(b.gain), 0.001);
    const g = b.gain + rng.gaussian(0, 1) * amount * gainScale * 0.4;
    const out: Binding = { feature: b.feature, gain: g };
    if (b.curve) out.curve = b.curve;
    return out;
  });
  return bindings && bindings.length > 0 ? { base, bindings } : { base };
}

function mutatePalette(rng: Rng, p: PaletteConfig, amount: number): PaletteConfig {
  // Small global hue rotation + per-channel saturation/value jitter via HSV
  // round-trip would lose precision, so we just nudge each component directly
  // and let the renderer normalise. Keeps mutate cheap and predictable.
  const drift = rng.range(-0.08, 0.08) * amount;
  const nudge = (c: RGB): RGB => [
    clamp01(c[0] + drift * (rng.next() - 0.5) * 0.6 + rng.gaussian(0, 0.04) * amount),
    clamp01(c[1] + drift * (rng.next() - 0.5) * 0.6 + rng.gaussian(0, 0.04) * amount),
    clamp01(c[2] + drift * (rng.next() - 0.5) * 0.6 + rng.gaussian(0, 0.04) * amount),
  ];
  return { bg: nudge(p.bg), dark: nudge(p.dark), accent: nudge(p.accent), light: nudge(p.light) };
}

/**
 * Perturb a config by `amount` in [0,1]. amount=0 ≈ no-op (still re-clamps),
 * amount=1 = aggressive drift. Occasionally tweaks the palette. Always returns
 * a valid OperatorConfig (clamped inside the safety margin).
 */
export function mutate(config: OperatorConfig, amount: number, seed?: string | number): OperatorConfig {
  const a = clamp01(amount);
  // Seed defaults to the config's own seed for reproducibility, falling back
  // to time so casual UI "shake" still varies each press.
  const rng = new Rng(seed ?? config.seed ?? Date.now());
  const next = cloneConfig(config);

  next.zoom = mutateChannel(rng, 'zoom', next.zoom, a);
  next.rotate = mutateChannel(rng, 'rotate', next.rotate, a);
  next.swirl = mutateChannel(rng, 'swirl', next.swirl, a);
  next.hueCycle = mutateChannel(rng, 'hueCycle', next.hueCycle, a);
  next.decay = mutateChannel(rng, 'decay', next.decay, a);
  next.warpAmp = mutateChannel(rng, 'warpAmp', next.warpAmp, a);
  next.warpScale = mutateChannel(rng, 'warpScale', next.warpScale, a);
  next.mirror = mutateChannel(rng, 'mirror', next.mirror, a);
  next.mirrorMix = mutateChannel(rng, 'mirrorMix', next.mirrorMix, a);
  next.flowX = mutateChannel(rng, 'flowX', next.flowX, a);
  next.flowY = mutateChannel(rng, 'flowY', next.flowY, a);
  next.fluid = mutateChannel(rng, 'fluid', next.fluid, a);
  next.vorticity = mutateChannel(rng, 'vorticity', next.vorticity, a);
  next.bloom = mutateChannel(rng, 'bloom', next.bloom, a);

  // Waveform: jitter scalars, occasionally flip mode (rare; modes are characterful).
  next.waveform = {
    mode: next.waveform.mode,
    intensity: mutateChannel(rng, 'bloom', next.waveform.intensity, a), // share bloom range
    thickness: Math.max(0.0025, Math.min(0.05, next.waveform.thickness + rng.gaussian(0, 0.003) * a)),
    scale: Math.max(0.05, Math.min(0.7, next.waveform.scale + rng.gaussian(0, 0.05) * a)),
  };
  if (rng.bool(a * 0.15)) {
    const modes: WaveMode[] = ['off', 'line', 'radial', 'lissajous', 'bars'];
    next.waveform.mode = rng.pick(modes);
  }

  next.emitterScale = clampSafe('emitterScale', next.emitterScale + rng.gaussian(0, 0.2) * a);
  next.emitterGain = clampSafe('emitterGain', next.emitterGain + rng.gaussian(0, 0.2) * a);

  // Palette mutation is rarer — palette is the most identity-defining field
  // and we don't want every nudge to lose the look's colour family.
  if (next.palette && rng.bool(0.35 * a + 0.05)) {
    next.palette = mutatePalette(rng, next.palette, a);
  }

  return next;
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/** A look's portable identity is its seed code — that's what users share. */
export function encode(config: OperatorConfig): string {
  if (config.seed && /^[A-Z0-9-]+$/.test(config.seed)) return config.seed;
  // Fall back to hashing the config for the rare case it has no seed (e.g. a
  // hand-built preset). This still yields a stable, shareable code.
  const json = JSON.stringify(config);
  return encodeSeedCode(toSeedState(json));
}

/**
 * Decode a seed code back to a config. Decoding deterministically regenerates
 * via `generate()` from the encoded 32-bit state, which is what makes shared
 * codes reproduce the same look on any machine.
 */
export function decode(code: string): OperatorConfig | null {
  const state = decodeSeedCode(code);
  if (state === null) return null;
  return generate(state).config;
}

// ---------------------------------------------------------------------------
// Convenience: classic fallback (kept exported so callers can ask for "the
// canonical Eviland look" without importing two modules).
// ---------------------------------------------------------------------------

export function classic(): OperatorConfig {
  return defaultConfig();
}
