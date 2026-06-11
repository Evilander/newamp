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
//
// q1..q8 read from the preset-internal q-variable scratch (see QSlot below).
// evalConfig computes q's FIRST every frame so any downstream channel can
// reference them via {feature:'q1', ...}. Q-vars are NOT allowed inside other
// q-vars (no cycles) — featureValue treats missing q's as 0 in that path.
// ---------------------------------------------------------------------------
export type AudioFeature =
  | 'const'
  | 'kick' | 'bass' | 'snare' | 'hat' | 'vocal'
  | 'energy' | 'centroid' | 'flatness' | 'crest' | 'rolloff'
  | 'width' | 'pan' | 'novelty'
  | 'beatPhase' | 'beatConfidence'
  | 'sectionSeed'
  | 'q1' | 'q2' | 'q3' | 'q4' | 'q5' | 'q6' | 'q7' | 'q8';

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

// ---------------------------------------------------------------------------
// Q-variable system (preset-internal scratch + LFOs).
//
// A QSlot is a declarative per-frame scalar named q1..q8 (max 8 slots).
// Each slot mixes three pieces: a constant `base`, an optional tempo-locked
// LFO (`rate * frame.beatPhase`), and optional audio bindings. The combined
// value can also be smoothed (EMA over previous frames) so a noisy feature
// drives a slow scalar. Channels reference q's via {feature:'q1'..'q8'}.
//
// MilkDrop's q1..q8 are a programmable register file; this is the same idea
// turned into JSON so it survives serialization. No expression language —
// that's tracked separately (plan §2 Tier C).
// ---------------------------------------------------------------------------

export type LfoShape = 'sine' | 'tri' | 'saw' | 'square';

/** A tempo-locked LFO. Phase = TAU * rate * frame.beatPhase. */
export interface QLfo {
  /** Cycles per beat. 1 = one full cycle per beat, 0.25 = one per bar (4/4). */
  rate: number;
  shape: LfoShape;
  /** Optional amplitude (default 1) so the LFO contribution is `amp * shape(phase)`. */
  amp?: number;
}

/** One programmable scalar. base + lfo + bindings, optionally smoothed. */
export interface QSlot {
  /** Optional label for introspection — not used at runtime. */
  name?: string;
  base: number;
  lfo?: QLfo;
  /**
   * EMA coefficient applied to the previous frame's value. 0 = no smoothing,
   * 0.9 = slow drift. Clamped to [0, 0.99].
   */
  smooth?: number;
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
  /** Simulated-velocity influence on dye advection (0 = off … 1 = full sim flow). */
  fluid: Channel;
  /** Fluid-sim vorticity confinement strength (0..30; higher = curlier liquid). */
  vorticity: Channel;
  /**
   * How visible the simulated dye field is in the final composite.
   * 0 (default) = byte-identical to pre-dye look (existing archetypes), 1 =
   * dye dominates the picture. The 'liquid' archetype drives this toward 1
   * so audio-reactive liquid IS the image, not just an invisible warp.
   */
  liquidMix: Channel;
  /**
   * Dye dissipation bias added to the silence-gated value from
   * dyeDissipationFromFrame. 0 = use the audio-driven value as-is.
   * Negative = drain dye faster than the silence gate; positive = let it linger.
   */
  dyeDissipation: Channel;

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

  // ── Programmable q-variables (plan §2.1). Up to 8; reference as 'q1'..'q8'.
  /** Preset-internal scratch slots evaluated FIRST each frame. */
  q?: QSlot[];

  // ── Radial warp profile (plan §2.2). Each is a small gain on `radius*radius`
  // (radius in [0..√2/2] from screen centre) so the channel's effect scales
  // with distance from `centre`. All optional, default 0 → byte-identical to
  // pre-2.2 behaviour. The shader applies `effectiveZoom = zoom + zoomRad * r²`.
  radialZoom?: Channel;
  radialRotate?: Channel;
  radialSwirl?: Channel;
  radialDecay?: Channel;

  // ── Per-channel RGB decay (plan §2.3). Biases ADDED on top of base decay.
  // Default 0 → all three channels identical (current behaviour). Letting R
  // decay slightly slower than G/B is the classic MilkDrop "everything turns
  // warm" feel. Clamped per-channel so the sum can't fall outside [0.78,0.97].
  decayR?: Channel;
  decayG?: Channel;
  decayB?: Channel;

  // ── Centre offset (plan §2.4). Replaces the hardcoded vec2(0.5) in the
  // field warp / kaleidoscope fold. Range-clamped to [0.2, 0.8] so the fold
  // axis never marches off-screen. Default centre 0.5,0.5 = current behaviour.
  centreX?: Channel;
  centreY?: Channel;

  // ── Video-echo pass (plan §2.5). One extra RGBA16F FBO between field swap
  // and bloom; alpha=0 (default) → pass skipped entirely, no FBO allocated.
  // zoom/rotate/alpha drive the echo transform; flipX/flipY (0 or 1) mirror
  // the echo sample. The MilkDrop "echo" signature in declarative form.
  echoZoom?: Channel;
  echoRotate?: Channel;
  echoAlpha?: Channel;
  echoFlipX?: Channel;
  echoFlipY?: Channel;

  /**
   * Transition meta — set by lerpConfig when the Director is mid-fade. The
   * renderer reads this to drive the field-buffer crossfade (plan §2.6):
   * <1 = transition in progress; >=1 or absent = settled. Not a channel.
   */
  _transition?: number;
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
  fluid: number;
  vorticity: number;
  /** 0..1 visibility of the dye field in the final composite. */
  liquidMix: number;
  /** Bias added to dye dissipation (final clamped to 0.6..1). */
  dyeDissipation: number;
  waveMode: number; // 0 off, 1 line, 2 radial, 3 lissajous, 4 bars
  waveIntensity: number;
  waveThickness: number;
  waveScale: number;
  bloom: number;
  emitterScale: number;
  emitterGain: number;
  // Q-variable scratch — q[i] is the value of slot q(i+1). Persists across
  // frames so smoothed slots have access to their previous value (EMA state).
  q: Float64Array;
  // Radial warp profile gains (plan §2.2). 0 = no radial effect.
  radialZoom: number;
  radialRotate: number;
  radialSwirl: number;
  radialDecay: number;
  // Per-channel RGB decay biases (plan §2.3). Final per-channel decay = clamp(decay + decayR/G/B).
  decayR: number;
  decayG: number;
  decayB: number;
  // Centre offset (plan §2.4). Default 0.5, 0.5; clamped to [0.2, 0.8].
  centreX: number;
  centreY: number;
  // Video-echo pass (plan §2.5). alpha=0 = pass skipped.
  echoZoom: number;
  echoRotate: number;
  echoAlpha: number;
  echoFlipX: number; // 0 or 1
  echoFlipY: number; // 0 or 1
  /** Crossfade progress (plan §2.6). 1 = settled, <1 = mid-transition. */
  transition: number;
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

function featureValue(
  f: AudioFeature,
  frame: FrameLike,
  sectionSeed: number,
  q: Float64Array | null,
): number {
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
    case 'q1': return q ? q[0]! : 0;
    case 'q2': return q ? q[1]! : 0;
    case 'q3': return q ? q[2]! : 0;
    case 'q4': return q ? q[3]! : 0;
    case 'q5': return q ? q[4]! : 0;
    case 'q6': return q ? q[5]! : 0;
    case 'q7': return q ? q[6]! : 0;
    case 'q8': return q ? q[7]! : 0;
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

function evalChannel(
  ch: Channel,
  frame: FrameLike,
  sectionSeed: number,
  q: Float64Array | null,
): number {
  let v = ch.base;
  const b = ch.bindings;
  if (b) {
    for (let i = 0; i < b.length; i++) {
      const bind = b[i]!;
      v += applyCurve(featureValue(bind.feature, frame, sectionSeed, q), bind.curve) * bind.gain;
    }
  }
  return v;
}

/** Optional-channel eval: missing channel resolves to `defaultBase`. */
function evalOptional(
  ch: Channel | undefined,
  frame: FrameLike,
  sectionSeed: number,
  q: Float64Array | null,
  defaultBase: number,
): number {
  if (!ch) return defaultBase;
  return evalChannel(ch, frame, sectionSeed, q);
}

const TAU = Math.PI * 2;

/** Evaluate one LFO at the current beat phase. Output in [-1, 1] before amp. */
function evalLfo(lfo: QLfo, beatPhase: number): number {
  // Phase locked to beatPhase * rate. Modulo to [0, 1) for triangle/saw/square
  // shapes; sine takes the raw angle so harmonic rates (rate > 1) still cycle.
  const phase = beatPhase * lfo.rate;
  let v: number;
  switch (lfo.shape) {
    case 'sine':
      v = Math.sin(phase * TAU);
      break;
    case 'tri': {
      const p = ((phase % 1) + 1) % 1;
      v = p < 0.5 ? p * 4 - 1 : 3 - p * 4;
      break;
    }
    case 'saw': {
      const p = ((phase % 1) + 1) % 1;
      v = p * 2 - 1;
      break;
    }
    case 'square': {
      const p = ((phase % 1) + 1) % 1;
      v = p < 0.5 ? 1 : -1;
      break;
    }
    default:
      v = 0;
  }
  return v * (lfo.amp ?? 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Allocate a reusable dynamics scratch object. */
export function createDynamics(): EvilandDynamics {
  return {
    zoom: 0, rotate: 0, swirl: 0, hueCycle: 0, decay: 0.88, warpAmp: 0, warpScale: 2.5,
    mirror: 6, mirrorMix: 0, flowX: 0, flowY: 0, fluid: 0, vorticity: 8,
    liquidMix: 0, dyeDissipation: 0,
    waveMode: 0, waveIntensity: 0, waveThickness: 0.01, waveScale: 0.3,
    bloom: 0, emitterScale: 1, emitterGain: 1,
    // Q-vars + new uniforms all default to neutral (no visual change vs pre-2.1).
    q: new Float64Array(8),
    radialZoom: 0, radialRotate: 0, radialSwirl: 0, radialDecay: 0,
    decayR: 0, decayG: 0, decayB: 0,
    centreX: 0.5, centreY: 0.5,
    echoZoom: 0, echoRotate: 0, echoAlpha: 0, echoFlipX: 0, echoFlipY: 0,
    transition: 1,
  };
}

/** Q-var safety clamp: bound to [-8, 8] so a runaway LFO can't NaN downstream. */
function clampQ(v: number): number {
  return v < -8 ? -8 : v > 8 ? 8 : v;
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
  // ── Q-VARS FIRST (plan §2.1). Computed before any channel so downstream
  // bindings with feature:'q1'..'q8' can read this frame's value. q's see
  // themselves as 0 (their previous value isn't visible — only the *smoothed*
  // tail through `smooth` carries memory). Eval order is slot index, so an
  // earlier slot's NEW value is visible to a later slot via its q-feature.
  const q = out.q;
  const qConfig = config.q;
  const slotCount = qConfig ? (qConfig.length > 8 ? 8 : qConfig.length) : 0;
  for (let i = 0; i < slotCount; i++) {
    const slot = qConfig![i]!;
    // base + LFO + bindings. Bindings see the q array up to slot i (the
    // current entry hasn't been written yet, so q[i] still holds the previous
    // frame's value — that's intentional: it lets a slot reference its own
    // prior value via 'q{i+1}' for hand-rolled feedback if desired).
    let v = slot.base;
    if (slot.lfo) v += evalLfo(slot.lfo, frame.beatPhase);
    const b = slot.bindings;
    if (b) {
      for (let j = 0; j < b.length; j++) {
        const bind = b[j]!;
        v += applyCurve(featureValue(bind.feature, frame, sectionSeed, q), bind.curve) * bind.gain;
      }
    }
    // EMA smoothing: out = smooth * prev + (1-smooth) * v.
    const smooth = slot.smooth;
    if (smooth && smooth > 0) {
      const s = smooth > 0.99 ? 0.99 : smooth;
      v = s * q[i]! + (1 - s) * v;
    }
    q[i] = clampQ(v);
  }
  // Zero the unused tail so a config that shrinks `q` doesn't leak stale slots.
  for (let i = slotCount; i < 8; i++) q[i] = 0;

  // Structural-memory spin: a stable sign + base scale per section.
  const spin = config.spinFromSection ? (((Math.floor(sectionSeed * 7) % 2) === 0) ? 1 : -1) : 1;
  const hueSign = config.spinFromSection ? (sectionSeed < 0.5 ? -1 : 1) : 1;
  const sectionRotBase = config.spinFromSection ? 0.0028 * (sectionSeed * 0.5 + 0.5) : 0;

  out.zoom = clamp(evalChannel(config.zoom, frame, sectionSeed, q), -0.12, 0.25);
  out.rotate = spin * (sectionRotBase + evalChannel(config.rotate, frame, sectionSeed, q));
  out.rotate = clamp(out.rotate, -0.06, 0.06);
  out.swirl = clamp(evalChannel(config.swirl, frame, sectionSeed, q), -0.25, 0.25);
  out.hueCycle = hueSign * evalChannel(config.hueCycle, frame, sectionSeed, q);
  out.hueCycle = clamp(out.hueCycle, -0.05, 0.05);
  // Decay is the most dangerous channel: too high = white-out, too low = strobe.
  out.decay = clamp(evalChannel(config.decay, frame, sectionSeed, q), 0.78, 0.97);
  out.warpAmp = clamp(evalChannel(config.warpAmp, frame, sectionSeed, q), 0, 0.02);
  out.warpScale = clamp(evalChannel(config.warpScale, frame, sectionSeed, q), 0.5, 8);

  if (config.mirrorSet && config.mirrorSet.length > 0) {
    const idx = Math.floor(sectionSeed * 13) % config.mirrorSet.length;
    out.mirror = config.mirrorSet[idx]!;
  } else {
    out.mirror = Math.round(evalChannel(config.mirror, frame, sectionSeed, q));
  }
  out.mirror = clamp(out.mirror, 1, 16);
  out.mirrorMix = clamp(evalChannel(config.mirrorMix, frame, sectionSeed, q), 0, 0.98);

  out.flowX = clamp(evalChannel(config.flowX, frame, sectionSeed, q), -0.01, 0.01);
  out.flowY = clamp(evalChannel(config.flowY, frame, sectionSeed, q), -0.01, 0.01);

  out.fluid = clamp(evalChannel(config.fluid, frame, sectionSeed, q), 0, 1);
  out.vorticity = clamp(evalChannel(config.vorticity, frame, sectionSeed, q), 0, 30);
  out.liquidMix = clamp(evalChannel(config.liquidMix, frame, sectionSeed, q), 0, 1);
  out.dyeDissipation = clamp(evalChannel(config.dyeDissipation, frame, sectionSeed, q), -0.4, 0.06);

  out.waveMode = WAVE_MODE_INDEX[config.waveform.mode] ?? 0;
  out.waveIntensity = clamp(evalChannel(config.waveform.intensity, frame, sectionSeed, q), 0, 3);
  out.waveThickness = clamp(config.waveform.thickness, 0.0015, 0.06);
  out.waveScale = clamp(config.waveform.scale, 0, 0.9);

  out.bloom = clamp(evalChannel(config.bloom, frame, sectionSeed, q), 0, 1.2);
  out.emitterScale = clamp(config.emitterScale, 0.2, 3);
  out.emitterGain = clamp(config.emitterGain, 0, 2.5);

  // ── Plan §2.2 radial warp profile. Gains scale `radius²` in the shader so
  // each channel's effect changes with distance from centre. Clamped to keep
  // GPU-safe even with audio-driven push. Defaults are 0 (no radial effect).
  out.radialZoom = clamp(evalOptional(config.radialZoom, frame, sectionSeed, q, 0), -0.4, 0.4);
  out.radialRotate = clamp(evalOptional(config.radialRotate, frame, sectionSeed, q, 0), -0.12, 0.12);
  out.radialSwirl = clamp(evalOptional(config.radialSwirl, frame, sectionSeed, q, 0), -0.5, 0.5);
  out.radialDecay = clamp(evalOptional(config.radialDecay, frame, sectionSeed, q, 0), -0.08, 0.08);

  // ── Plan §2.3 RGB decay biases. Each kept small so the final per-channel
  // decay (clamped in the shader) stays inside the safe 0.78..0.97 envelope.
  out.decayR = clamp(evalOptional(config.decayR, frame, sectionSeed, q, 0), -0.08, 0.08);
  out.decayG = clamp(evalOptional(config.decayG, frame, sectionSeed, q, 0), -0.08, 0.08);
  out.decayB = clamp(evalOptional(config.decayB, frame, sectionSeed, q, 0), -0.08, 0.08);

  // ── Plan §2.4 centre offset. Clamped to [0.2, 0.8] so the warp/fold axis
  // can't march off-screen (the kaleidoscope sample fold blows up at edges).
  out.centreX = clamp(evalOptional(config.centreX, frame, sectionSeed, q, 0.5), 0.2, 0.8);
  out.centreY = clamp(evalOptional(config.centreY, frame, sectionSeed, q, 0.5), 0.2, 0.8);

  // ── Plan §2.5 video-echo channels. Alpha=0 (default) signals "pass off".
  out.echoZoom = clamp(evalOptional(config.echoZoom, frame, sectionSeed, q, 0), -0.5, 0.5);
  out.echoRotate = clamp(evalOptional(config.echoRotate, frame, sectionSeed, q, 0), -0.5, 0.5);
  out.echoAlpha = clamp(evalOptional(config.echoAlpha, frame, sectionSeed, q, 0), 0, 0.9);
  out.echoFlipX = evalOptional(config.echoFlipX, frame, sectionSeed, q, 0) > 0.5 ? 1 : 0;
  out.echoFlipY = evalOptional(config.echoFlipY, frame, sectionSeed, q, 0) > 0.5 ? 1 : 0;

  // ── Plan §2.6 crossfade meta. lerpConfig stamps `_transition` on the live
  // config when the Director is mid-fade; absent or >=1 means "settled".
  const tx = config._transition;
  out.transition = typeof tx === 'number' && tx < 1 ? (tx < 0 ? 0 : tx) : 1;
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
    // fluid = 0.25 + energy*0.20 — gentle sim influence that swells with the mix
    fluid: { base: 0.25, bindings: [{ feature: 'energy', gain: 0.20 }] },
    // vorticity confinement strength (how curly the simulated liquid stays)
    vorticity: { base: 8 },
    // liquidMix = 0 for the Classic look — preserves the pre-dye composite
    // byte-for-byte. Other archetypes (the 'liquid' one in the randomizer) set
    // this high so the dye field becomes the picture.
    liquidMix: { base: 0 },
    // dyeDissipation bias 0 → use the silence-gated value as-is.
    dyeDissipation: { base: 0 },
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

/** Deep clone of a config. Uses structuredClone (Node 17+ / all targeted
 *  browsers) — JSON.parse(JSON.stringify(...)) is ~3× slower and was a
 *  per-frame hotspot on the Director's crossfade path. Configs are plain JSON,
 *  so structuredClone preserves them exactly. */
export function cloneConfig(c: OperatorConfig): OperatorConfig {
  return structuredClone(c);
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

// Scratch reused by lerpChannelInto to avoid a Map alloc per channel per call
// (30 channels × 60 fps = 1.8k transient Maps/sec during the fade path).
const lerpChannelScratch = new Map<string, { a: number; b: number; curve?: Curve }>();

/** lerpChannel variant that writes into a caller-owned Channel object,
 *  reusing its `bindings` array. The scratch Map above is cleared per use.
 *  Output values are identical to lerpChannel; this is purely a GC fix. */
function lerpChannelInto(out: Channel, a: Channel, b: Channel, t: number): void {
  out.base = lerp(a.base, b.base, t);
  if (!out.bindings) out.bindings = [];
  else out.bindings.length = 0;
  lerpChannelScratch.clear();
  for (const bd of a.bindings ?? []) lerpChannelScratch.set(bd.feature, { a: bd.gain, b: 0, curve: bd.curve });
  for (const bd of b.bindings ?? []) {
    const e = lerpChannelScratch.get(bd.feature);
    if (e) { e.b = bd.gain; } else { lerpChannelScratch.set(bd.feature, { a: 0, b: bd.gain, curve: bd.curve }); }
  }
  for (const [feature, e] of lerpChannelScratch) {
    const gain = lerp(e.a, e.b, t);
    if (gain !== 0) out.bindings.push({ feature: feature as AudioFeature, gain, curve: e.curve });
  }
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Interpolate an optional Channel; missing inputs treated as {base: defaultBase}. */
function lerpOptional(
  a: Channel | undefined,
  b: Channel | undefined,
  t: number,
  defaultBase: number,
): Channel | undefined {
  if (!a && !b) return undefined;
  const aa: Channel = a ?? { base: defaultBase };
  const bb: Channel = b ?? { base: defaultBase };
  return lerpChannel(aa, bb, t);
}

/**
 * Smoothly interpolate two configs (for the Director's beat-synced crossfades).
 * Numeric channels lerp; discrete fields (mirrorSet, waveMode, spinFromSection)
 * snap at the midpoint so they don't pass through nonsense intermediate states.
 *
 * Does NOT stamp `_transition`: the Director sets that ONLY for real section
 * fades. Intra-section drift uses lerpConfig too and must not trigger the
 * field-buffer crossfade (plan §2.6).
 */
export function lerpConfig(a: OperatorConfig, b: OperatorConfig, t: number): OperatorConfig {
  const pick = t < 0.5 ? a : b;
  const out: OperatorConfig = {
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
    fluid: lerpChannel(a.fluid, b.fluid, t),
    vorticity: lerpChannel(a.vorticity, b.vorticity, t),
    liquidMix: lerpChannel(a.liquidMix, b.liquidMix, t),
    dyeDissipation: lerpChannel(a.dyeDissipation, b.dyeDissipation, t),
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
    // Q-vars: discrete (LFO shapes, bindings vary too much for safe lerp);
    // snap at the midpoint like mirrorSet. cloneConfig keeps the deep copy
    // honest so a downstream mutation can't leak back into the source config.
    q: pick.q ? pick.q.map((s) => ({ ...s, bindings: s.bindings ? s.bindings.map((b2) => ({ ...b2 })) : undefined, lfo: s.lfo ? { ...s.lfo } : undefined })) : undefined,
    // New optional Channels lerp through evalOptional defaults so a config
    // that only sets one side still crossfades cleanly to neutral.
    radialZoom: lerpOptional(a.radialZoom, b.radialZoom, t, 0),
    radialRotate: lerpOptional(a.radialRotate, b.radialRotate, t, 0),
    radialSwirl: lerpOptional(a.radialSwirl, b.radialSwirl, t, 0),
    radialDecay: lerpOptional(a.radialDecay, b.radialDecay, t, 0),
    decayR: lerpOptional(a.decayR, b.decayR, t, 0),
    decayG: lerpOptional(a.decayG, b.decayG, t, 0),
    decayB: lerpOptional(a.decayB, b.decayB, t, 0),
    centreX: lerpOptional(a.centreX, b.centreX, t, 0.5),
    centreY: lerpOptional(a.centreY, b.centreY, t, 0.5),
    echoZoom: lerpOptional(a.echoZoom, b.echoZoom, t, 0),
    echoRotate: lerpOptional(a.echoRotate, b.echoRotate, t, 0),
    echoAlpha: lerpOptional(a.echoAlpha, b.echoAlpha, t, 0),
    echoFlipX: lerpOptional(a.echoFlipX, b.echoFlipX, t, 0),
    echoFlipY: lerpOptional(a.echoFlipY, b.echoFlipY, t, 0),
  };
  return out;
}

/**
 * Allocation-light variant of lerpConfig for the Director's per-frame fade
 * path. Writes into a caller-owned `out` config, reusing its channel objects
 * (and their `bindings` arrays) instead of minting ~30 fresh Channel objects
 * + a transient Map per channel per frame.
 *
 * Output values are byte-identical to `lerpConfig(a, b, t)`.
 *
 * Contract: `out` is a "scratch" config that callers must NOT hold past the
 * next lerpConfigInto call on the same `out`. The Director's `live = scratch`
 * assignment is safe because the renderer reads `live` synchronously within
 * the same frame and `from = cloneConfig(live)` (in startFade) takes a deep
 * copy — neither pattern aliases `out` past the call.
 *
 * The drift path keeps using `lerpConfig` (allocating) because driftCache is
 * read across frames; reuse there would alias the live config.
 */
function lerpOptionalInto(
  out: OperatorConfig,
  key:
    | 'radialZoom' | 'radialRotate' | 'radialSwirl' | 'radialDecay'
    | 'decayR' | 'decayG' | 'decayB'
    | 'centreX' | 'centreY'
    | 'echoZoom' | 'echoRotate' | 'echoAlpha' | 'echoFlipX' | 'echoFlipY',
  a: Channel | undefined,
  b: Channel | undefined,
  t: number,
  defaultBase: number,
): void {
  if (!a && !b) {
    // Match lerpOptional: result is undefined when neither side sets the
    // channel. Delete so consumers see "missing" and use the eval default.
    if (out[key] !== undefined) out[key] = undefined;
    return;
  }
  const aa: Channel = a ?? { base: defaultBase };
  const bb: Channel = b ?? { base: defaultBase };
  let slot = out[key];
  if (!slot) {
    slot = { base: 0, bindings: [] };
    out[key] = slot;
  }
  lerpChannelInto(slot, aa, bb, t);
}

/** Ensure `out.palette` is a privately-owned object whose arrays this module
 *  can mutate without aliasing any caller-supplied palette. Idempotent after
 *  the first ownership-establishing call (an internal Set tracks the set of
 *  palette objects we minted here). */
const ownedPalettes = new WeakSet<object>();
function ensureOwnedPalette(out: OperatorConfig): void {
  if (out.palette && ownedPalettes.has(out.palette)) return;
  const p = { bg: [0, 0, 0] as [number, number, number],
              dark: [0, 0, 0] as [number, number, number],
              accent: [0, 0, 0] as [number, number, number],
              light: [0, 0, 0] as [number, number, number] };
  ownedPalettes.add(p);
  out.palette = p;
}

export function lerpConfigInto(
  out: OperatorConfig,
  a: OperatorConfig,
  b: OperatorConfig,
  t: number,
): void {
  const pick = t < 0.5 ? a : b;
  out.version = 1;
  out.name = pick.name;
  out.seed = pick.seed;
  out.archetype = pick.archetype;
  // Required channels — reuse out's channel slots + bindings arrays.
  lerpChannelInto(out.zoom, a.zoom, b.zoom, t);
  lerpChannelInto(out.rotate, a.rotate, b.rotate, t);
  lerpChannelInto(out.swirl, a.swirl, b.swirl, t);
  lerpChannelInto(out.hueCycle, a.hueCycle, b.hueCycle, t);
  lerpChannelInto(out.decay, a.decay, b.decay, t);
  lerpChannelInto(out.warpAmp, a.warpAmp, b.warpAmp, t);
  lerpChannelInto(out.warpScale, a.warpScale, b.warpScale, t);
  lerpChannelInto(out.mirror, a.mirror, b.mirror, t);
  out.mirrorSet = pick.mirrorSet;
  lerpChannelInto(out.mirrorMix, a.mirrorMix, b.mirrorMix, t);
  lerpChannelInto(out.flowX, a.flowX, b.flowX, t);
  lerpChannelInto(out.flowY, a.flowY, b.flowY, t);
  lerpChannelInto(out.fluid, a.fluid, b.fluid, t);
  lerpChannelInto(out.vorticity, a.vorticity, b.vorticity, t);
  lerpChannelInto(out.liquidMix, a.liquidMix, b.liquidMix, t);
  lerpChannelInto(out.dyeDissipation, a.dyeDissipation, b.dyeDissipation, t);
  out.spinFromSection = pick.spinFromSection;
  // Waveform: in-place mutate the existing object.
  out.waveform.mode = pick.waveform.mode;
  lerpChannelInto(out.waveform.intensity, a.waveform.intensity, b.waveform.intensity, t);
  out.waveform.thickness = lerp(a.waveform.thickness, b.waveform.thickness, t);
  out.waveform.scale = lerp(a.waveform.scale, b.waveform.scale, t);
  // Palette: reuse out.palette's arrays when both sides have a palette;
  // otherwise fall back to pick.palette (the same semantic as lerpConfig).
  // Palette: keep a privately-owned palette object on `out` so future calls
  // can mutate its arrays in place without disturbing the input palettes
  // (`a.palette`, `b.palette`, or `pick.palette`).
  //
  // The earlier draft fell back to `out.palette = pick.palette` when only one
  // side had a palette — which aliased an INPUT palette onto `out`. The next
  // call would then mutate THAT object via `out.palette.bg[0] = lerp(...)`,
  // silently corrupting any reference (e.g. a Director-stashed section recall
  // snapshot) that still pointed at it. The director test's section-recall
  // assertion catches that. We always copy into `out`'s owned arrays instead.
  ensureOwnedPalette(out);
  const opal = out.palette!;
  if (a.palette && b.palette) {
    opal.bg[0] = lerp(a.palette.bg[0], b.palette.bg[0], t);
    opal.bg[1] = lerp(a.palette.bg[1], b.palette.bg[1], t);
    opal.bg[2] = lerp(a.palette.bg[2], b.palette.bg[2], t);
    opal.dark[0] = lerp(a.palette.dark[0], b.palette.dark[0], t);
    opal.dark[1] = lerp(a.palette.dark[1], b.palette.dark[1], t);
    opal.dark[2] = lerp(a.palette.dark[2], b.palette.dark[2], t);
    opal.accent[0] = lerp(a.palette.accent[0], b.palette.accent[0], t);
    opal.accent[1] = lerp(a.palette.accent[1], b.palette.accent[1], t);
    opal.accent[2] = lerp(a.palette.accent[2], b.palette.accent[2], t);
    opal.light[0] = lerp(a.palette.light[0], b.palette.light[0], t);
    opal.light[1] = lerp(a.palette.light[1], b.palette.light[1], t);
    opal.light[2] = lerp(a.palette.light[2], b.palette.light[2], t);
  } else if (pick.palette) {
    // Snap-pick semantics, but COPY values (not the reference) so out.palette
    // remains independent of pick.palette.
    opal.bg[0] = pick.palette.bg[0];
    opal.bg[1] = pick.palette.bg[1];
    opal.bg[2] = pick.palette.bg[2];
    opal.dark[0] = pick.palette.dark[0];
    opal.dark[1] = pick.palette.dark[1];
    opal.dark[2] = pick.palette.dark[2];
    opal.accent[0] = pick.palette.accent[0];
    opal.accent[1] = pick.palette.accent[1];
    opal.accent[2] = pick.palette.accent[2];
    opal.light[0] = pick.palette.light[0];
    opal.light[1] = pick.palette.light[1];
    opal.light[2] = pick.palette.light[2];
  } else {
    // Neither side has a palette — match lerpConfig's `pick.palette ?? null`.
    out.palette = null;
  }
  lerpChannelInto(out.bloom, a.bloom, b.bloom, t);
  out.emitterScale = lerp(a.emitterScale, b.emitterScale, t);
  out.emitterGain = lerp(a.emitterGain, b.emitterGain, t);
  // Q-vars snap to pick at midpoint, same as lerpConfig. Deep clone — they're
  // small (≤8) and shape variation across configs makes in-place reuse fragile.
  out.q = pick.q
    ? pick.q.map((s) => ({
        ...s,
        bindings: s.bindings ? s.bindings.map((b2) => ({ ...b2 })) : undefined,
        lfo: s.lfo ? { ...s.lfo } : undefined,
      }))
    : undefined;
  // Optional channels — present-on-either-side lerp; absent-on-both clears.
  lerpOptionalInto(out, 'radialZoom', a.radialZoom, b.radialZoom, t, 0);
  lerpOptionalInto(out, 'radialRotate', a.radialRotate, b.radialRotate, t, 0);
  lerpOptionalInto(out, 'radialSwirl', a.radialSwirl, b.radialSwirl, t, 0);
  lerpOptionalInto(out, 'radialDecay', a.radialDecay, b.radialDecay, t, 0);
  lerpOptionalInto(out, 'decayR', a.decayR, b.decayR, t, 0);
  lerpOptionalInto(out, 'decayG', a.decayG, b.decayG, t, 0);
  lerpOptionalInto(out, 'decayB', a.decayB, b.decayB, t, 0);
  lerpOptionalInto(out, 'centreX', a.centreX, b.centreX, t, 0.5);
  lerpOptionalInto(out, 'centreY', a.centreY, b.centreY, t, 0.5);
  lerpOptionalInto(out, 'echoZoom', a.echoZoom, b.echoZoom, t, 0);
  lerpOptionalInto(out, 'echoRotate', a.echoRotate, b.echoRotate, t, 0);
  lerpOptionalInto(out, 'echoAlpha', a.echoAlpha, b.echoAlpha, t, 0);
  lerpOptionalInto(out, 'echoFlipX', a.echoFlipX, b.echoFlipX, t, 0);
  lerpOptionalInto(out, 'echoFlipY', a.echoFlipY, b.echoFlipY, t, 0);
  // Director stamps _transition AFTER this call on the fade path; leave it
  // untouched here to match lerpConfig's behavior (verified by the operators
  // test: lerpConfig must not stamp _transition itself).
}
