// Audio analysis behind the in-house visualizer modes (Visualizer.tsx): band
// levels, an adaptive beat detector and the reactivity curve, all on the
// analyser's byte spectrum.

import { bandEnd, logBandEdges } from './band-edges';

export type SpectrumReactivity = 'truth' | 'punch' | 'wild';

export interface AudioFeatures {
  bass: number;
  lowMid: number;
  mid: number;
  treble: number;
  rms: number;
  beat: number;
  /** Narrow-band low-frequency energy (0-140 Hz, sample-rate-aware). Read from
   * the unsmoothed onset analyser tap, so transient gates fire on the actual
   * frame a kick lands instead of ~1.3 frames late. */
  kick: number;
  /** True exactly on the frame the kick band crosses the adaptive floor. */
  beatEdge: boolean;
  bands: number[];
}

export interface AnalyzerConfig {
  sampleRate: number;
  fftSize: number;
}

// The analyser's bin width at 44.1 kHz / 2048, which the fixed bin counts
// below were tuned against.
export const DEFAULT_BIN_HZ = 44100 / 2048;

export function avg(arr: Uint8Array, from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (let i = from; i < to && i < arr.length; i++) {
    sum += arr[i]!;
    count++;
  }
  return count ? sum / count : 0;
}

interface ReactivityCurve {
  curve: number;
  gain: number;
  bassLift: number;
  lowMidLift: number;
  midLift: number;
  trebleLift: number;
}

function reactivitySettings(reactivity: SpectrumReactivity): ReactivityCurve {
  if (reactivity === 'truth') return { curve: 0.92, gain: 1.08, bassLift: 1.06, lowMidLift: 1.04, midLift: 1.03, trebleLift: 1.02 };
  if (reactivity === 'wild') return { curve: 0.52, gain: 1.58, bassLift: 1.3, lowMidLift: 1.22, midLift: 1.20, trebleLift: 1.18 };
  return { curve: 0.68, gain: 1.34, bassLift: 1.18, lowMidLift: 1.14, midLift: 1.12, trebleLift: 1.10 };
}

// Where the band-aware lift changes, in Hz (36, 120 and 280 bins at 44.1 kHz).
const LIFT_LOW_MID_HZ = 775;
const LIFT_MID_HZ = 2580;
const LIFT_TREBLE_HZ = 6030;

export function boostFrequencyData(arr: Uint8Array, reactivity: SpectrumReactivity = 'punch', binHz = DEFAULT_BIN_HZ): void {
  const settings = reactivitySettings(reactivity);
  const lowMidFrom = Math.round(LIFT_LOW_MID_HZ / binHz);
  const midFrom = Math.round(LIFT_MID_HZ / binHz);
  const trebleFrom = Math.round(LIFT_TREBLE_HZ / binHz);
  for (let i = 0; i < arr.length; i += 1) {
    const normalized = arr[i]! / 255;
    // Band-aware lift: bass still gets the biggest boost, but low-mid + mid +
    // treble now each get a meaningful lift too so the canvas modes'
    // upper-spectrum response catches up to the low-end (which has always
    // read as "more alive" by virtue of being the only band lifted).
    const lowBandLift =
      i < lowMidFrom ? settings.bassLift
      : i < midFrom ? settings.lowMidLift
      : i < trebleFrom ? settings.midLift
      : settings.trebleLift;
    const shaped = Math.pow(normalized, settings.curve) * settings.gain * lowBandLift;
    arr[i] = Math.max(0, Math.min(255, Math.round(shaped * 255)));
  }
}

export function bandValue(arr: Uint8Array, from: number, to: number): number {
  return Math.min(1, Math.pow(avg(arr, from, to) / 255, 0.72) * 1.22);
}

function waveRms(arr: Uint8Array): number {
  if (!arr.length) return 0;
  let sum = 0;
  const stride = Math.max(1, Math.floor(arr.length / 768));
  let count = 0;
  for (let i = 0; i < arr.length; i += stride) {
    const centered = (arr[i]! - 128) / 128;
    sum += centered * centered;
    count += 1;
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, count)) * 1.85);
}

function logBands(arr: Uint8Array, edges: Int32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < edges.length; i += 1) out.push(bandValue(arr, edges[i]!, bandEnd(edges, i)));
  return out;
}

const BAND_COUNT = 16;

export function createAudioFeatureAnalyzer(config: AnalyzerConfig): (freq: Uint8Array, wave: Uint8Array, onsetFreq: Uint8Array) => AudioFeatures {
  // Compute Hz-accurate bin counts so the same band labels mean the same
  // perceptual range whether the source is 44.1, 48, 96, or 192 kHz.
  // binWidth = sampleRate / fftSize. Floor + max 1 keeps a single-bin minimum
  // so high-rate sources (192k) don't collapse to zero-width bands.
  const binWidth = config.sampleRate / config.fftSize;
  const binFor = (hz: number): number => Math.max(1, Math.floor(hz / binWidth));
  const kickBins = Math.max(4, Math.ceil(140 / binWidth)); // kick drum fundamental ~50-140 Hz
  // Bin 0 is the DC offset, not bass: a source with an offset would read as a
  // constant kick. Every low band starts at bin 1.
  const bassEnd = Math.max(2, binFor(250));
  const lowMidEnd = binFor(500);
  const midEnd = binFor(2000);
  const trebleEnd = binFor(8000);
  const bandEdges = logBandEdges(config.sampleRate, config.fftSize, BAND_COUNT);

  let bassFloor = 0.08;
  let rmsFloor = 0.04;
  let kickFloor = 0.06;
  let beat = 0;
  let prevKick = 0;

  return (freq, wave, onsetFreq) => {
    const bass = bandValue(freq, 1, bassEnd);
    const lowMid = bandValue(freq, bassEnd, lowMidEnd);
    const mid = bandValue(freq, lowMidEnd, midEnd);
    const treble = bandValue(freq, midEnd, trebleEnd);
    const rms = waveRms(wave);
    // Kick band: 0-140 Hz, derived from the actual sample rate. Read from the
    // unsmoothed onset analyser so transient detection isn't lagged by the
    // visualizer's 1.3-frame smoothing window.
    const kick = Math.min(1, avg(onsetFreq, 1, kickBins + 1) / 255);

    const bassOnset = Math.max(0, bass - bassFloor * 1.12);
    const rmsOnset = Math.max(0, rms - rmsFloor * 1.08);
    const kickOnset = Math.max(0, kick - kickFloor * 1.18);
    beat = Math.max(beat * 0.5, Math.min(1, bassOnset * 5.2 + rmsOnset * 3.4 + kickOnset * 2.4));
    // True same-frame rising edge: prev frame below adaptive floor, this frame
    // above. With the unsmoothed onset analyser this fires on the exact frame
    // a kick lands instead of ~1.3 frames late.
    const beatEdge = prevKick < kickFloor * 1.18 && kick >= kickFloor * 1.18;

    prevKick = kick;

    bassFloor = bass > bassFloor
      ? bassFloor * 0.94 + bass * 0.06
      : bassFloor * 0.985 + bass * 0.015;
    rmsFloor = rms > rmsFloor
      ? rmsFloor * 0.94 + rms * 0.06
      : rmsFloor * 0.985 + rms * 0.015;
    kickFloor = kick > kickFloor
      ? kickFloor * 0.92 + kick * 0.08
      : kickFloor * 0.98 + kick * 0.02;

    return {
      bass,
      lowMid,
      mid,
      treble,
      rms,
      beat,
      kick,
      beatEdge,
      bands: logBands(freq, bandEdges),
    };
  };
}

// Lattice Strobe sizes its cells from the treble level. Re-deriving the size
// every frame re-spaces every dot at once; the divisor only moves when the
// target has left a dead band around it, and then to a whole number.
const LATTICE_DEAD_BAND = 0.75;
export const LATTICE_BASE_DIVISOR = 16;

export function settleLatticeDivisor(current: number, target: number): number {
  return Math.abs(target - current) > LATTICE_DEAD_BAND ? Math.round(target) : current;
}

// Animation phases for the GPU modes. A phase that speeds up with the music is
// the integral of that speed, advanced by the time each frame really covered.
// Multiplying the clock by the current speed instead moves the phase by the
// clock times every change in the music: harmless in the first seconds, and a
// different random phase every frame once the clock is large.
export interface PhaseClock {
  /** Seconds since the first frame this clock saw. */
  seconds: number;
  bassTime: number;
  midTime: number;
  beatTime: number;
  /** Per-band integral of AudioFeatures.bands. */
  bandTime: Float64Array;
  advance(now: number, features: Pick<AudioFeatures, 'bass' | 'mid' | 'beat' | 'bands'>): void;
}

// A pause or a stalled frame must not leap the phases forward.
const MAX_PHASE_STEP_S = 0.1;

export function createPhaseClock(): PhaseClock {
  let startedAt = -1;
  let lastAt = 0;
  const clock: PhaseClock = {
    seconds: 0,
    bassTime: 0,
    midTime: 0,
    beatTime: 0,
    bandTime: new Float64Array(BAND_COUNT),
    advance(now, features) {
      if (startedAt < 0) startedAt = now;
      const dt = lastAt ? Math.max(0, Math.min(MAX_PHASE_STEP_S, (now - lastAt) / 1000)) : 0;
      lastAt = now;
      clock.seconds = Math.max(0, (now - startedAt) / 1000);
      clock.bassTime += features.bass * dt;
      clock.midTime += features.mid * dt;
      clock.beatTime += features.beat * dt;
      for (let i = 0; i < BAND_COUNT; i += 1) clock.bandTime[i] = clock.bandTime[i]! + (features.bands[i] ?? 0) * dt;
    },
  };
  return clock;
}
