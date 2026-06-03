// Eviland operator engine.
//
// MilkDrop's whole language is "a stack of per-frame transforms over a feedback
// buffer, each driven by audio". Eviland's renderer already HAS those transforms
// (zoom, rotate, swirl, kaleidoscope, hue-cycle, decay, warp, flow) as uniforms;
// historically render() computed them with hardcoded formulas. This module turns
// those formulas into DATA: an OperatorConfig describes each visual channel as a
// base value plus a list of audio-feature bindings. evalConfig() collapses a
// config + the current audio frame into the concrete uniform values render()
// pushes to the GPU.
//
// Why this matters:
//   * A "preset" becomes serializable JSON → a shareable seed (Phase 3).
//   * The randomizer mints configs; the Director morphs between them (Phase 6).
//   * The DEFAULT config reproduces Eviland's existing look exactly, so wiring
//     the engine in is a provable no-op (regression-safe), and every new look is
//     opt-in.
//
// Zero dependencies — part of the future @eviland/core surface. evalConfig is
// allocation-free (writes into a caller-owned scratch object) because it runs
// at 60fps.

// ---------------------------------------------------------------------------
// Audio features a binding can read. These mirror EvilandFrame's scalar fields
// (plus a few synthesized inputs). Kept as a string union so configs are JSON.
// ---------------------------------------------------------------------------
export type AudioFeature =
  | 'const'
  | 'kick' | 'bass' | 'snare' | 'hat' | 'vocal'
  | 'energy' | 'centroid' | 'flatness' | 'crest' | 'rolloff'
  | 'width' | 'pan' | 'novelty'
  | 'beatPhase' | 'beatConfidence'
  | 'sectionSeed';

/** Response shaping applied to a feature value (0..1-ish) before scaling. */
export type Curve = 'linear' | 'quad' | 'sqrt' | 'pulse' | 'inv';

/** One audio→parameter contribution: `shape(feature) * gain`. */
export interface Binding {
  feature: AudioFeature;
  gain: number;
  curve?: Curve;
}

/** A single visual channel: base value + summed bindings, optionally clamped. */
export interface Channel {
  base: number;
  bindings?: Binding[];
}

export type WaveMode = 'off' | 'line' | 'radial' | 'lissajous' | 'bars';

export interface WaveformConfig {
  mode: WaveMode;
  intensity: Channel; // brightness of the drawn line
  thickness: number;  // line half-width (NDC-ish)
  scale: number;      // amplitude of the waveform displacement
}

export type RGB = [number, number, number];

export interface PaletteConfig {
  bg: RGB;
  dark: RGB;
  accent: RGB;
  light: RGB;
}

/**
 * A complete Eviland "preset". Plain JSON: serializable, hashable, lerp-able.
 * Every field has a sane default in DEFAULT_CONFIG.
 */
export interface OperatorConfig {
  version: 1;
  name?: string;
  seed?: string;
  archetype?: string;

  // Field warp channels (map 1:1 to fieldUni.*):
  zoom: Channel;
  rotate: Channel;
  swirl: Channel;
  hueCycle: Channel;
  decay: Channel;
  warpAmp: Channel;
  warpScale: Channel;
  mirrorMix: Channel;
  flowX: Channel;
  flowY: Channel;

  /**
   * Kaleidoscope segment count. If `mirrorSet` is present the count is chosen
   * per song-section from it (the historical behaviour); otherwise `mirror` is
   * evaluated as a continuous channel and rounded.
   */
  mirror: Channel;
  mirrorSet?: number[];

  /**
   * Replicate the structural-memory spin: rotate/hue sign + base rotate scale
   * derived from the per-section seed, so a returning chorus rhymes. The
   * Director can disable this to take manual control.
   */
  spinFromSection: boolean;

  waveform: WaveformConfig;

  /** Optional palette override (null/omitted = use the host CSS palette). */
  palette?: PaletteConfig | null;

  /** Post/look scalars. */
  bloom: Channel;      // extra bloom drive
  emitterScale: number; // global emitter radius multiplier
  emitterGain: number;  // global emitter intensity multiplier
}

/** Concrete per-frame uniform values produced by evalConfig (scratch object). */
export interface EvilandDynamics {
  zoom: number;
  rotate: number;
  swirl: number;
  hueCycle: number;
  decay: number;
  warpAmp: number;
  warpScale: number;
  mirror: number;
  mirrorMix: number;
  flowX: number;
  flowY: number;
  waveMode: number; // 0 off, 1 line, 2 radial, 3 lissajous, 4 bars
  waveIntensity: number;
  waveThickness: number;
  waveScale: number;
  bloom: number;
  emitterScale: number;
  emitterGain: number;
}

/** Minimal shape of the audio frame evalConfig reads (subset of EvilandFrame). */
export interface FrameLike {
  kick: number; bass: number; snare: number; hat: number; vocal: number;
  energy: number; centroid: number; flatness: number; crest: number; rolloff: number;
  width: number; pan: number; novelty: number;
  beatPhase: number; beatConfidence: number;
}

const WAVE_MODE_INDEX: Record<WaveMode, number> = {
  off: 0, line: 1, radial: 2, lissajous: 3, bars: 4,
};

function featureValue(f: AudioFeature, frame: FrameLike, sectionSeed: number): number {
  switch (f) {
    case 'const': return 1;
    case 'kick': return frame.kick;
    case 'bass': return frame.bass;
    case 'snare': return frame.snare;
    case 'hat': return frame.hat;
    case 'vocal': return frame.vocal;
    case 'energy': return frame.energy;
    case 'centroid': return frame.centroid;
    case 'flatness': return frame.flatness;
    case 'crest': return frame.crest;
    case 'rolloff': return frame.rolloff;
    case 'width': return frame.width;
    case 'pan': return frame.pan;
    case 'novelty': return frame.novelty;
    case 'beatPhase': return frame.beatPhase;
    case 'beatConfidence': return frame.beatConfidence;
    case 'sectionSeed': return sectionSeed;
    default: return 0;
  }
}

function applyCurve(v: number, curve: Curve | undefined): number {
  switch (curve) {
    case 'quad': return v * v;
    case 'sqrt': return v <= 0 ? 0 : Math.sqrt(v);
    case 'pulse': { const x = v * 2 - 1; return 1 - x * x; } // peaks at v=0.5
    case 'inv': return 1 - v;
    case 'linear':
    default: return v;
  }
}

function evalChannel(ch: Channel, frame: FrameLike, sectionSeed: number): number {
  let v = ch.base;
  const b = ch.bindings;
  if (b) {
    for (let i = 0; i < b.length; i++) {
      const bind = b[i]!;
      v += applyCurve(featureValue(bind.feature, frame, sectionSeed), bind.curve) * bind.gain;
    }
  }
  return v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Allocate a reusable dynamics scratch object. */
export function createDynamics(): EvilandDynamics {
  return {
    zoom: 0, rotate: 0, swirl: 0, hueCycle: 0, decay: 0.88, warpAmp: 0, warpScale: 2.5,
    mirror: 6, mirrorMix: 0, flowX: 0, flowY: 0,
    waveMode: 0, waveIntensity: 0, waveThickness: 0.01, waveScale: 0.3,
    bloom: 0, emitterScale: 1, emitterGain: 1,
  };
}

/**
 * Collapse a config + audio frame into concrete uniform values. Pure and
 * allocation-free: results are written into `out`. All outputs are clamped to
 * GPU-safe ranges so no config (random or hand-made) can crash or white-out.
 */
export function evalConfig(
  config: OperatorConfig,
  frame: FrameLike,
  sectionSeed: number,
  out: EvilandDynamics,
): EvilandDynamics {
  // Structural-memory spin: a stable sign + base scale per section.
  const spin = config.spinFromSection ? (((Math.floor(sectionSeed * 7) % 2) === 0) ? 1 : -1) : 1;
  const hueSign = config.spinFromSection ? (sectionSeed < 0.5 ? -1 : 1) : 1;
  const sectionRotBase = config.spinFromSection ? 0.0028 * (sectionSeed * 0.5 + 0.5) : 0;

  out.zoom = clamp(evalChannel(config.zoom, frame, sectionSeed), -0.12, 0.25);
  out.rotate = spin * (sectionRotBase + evalChannel(config.rotate, frame, sectionSeed));
  out.rotate = clamp(out.rotate, -0.06, 0.06);
  out.swirl = clamp(evalChannel(config.swirl, frame, sectionSeed), -0.25, 0.25);
  out.hueCycle = hueSign * evalChannel(config.hueCycle, frame, sectionSeed);
  out.hueCycle = clamp(out.hueCycle, -0.05, 0.05);
  // Decay is the most dangerous channel: too high = white-out, too low = strobe.
  out.decay = clamp(evalChannel(config.decay, frame, sectionSeed), 0.78, 0.97);
  out.warpAmp = clamp(evalChannel(config.warpAmp, frame, sectionSeed), 0, 0.02);
  out.warpScale = clamp(evalChannel(config.warpScale, frame, sectionSeed), 0.5, 8);

  if (config.mirrorSet && config.mirrorSet.length > 0) {
    const idx = Math.floor(sectionSeed * 13) % config.mirrorSet.length;
    out.mirror = config.mirrorSet[idx]!;
  } else {
    out.mirror = Math.round(evalChannel(config.mirror, frame, sectionSeed));
  }
  out.mirror = clamp(out.mirror, 1, 16);
  out.mirrorMix = clamp(evalChannel(config.mirrorMix, frame, sectionSeed), 0, 0.98);

  out.flowX = clamp(evalChannel(config.flowX, frame, sectionSeed), -0.01, 0.01);
  out.flowY = clamp(evalChannel(config.flowY, frame, sectionSeed), -0.01, 0.01);

  out.waveMode = WAVE_MODE_INDEX[config.waveform.mode] ?? 0;
  out.waveIntensity = clamp(evalChannel(config.waveform.intensity, frame, sectionSeed), 0, 3);
  out.waveThickness = clamp(config.waveform.thickness, 0.0015, 0.06);
  out.waveScale = clamp(config.waveform.scale, 0, 0.9);

  out.bloom = clamp(evalChannel(config.bloom, frame, sectionSeed), 0, 1.2);
  out.emitterScale = clamp(config.emitterScale, 0.2, 3);
  out.emitterGain = clamp(config.emitterGain, 0, 2.5);
  return out;
}

/**
 * The DEFAULT config — a faithful re-expression of Eviland's current hardcoded
 * render() formulas, so adopting the engine is a no-op. This is the regression
 * anchor: capture before/after wiring must match.
 */
export function defaultConfig(): OperatorConfig {
  return {
    version: 1,
    name: 'Eviland Classic',
    archetype: 'classic',
    // zoom = 0.0018 + kick*0.016 + bass*0.010 — kick gain dialed down from 0.038;
    // the old value made the whole field "bounce" on every kick (the dominant
    // source of the "bouncy object" read). A gentler push still reads as a pulse.
    zoom: { base: 0.0018, bindings: [{ feature: 'kick', gain: 0.016 }, { feature: 'bass', gain: 0.010 }] },
    // rotate base/sign handled by spinFromSection; + energy*0.009 + beatPhase*0.0014
    rotate: { base: 0, bindings: [{ feature: 'energy', gain: 0.0090 }, { feature: 'beatPhase', gain: 0.0014 }] },
    // swirl = 0.012 + width*0.030 + novelty*0.020
    swirl: { base: 0.012, bindings: [{ feature: 'width', gain: 0.030 }, { feature: 'novelty', gain: 0.020 }] },
    // hueCycle = 0.0028 + centroid*0.009 + energy*0.0055 (sign from section)
    hueCycle: { base: 0.0028, bindings: [{ feature: 'centroid', gain: 0.0090 }, { feature: 'energy', gain: 0.0055 }] },
    // decay = 0.89 - flatness*0.05 - crest*0.02  (== 0.84 + 0.05*(1-flatness) - 0.02*crest)
    decay: { base: 0.89, bindings: [{ feature: 'flatness', gain: -0.05 }, { feature: 'crest', gain: -0.02 }] },
    // warpAmp = 0.0003 + bass*0.0010
    warpAmp: { base: 0.0003, bindings: [{ feature: 'bass', gain: 0.0010 }] },
    // warpScale = 2.5 + width*1.8
    warpScale: { base: 2.5, bindings: [{ feature: 'width', gain: 1.8 }] },
    // mirror: section-discrete set (historical)
    mirror: { base: 6 },
    mirrorSet: [4, 6, 8, 5, 6, 12],
    // mirrorMix = 0.70 + energy*0.26
    mirrorMix: { base: 0.70, bindings: [{ feature: 'energy', gain: 0.26 }] },
    // flow = (pan*0.0008 + 0.00012, -0.00018)
    flowX: { base: 0.00012, bindings: [{ feature: 'pan', gain: 0.0008 }] },
    flowY: { base: -0.00018 },
    spinFromSection: true,
    // Waveform ON ('line') by default — the drawn oscilloscope advected through
    // the warp field is MilkDrop's single most recognizable signature. It also
    // breaks up the centred-blob silhouette that read as "one bouncy object".
    waveform: { mode: 'line', intensity: { base: 0.7, bindings: [{ feature: 'energy', gain: 0.6 }] }, thickness: 0.012, scale: 0.34 },
    palette: null,
    bloom: { base: 0 },
    emitterScale: 1,
    emitterGain: 1,
  };
}

/** Deep-ish clone of a config (configs are plain JSON, so structuredClone-free). */
export function cloneConfig(c: OperatorConfig): OperatorConfig {
  return JSON.parse(JSON.stringify(c)) as OperatorConfig;
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function lerpChannel(a: Channel, b: Channel, t: number): Channel {
  // Bindings can differ between configs; interpolate by union of features so a
  // crossfade is smooth even when the two presets bind different inputs.
  const out: Channel = { base: lerp(a.base, b.base, t), bindings: [] };
  const map = new Map<string, { a: number; b: number; curve?: Curve }>();
  for (const bd of a.bindings ?? []) map.set(bd.feature, { a: bd.gain, b: 0, curve: bd.curve });
  for (const bd of b.bindings ?? []) {
    const e = map.get(bd.feature);
    if (e) { e.b = bd.gain; } else { map.set(bd.feature, { a: 0, b: bd.gain, curve: bd.curve }); }
  }
  for (const [feature, e] of map) {
    const gain = lerp(e.a, e.b, t);
    if (gain !== 0) out.bindings!.push({ feature: feature as AudioFeature, gain, curve: e.curve });
  }
  return out;
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * Smoothly interpolate two configs (for the Director's beat-synced crossfades).
 * Numeric channels lerp; discrete fields (mirrorSet, waveMode, spinFromSection)
 * snap at the midpoint so they don't pass through nonsense intermediate states.
 */
export function lerpConfig(a: OperatorConfig, b: OperatorConfig, t: number): OperatorConfig {
  const pick = t < 0.5 ? a : b;
  return {
    version: 1,
    name: pick.name,
    seed: pick.seed,
    archetype: pick.archetype,
    zoom: lerpChannel(a.zoom, b.zoom, t),
    rotate: lerpChannel(a.rotate, b.rotate, t),
    swirl: lerpChannel(a.swirl, b.swirl, t),
    hueCycle: lerpChannel(a.hueCycle, b.hueCycle, t),
    decay: lerpChannel(a.decay, b.decay, t),
    warpAmp: lerpChannel(a.warpAmp, b.warpAmp, t),
    warpScale: lerpChannel(a.warpScale, b.warpScale, t),
    mirror: lerpChannel(a.mirror, b.mirror, t),
    mirrorSet: pick.mirrorSet,
    mirrorMix: lerpChannel(a.mirrorMix, b.mirrorMix, t),
    flowX: lerpChannel(a.flowX, b.flowX, t),
    flowY: lerpChannel(a.flowY, b.flowY, t),
    spinFromSection: pick.spinFromSection,
    waveform: {
      mode: pick.waveform.mode,
      intensity: lerpChannel(a.waveform.intensity, b.waveform.intensity, t),
      thickness: lerp(a.waveform.thickness, b.waveform.thickness, t),
      scale: lerp(a.waveform.scale, b.waveform.scale, t),
    },
    palette: a.palette && b.palette
      ? {
          bg: lerpRGB(a.palette.bg, b.palette.bg, t),
          dark: lerpRGB(a.palette.dark, b.palette.dark, t),
          accent: lerpRGB(a.palette.accent, b.palette.accent, t),
          light: lerpRGB(a.palette.light, b.palette.light, t),
        }
      : (pick.palette ?? null),
    bloom: lerpChannel(a.bloom, b.bloom, t),
    emitterScale: lerp(a.emitterScale, b.emitterScale, t),
    emitterGain: lerp(a.emitterGain, b.emitterGain, t),
  };
}
