// Eviland song score — whole-track analysis, done before the track is heard.
//
// Every real-time visualizer is causal: it learns about a drop a few
// milliseconds AFTER it happens, picks a look for a chorus from what the verse
// sounded like, and has no idea the song is about to end. A player that owns
// the file doesn't have to work that way. This module reads the whole track
// once and writes down what a lighting designer would want on a cue sheet:
//
//   - the beat grid and where the bar lines fall
//   - where the sections are, and which sections repeat each other
//   - how intense each section is relative to the rest of THIS song, so the
//     loudest chorus is the climax because it is the loudest, not because it
//     crossed a fixed threshold
//   - the lead-ins: builds, risers, and the held beat of silence before a drop
//   - the key of each section relative to the song's home key
//
// The conductor (eviland-conductor.ts) turns a score plus the playback
// position into per-frame cues, and the Director and renderers act on those
// cues ahead of time instead of reacting after the fact.
//
// Pure math over mono PCM: no I/O, no DOM, no imports — it runs unchanged in
// the Electron main process (where ffmpeg hands it the decoded track), in a
// browser, and in the node test. Deterministic for a given input.

export const SONG_SCORE_VERSION = 1;
/** The rate callers must decode to. 22.05 kHz keeps every feature used here. */
export const SONG_SCORE_SAMPLE_RATE = 22050;
/** Longer tracks are scored up to here; the conductor goes quiet past the end. */
export const SONG_SCORE_MAX_SECONDS = 20 * 60;

export type ScoreTier = 'calm' | 'steady' | 'lift' | 'drop' | 'climax';

export interface ScoreKey {
  /** Pitch class of the tonic, 0 = C … 11 = B. */
  tonic: number;
  minor: boolean;
  /** 0..1 — how clearly this key beats the unrelated alternatives. */
  confidence: number;
}

/** The lead-in to a section: what the music does just before it arrives. */
export interface ScoreBuild {
  /** How long before the section start the build can be felt, in seconds. */
  seconds: number;
  /** 0..1 — size of the step up the section makes when it lands. */
  strength: number;
  /** Seconds of near-silence immediately before the section (0 = none). */
  gapSeconds: number;
}

export interface ScoreSection {
  start: number; // seconds
  end: number; // seconds
  /** Sections sharing a label are repeats of each other (0 = first material heard). */
  label: number;
  /** 0..1, relative to the loudest/busiest section of this track. */
  intensity: number;
  tier: ScoreTier;
  key: ScoreKey;
  /** Circle-of-fifths steps from the home key, −6..5. 0 when either key is unsure. */
  keyShift: number;
  /** 24 mel-band means, 0..1 — same shape the visual-memory plan fingerprints use. */
  fingerprint: number[];
  build: ScoreBuild | null;
}

export interface SongScore {
  v: typeof SONG_SCORE_VERSION;
  /** Seconds of audio analysed. */
  duration: number;
  bpm: number;
  /** 0..1 — below ~0.35 the grid is not worth trusting over a live estimate. */
  beatConfidence: number;
  /** Beat times in seconds. */
  beats: number[];
  /** Index (0..3) of the first beat that starts a bar; bars are assumed 4 beats. */
  downbeat: number;
  downbeatConfidence: number;
  sections: ScoreSection[];
  homeKey: ScoreKey;
  /** Loudness curve, 2 values per second, 0..1 relative to the track's loud passages. */
  energy: number[];
}

export interface ComputeScoreOptions {
  sampleRate: number;
  /**
   * Called every few milliseconds of work so a host can yield its thread. The
   * Electron main process passes a setImmediate-backed pause so IPC keeps
   * flowing while a long track is scored.
   */
  pause?: () => Promise<void>;
}

const FRAME = 2048;
const HOP = 512;
const CHROMA_FRAME = 8192;
const CHROMA_EVERY = 4; // chroma is computed on every 4th hop
const MEL_BANDS = 24;
const MEL_MIN_HZ = 30;
const MEL_MAX_HZ = 10000;
const LOW_BANDS = 4; // mel bands under ~160 Hz: the kick's territory
const MIN_BPM = 60;
const MAX_BPM = 200;
const MIN_SECTION_BEATS = 16;
const MAX_SECTIONS = 24;

export function isValidSongScore(value: unknown): value is SongScore {
  if (!value || typeof value !== 'object') return false;
  const score = value as Partial<SongScore>;
  return (
    score.v === SONG_SCORE_VERSION
    && typeof score.duration === 'number'
    && typeof score.bpm === 'number'
    && Array.isArray(score.beats)
    && Array.isArray(score.sections)
    && Array.isArray(score.energy)
    && score.sections.every((s) => s && typeof s.start === 'number' && typeof s.end === 'number' && Array.isArray(s.fingerprint))
  );
}

export async function computeSongScore(samples: Float32Array, opts: ComputeScoreOptions): Promise<SongScore | null> {
  const sampleRate = opts.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('computeSongScore requires a positive sampleRate.');
  const usable = Math.min(samples.length, Math.floor(SONG_SCORE_MAX_SECONDS * sampleRate));
  const frames = Math.floor((usable - FRAME) / HOP) + 1;
  // Under ~20 s there is no structure worth conducting.
  if (frames < Math.ceil((20 * sampleRate) / HOP)) return null;
  const fps = sampleRate / HOP;

  // ── 1. Frame features ────────────────────────────────────────────────────
  const fft = createFft(FRAME);
  const window = hann(FRAME);
  const melOfBin = melBandOfBin(sampleRate, FRAME);
  const mel = new Float32Array(frames * MEL_BANDS); // log-compressed band magnitudes
  const flux = new Float32Array(frames);
  const lowFlux = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const bandSum = new Float64Array(MEL_BANDS);
  const bandCount = new Float64Array(MEL_BANDS);
  for (let b = 0; b < melOfBin.length; b++) if (melOfBin[b]! >= 0) bandCount[melOfBin[b]!]! += 1;

  for (let t = 0; t < frames; t++) {
    const start = t * HOP;
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[start + i]!;
      energy += s * s;
      re[i] = s * window[i]!;
      im[i] = 0;
    }
    rms[t] = Math.sqrt(energy / FRAME);
    fft(re, im);
    bandSum.fill(0);
    let magTotal = 0;
    let magWeighted = 0;
    for (let b = 1; b < FRAME / 2; b++) {
      const mag = Math.hypot(re[b]!, im[b]!);
      magTotal += mag;
      magWeighted += mag * b;
      const band = melOfBin[b]!;
      if (band >= 0) bandSum[band]! += mag;
    }
    centroid[t] = magTotal > 1e-9 ? magWeighted / magTotal / (FRAME / 2) : 0;
    let f = 0;
    let lf = 0;
    for (let band = 0; band < MEL_BANDS; band++) {
      const value = Math.log1p((40 * bandSum[band]!) / Math.max(1, bandCount[band]!));
      mel[t * MEL_BANDS + band] = value;
      if (t > 0) {
        const rise = value - mel[(t - 1) * MEL_BANDS + band]!;
        if (rise > 0) {
          f += rise;
          if (band < LOW_BANDS) lf += rise;
        }
      }
    }
    flux[t] = f;
    lowFlux[t] = lf;
    if (opts.pause && t % 64 === 63) await opts.pause();
  }

  // Chroma wants frequency resolution the 2048 window can't give the bass
  // (a semitone at 110 Hz is 6.5 Hz wide), so it gets its own long window.
  const chromaFrames = Math.floor((frames - 1) / CHROMA_EVERY) + 1;
  const chroma = new Float32Array(chromaFrames * 12);
  {
    const cfft = createFft(CHROMA_FRAME);
    const cwindow = hann(CHROMA_FRAME);
    const cre = new Float32Array(CHROMA_FRAME);
    const cim = new Float32Array(CHROMA_FRAME);
    const pitchClassOfBin = chromaBinMap(sampleRate, CHROMA_FRAME);
    for (let c = 0; c < chromaFrames; c++) {
      const centre = c * CHROMA_EVERY * HOP + FRAME / 2;
      const start = centre - CHROMA_FRAME / 2;
      for (let i = 0; i < CHROMA_FRAME; i++) {
        const index = start + i;
        cre[i] = index >= 0 && index < usable ? samples[index]! * cwindow[i]! : 0;
        cim[i] = 0;
      }
      cfft(cre, cim);
      for (let b = 1; b < CHROMA_FRAME / 2; b++) {
        const pc = pitchClassOfBin[b]!;
        if (pc >= 0) chroma[c * 12 + pc]! += Math.hypot(cre[b]!, cim[b]!);
      }
      if (opts.pause && c % 8 === 7) await opts.pause();
    }
  }

  // ── 2. Beat grid ─────────────────────────────────────────────────────────
  const onset = onsetEnvelope(flux, fps);
  const period = estimateBeatPeriod(onset, fps);
  const beatFrames = trackBeats(onset, period);
  // Flux peaks on the frame where an attack first enters the window's heavy
  // middle, a little before the attack reaches the window centre.
  const attackLag = (FRAME / 2 + 0.65 * HOP) / sampleRate;
  const beats = beatFrames.map((frame) => refinePeak(onset, frame) / fps + attackLag);
  const bpm = (60 * fps) / period;
  const beatConfidence = gridConfidence(onset, beatFrames);
  if (opts.pause) await opts.pause();

  // Structure is measured on beat-length steps. When the grid is weak the
  // steps fall back to a plain half-second ruler so sections still come out.
  const gridTrusted = beatConfidence >= 0.3 && beats.length >= 32;
  const steps = gridTrusted ? beatFrames : fixedGrid(frames, Math.round(fps / 2));
  const stepCount = steps.length - 1;
  if (stepCount < MIN_SECTION_BEATS * 2) return null;

  // ── 3. Per-step features ─────────────────────────────────────────────────
  const stepMel = new Float32Array(stepCount * MEL_BANDS);
  const stepChroma = new Float32Array(stepCount * 12);
  const stepRms = new Float32Array(stepCount);
  const stepCentroid = new Float32Array(stepCount);
  const stepLow = new Float32Array(stepCount);
  const stepOnsets = new Float32Array(stepCount);
  for (let i = 0; i < stepCount; i++) {
    const a = steps[i]!;
    const b = Math.max(a + 1, steps[i + 1]!);
    let power = 0;
    for (let t = a; t < b; t++) {
      for (let band = 0; band < MEL_BANDS; band++) stepMel[i * MEL_BANDS + band]! += mel[t * MEL_BANDS + band]!;
      power += rms[t]! * rms[t]!;
      stepCentroid[i]! += centroid[t]!;
      stepOnsets[i]! += onset[t]! > 1 ? 1 : 0;
    }
    const n = b - a;
    for (let band = 0; band < MEL_BANDS; band++) stepMel[i * MEL_BANDS + band]! /= n;
    stepRms[i] = Math.sqrt(power / n);
    stepCentroid[i]! /= n;
    // The kick's weight on this step: low-band flux right around its start.
    for (let t = Math.max(0, a - 1); t <= Math.min(frames - 1, a + 2); t++) stepLow[i] = Math.max(stepLow[i]!, lowFlux[t]!);
    const ca = Math.floor(a / CHROMA_EVERY);
    const cb = Math.max(ca + 1, Math.min(chromaFrames, Math.ceil(b / CHROMA_EVERY)));
    for (let c = ca; c < cb; c++) for (let pc = 0; pc < 12; pc++) stepChroma[i * 12 + pc]! += chroma[c * 12 + pc]!;
    normalise(stepChroma, i * 12, 12);
  }

  // ── 4. Bar phase ─────────────────────────────────────────────────────────
  const { phase: downbeat, confidence: downbeatConfidence } = gridTrusted
    ? barPhase(stepLow, stepChroma, stepCount)
    : { phase: 0, confidence: 0 };
  if (opts.pause) await opts.pause();

  // ── 5. Section boundaries ────────────────────────────────────────────────
  const features = structureFeatures(stepMel, stepChroma, stepRms, stepLow, stepOnsets, stepCount);
  const kernel = Math.max(4, Math.min(16, Math.floor(stepCount / 8)));
  // Two scales: the long kernel finds verse/chorus-sized changes, the short
  // one keeps a drop visible when a riser has already changed the texture
  // just before it.
  const novelty = footeNovelty(features.smoothed, features.width, stepCount, kernel);
  const fine = footeNovelty(features.smoothed, features.width, stepCount, Math.max(4, kernel >> 1));
  let noveltyMax = 0;
  for (let i = 0; i < stepCount; i++) {
    novelty[i] = Math.max(novelty[i]!, fine[i]! * 0.85);
    noveltyMax = Math.max(noveltyMax, novelty[i]!);
  }
  if (noveltyMax > 0) for (let i = 0; i < stepCount; i++) novelty[i]! /= noveltyMax;
  if (opts.pause) await opts.pause();
  const snap = gridTrusted && downbeatConfidence >= 0.2;
  const boundaries = spaceBoundaries(
    pickBoundaries(novelty, kernel).map((step) => ({ step: snap ? snapToBar(step, downbeat, stepCount) : step, weight: novelty[step]! })),
    stepCount,
    MIN_SECTION_BEATS,
  );

  // ── 6. Describe each section ─────────────────────────────────────────────
  const stepTime = (index: number): number => {
    if (gridTrusted) return index >= beats.length ? usable / sampleRate : beats[index]!;
    return (steps[Math.min(index, steps.length - 1)]! * HOP) / sampleRate;
  };
  const count = boundaries.length - 1;
  const loudness: number[] = [];
  const density: number[] = [];
  const bright: number[] = [];
  const means: Float32Array[] = [];
  const sectionChroma: Float32Array[] = [];
  const fingerprints: number[][] = [];
  for (let k = 0; k < count; k++) {
    const a = boundaries[k]!;
    const b = boundaries[k + 1]!;
    let power = 0;
    let onsets = 0;
    let cent = 0;
    const mean = new Float32Array(features.width);
    const chromaMean = new Float32Array(12);
    const melMean = new Float32Array(MEL_BANDS);
    for (let i = a; i < b; i++) {
      power += stepRms[i]! * stepRms[i]!;
      onsets += stepOnsets[i]!;
      cent += stepCentroid[i]!;
      for (let d = 0; d < features.width; d++) mean[d]! += features.raw[i * features.width + d]!;
      for (let pc = 0; pc < 12; pc++) chromaMean[pc]! += stepChroma[i * 12 + pc]!;
      for (let band = 0; band < MEL_BANDS; band++) melMean[band]! += stepMel[i * MEL_BANDS + band]!;
    }
    const n = b - a;
    loudness.push(10 * Math.log10(power / n + 1e-10));
    density.push(onsets / n);
    bright.push(cent / n);
    normalise(mean, 0, features.width);
    means.push(mean);
    sectionChroma.push(chromaMean);
    fingerprints.push(Array.from(melMean, (v) => round3(Math.min(1, v / n / 6))));
  }

  const labels = labelSections(means);
  const intensity = sectionIntensity(loudness, density, bright);
  const tiers = sectionTiers(intensity);

  const totalChroma = new Float32Array(12);
  for (let k = 0; k < count; k++) {
    const weight = boundaries[k + 1]! - boundaries[k]!;
    for (let pc = 0; pc < 12; pc++) totalChroma[pc]! += sectionChroma[k]![pc]! * weight;
  }
  const homeKey = estimateKey(totalChroma);

  const sections: ScoreSection[] = [];
  for (let k = 0; k < count; k++) {
    const key = estimateKey(sectionChroma[k]!);
    sections.push({
      start: round3(k === 0 ? 0 : stepTime(boundaries[k]!)),
      end: round3(k === count - 1 ? usable / sampleRate : stepTime(boundaries[k + 1]!)),
      label: labels[k]!,
      intensity: round3(intensity[k]!),
      tier: tiers[k]!,
      key,
      keyShift: keyShiftBetween(homeKey, key),
      fingerprint: fingerprints[k]!,
      build: k === 0 ? null : describeBuild(boundaries[k]!, boundaries[k - 1]!, stepRms, stepCentroid, stepOnsets, intensity[k]! - intensity[k - 1]!, stepTime),
    });
  }

  return {
    v: SONG_SCORE_VERSION,
    duration: round3(usable / sampleRate),
    bpm: round3(bpm),
    beatConfidence: round3(beatConfidence),
    beats: beats.map(round3),
    downbeat,
    downbeatConfidence: round3(downbeatConfidence),
    sections,
    homeKey,
    energy: energyCurve(rms, fps),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Beat tracking — onset envelope → tempo → dynamic-programming beat placement
// (Ellis, "Beat Tracking by Dynamic Programming", 2007).
// ───────────────────────────────────────────────────────────────────────────

/** Spectral flux with its slow trend removed, half-wave rectified, unit variance. */
function onsetEnvelope(flux: Float32Array, fps: number): Float32Array {
  const n = flux.length;
  const out = new Float32Array(n);
  const half = Math.max(1, Math.round(fps * 0.5));
  let sum = 0;
  let left = 0;
  let right = -1;
  for (let t = 0; t < n; t++) {
    const wantRight = Math.min(n - 1, t + half);
    const wantLeft = Math.max(0, t - half);
    while (right < wantRight) sum += flux[++right]!;
    while (left < wantLeft) sum -= flux[left++]!;
    out[t] = Math.max(0, flux[t]! - sum / (right - left + 1));
  }
  let sq = 0;
  for (let t = 0; t < n; t++) sq += out[t]! * out[t]!;
  const std = Math.sqrt(sq / n) || 1;
  for (let t = 0; t < n; t++) out[t]! /= std;
  return out;
}

/** Beat period in frames (fractional). Autocorrelation under a log-normal tempo prior centred on 120 BPM. */
function estimateBeatPeriod(onset: Float32Array, fps: number): number {
  const minLag = Math.floor((60 * fps) / MAX_BPM);
  const maxLag = Math.ceil((60 * fps) / MIN_BPM);
  const ac = new Float64Array(maxLag * 4 + 2);
  const n = onset.length;
  for (let lag = 1; lag < ac.length; lag++) {
    let sum = 0;
    for (let t = 0; t + lag < n; t++) sum += onset[t]! * onset[t + lag]!;
    ac[lag] = sum / Math.max(1, n - lag);
  }
  let bestLag = minLag;
  let bestScore = -Infinity;
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.8) ** 2);
    // A true beat period also correlates at its multiples; a half-period
    // (double tempo) mostly doesn't at odd multiples.
    const score = prior * (ac[lag]! + 0.5 * ac[lag * 2]! + 0.33 * ac[lag * 3]! + 0.25 * ac[lag * 4]!);
    scores[lag] = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // Parabolic interpolation: integer lags are ±2.5 % apart at 120 BPM.
  const a = scores[bestLag - 1] ?? 0;
  const b = scores[bestLag]!;
  const c = scores[bestLag + 1] ?? 0;
  const denom = a - 2 * b + c;
  const offset = bestLag > minLag && bestLag < maxLag && Math.abs(denom) > 1e-12 ? (0.5 * (a - c)) / denom : 0;
  return bestLag + Math.max(-0.5, Math.min(0.5, offset));
}

/** Frame indices of beats: the path that best trades onset strength against steady spacing. */
function trackBeats(onset: Float32Array, period: number): number[] {
  const n = onset.length;
  const tightness = 100;
  const cum = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bestPrev = -1;
    for (let gap = lo; gap <= hi; gap++) {
      const prev = t - gap;
      if (prev < 0) break;
      const penalty = Math.log(gap / period);
      const score = cum[prev]! - tightness * penalty * penalty;
      if (score > best) {
        best = score;
        bestPrev = prev;
      }
    }
    // Before the first onset nothing has scored yet; start paths from zero.
    cum[t] = onset[t]! + (best > 0 ? best : 0);
    back[t] = best > 0 ? bestPrev : -1;
  }
  // The path ends at the strongest cumulative score within the last period.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (cum[t]! > cum[end]!) end = t;
  const path: number[] = [];
  for (let t = end; t >= 0; t = back[t]!) {
    path.push(t);
    if (back[t]! < 0) break;
  }
  path.reverse();
  // Carry the grid at the detected period through the unscored lead-in and tail.
  const first = path[0] ?? 0;
  const lead: number[] = [];
  for (let t = first - period; t >= 0; t -= period) lead.push(Math.round(t));
  lead.reverse();
  const out = [...lead, ...path];
  for (let t = (out[out.length - 1] ?? 0) + period; t < n; t += period) out.push(Math.round(t));
  return out;
}

/** Sub-frame beat position: parabola through the onset peak nearest the grid point. */
function refinePeak(onset: Float32Array, frame: number): number {
  let peak = frame;
  for (let t = Math.max(1, frame - 1); t <= Math.min(onset.length - 2, frame + 1); t++) if (onset[t]! > onset[peak]!) peak = t;
  if (peak < 1 || peak > onset.length - 2) return frame;
  const a = onset[peak - 1]!;
  const b = onset[peak]!;
  const c = onset[peak + 1]!;
  const denom = a - 2 * b + c;
  if (b <= 0.5 || Math.abs(denom) < 1e-9) return frame;
  return peak + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
}

/** How much more onset energy sits on the grid than off it, squashed to 0..1. */
function gridConfidence(onset: Float32Array, beatFrames: number[]): number {
  if (beatFrames.length < 8) return 0;
  let on = 0;
  for (const frame of beatFrames) {
    let best = 0;
    for (let t = Math.max(0, frame - 1); t <= Math.min(onset.length - 1, frame + 1); t++) best = Math.max(best, onset[t]!);
    on += best;
  }
  let total = 0;
  for (let t = 0; t < onset.length; t++) total += onset[t]!;
  const ratio = on / beatFrames.length / Math.max(1e-6, total / onset.length);
  return Math.max(0, Math.min(1, (ratio - 1.5) / 5));
}

function fixedGrid(frames: number, stride: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < frames; t += stride) out.push(t);
  return out;
}

/** Which of the four beat positions carries the bar: kick weight plus harmonic change. */
function barPhase(stepLow: Float32Array, stepChroma: Float32Array, count: number): { phase: number; confidence: number } {
  const weight = [0, 0, 0, 0];
  let lowMean = 0;
  for (let i = 0; i < count; i++) lowMean += stepLow[i]!;
  lowMean = lowMean / count || 1;
  for (let i = 1; i < count; i++) {
    let dot = 0;
    for (let pc = 0; pc < 12; pc++) dot += stepChroma[i * 12 + pc]! * stepChroma[(i - 1) * 12 + pc]!;
    weight[i % 4]! += stepLow[i]! / lowMean + 2 * (1 - dot);
  }
  let phase = 0;
  for (let p = 1; p < 4; p++) if (weight[p]! > weight[phase]!) phase = p;
  const others = (weight[0]! + weight[1]! + weight[2]! + weight[3]! - weight[phase]!) / 3;
  return { phase, confidence: Math.max(0, Math.min(1, ((weight[phase]! - others) / Math.max(1e-6, weight[phase]!)) * 3)) };
}

// ───────────────────────────────────────────────────────────────────────────
// Structure — self-similarity novelty (Foote 2000), then repeats by section mean.
// ───────────────────────────────────────────────────────────────────────────

interface StructureFeatures {
  width: number;
  /**
   * Per step: unit-length z-scored mel (timbre) ++ chroma (harmony) ++ three
   * z-scored scalars the unit-length parts can't carry — level, kick weight
   * and onset density. A riser into a drop barely changes timbre (bright noise
   * into bright drums); the level and the kick are what change.
   */
  raw: Float32Array;
  /** `raw` averaged over ±2 steps — beat-level detail blurred out. */
  smoothed: Float32Array;
}

function structureFeatures(
  stepMel: Float32Array,
  stepChroma: Float32Array,
  stepRms: Float32Array,
  stepLow: Float32Array,
  stepOnsets: Float32Array,
  count: number,
): StructureFeatures {
  const width = MEL_BANDS + 12 + 3;
  const raw = new Float32Array(count * width);
  for (let band = 0; band < MEL_BANDS; band++) {
    let mean = 0;
    for (let i = 0; i < count; i++) mean += stepMel[i * MEL_BANDS + band]!;
    mean /= count;
    let variance = 0;
    for (let i = 0; i < count; i++) variance += (stepMel[i * MEL_BANDS + band]! - mean) ** 2;
    const std = Math.sqrt(variance / count) || 1;
    for (let i = 0; i < count; i++) raw[i * width + band] = (stepMel[i * MEL_BANDS + band]! - mean) / std;
  }
  const level = zScores(Float32Array.from(stepRms, (v) => 10 * Math.log10(v * v + 1e-10)));
  const low = zScores(stepLow);
  const density = zScores(stepOnsets);
  for (let i = 0; i < count; i++) {
    normalise(raw, i * width, MEL_BANDS);
    // Chroma is already unit length per step; weight it a little under timbre.
    for (let pc = 0; pc < 12; pc++) raw[i * width + MEL_BANDS + pc] = stepChroma[i * 12 + pc]! * 0.8;
    raw[i * width + MEL_BANDS + 12] = clampZ(level[i]!) * 0.5;
    raw[i * width + MEL_BANDS + 13] = clampZ(low[i]!) * 0.35;
    raw[i * width + MEL_BANDS + 14] = clampZ(density[i]!) * 0.3;
  }
  const smoothed = new Float32Array(count * width);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 2);
    const b = Math.min(count - 1, i + 2);
    for (let j = a; j <= b; j++) for (let d = 0; d < width; d++) smoothed[i * width + d]! += raw[j * width + d]!;
    for (let d = 0; d < width; d++) smoothed[i * width + d]! /= b - a + 1;
  }
  return { width, raw, smoothed };
}

function zScores(values: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < values.length; i++) mean += values[i]!;
  mean /= values.length || 1;
  let variance = 0;
  for (let i = 0; i < values.length; i++) variance += (values[i]! - mean) ** 2;
  const std = Math.sqrt(variance / (values.length || 1)) || 1;
  return Float32Array.from(values, (v) => (v - mean) / std);
}

/** One outlier step (a dead-silent beat) must not dominate a distance. */
function clampZ(z: number): number {
  return Math.max(-2.5, Math.min(2.5, z));
}

/** Checkerboard-kernel novelty along the diagonal of the self-similarity matrix. */
function footeNovelty(features: Float32Array, width: number, count: number, kernel: number): Float32Array {
  const taper = new Float32Array(kernel);
  let taperSum = 0;
  for (let a = 0; a < kernel; a++) {
    taper[a] = Math.exp(-0.5 * ((a + 0.5) / (kernel * 0.5)) ** 2);
    taperSum += taper[a]!;
  }
  const novelty = new Float32Array(count);
  const before = new Float32Array(width);
  const after = new Float32Array(width);
  for (let i = kernel; i <= count - kernel; i++) {
    // The kernel is separable per side: a taper-weighted mean vector before
    // the point and one after it give every quadrant sum as a dot product.
    before.fill(0);
    after.fill(0);
    for (let a = 0; a < kernel; a++) {
      const w = taper[a]!;
      const p = (i - 1 - a) * width;
      const q = (i + a) * width;
      for (let d = 0; d < width; d++) {
        before[d]! += features[p + d]! * w;
        after[d]! += features[q + d]! * w;
      }
    }
    // Σ kernel·S over the four quadrants collapses to |before − after|².
    let distance = 0;
    for (let d = 0; d < width; d++) distance += (before[d]! - after[d]!) ** 2;
    novelty[i] = distance / (taperSum * taperSum);
  }
  return novelty;
}

function pickBoundaries(novelty: Float32Array, kernel: number): number[] {
  const count = novelty.length;
  let mean = 0;
  for (let i = 0; i < count; i++) mean += novelty[i]!;
  mean /= count;
  let variance = 0;
  for (let i = 0; i < count; i++) variance += (novelty[i]! - mean) ** 2;
  const std = Math.sqrt(variance / count);
  const reach = Math.max(2, Math.floor(kernel / 2));
  let threshold = Math.max(0.12, mean + 0.5 * std);
  for (let attempt = 0; attempt < 6; attempt++) {
    const peaks: number[] = [];
    for (let i = 1; i < count - 1; i++) {
      if (novelty[i]! < threshold) continue;
      let isPeak = true;
      for (let j = Math.max(0, i - reach); j <= Math.min(count - 1, i + reach) && isPeak; j++) {
        if (novelty[j]! > novelty[i]! || (novelty[j] === novelty[i] && j < i)) isPeak = false;
      }
      if (isPeak) peaks.push(i);
    }
    if (peaks.length <= MAX_SECTIONS - 1) return peaks;
    threshold *= 1.25;
  }
  return [];
}

function snapToBar(step: number, downbeat: number, count: number): number {
  const offset = (((step - downbeat) % 4) + 4) % 4;
  const snapped = offset <= 2 ? step - offset : step + (4 - offset);
  return Math.max(0, Math.min(count, snapped));
}

/**
 * Keep boundaries at least `min` steps apart (and from both ends). When two
 * compete, the one with more novelty wins — a riser's start must not evict the
 * drop it leads to.
 */
function spaceBoundaries(candidates: Array<{ step: number; weight: number }>, count: number, min: number): number[] {
  const kept: number[] = [];
  for (const candidate of candidates.slice().sort((a, b) => b.weight - a.weight)) {
    if (candidate.step < min || candidate.step > count - min) continue;
    if (kept.every((step) => Math.abs(step - candidate.step) >= min)) kept.push(candidate.step);
  }
  return [0, ...kept.sort((a, b) => a - b), count];
}

/** A section repeats the earliest earlier section whose mean feature vector it matches. */
function labelSections(means: Float32Array[]): number[] {
  const labels: number[] = [];
  let next = 0;
  for (let j = 0; j < means.length; j++) {
    let best = -1;
    let bestSim = 0.86;
    for (let i = 0; i < j; i++) {
      let dot = 0;
      for (let d = 0; d < means[j]!.length; d++) dot += means[i]![d]! * means[j]![d]!;
      if (dot > bestSim) {
        bestSim = dot;
        best = i;
      }
    }
    labels.push(best >= 0 ? labels[best]! : next++);
  }
  return labels;
}

/** 0..1 per section, relative to this track's own loudest, busiest, brightest section. */
function sectionIntensity(loudness: number[], density: number[], bright: number[]): number[] {
  const loudest = Math.max(...loudness);
  const busiest = Math.max(1e-6, ...density);
  const brightest = Math.max(1e-6, ...bright);
  return loudness.map((db, k) => {
    const level = Math.max(0, Math.min(1, 1 + (db - loudest) / 18));
    return Math.max(0, Math.min(1, 0.6 * level + 0.25 * (density[k]! / busiest) + 0.15 * (bright[k]! / brightest)));
  });
}

function sectionTiers(intensity: number[]): ScoreTier[] {
  // The climax is the most intense section, the LATER one on a near-tie —
  // songs save their biggest chorus for the end.
  const top = Math.max(...intensity);
  const floor = Math.min(...intensity);
  const spread = top - floor;
  let peak = 0;
  for (let k = 0; k < intensity.length; k++) if (intensity[k]! >= top - 0.02) peak = k;
  return intensity.map((value, k) => {
    const step = k === 0 ? 0 : value - intensity[k - 1]!;
    // A song with real dynamics is tiered against its own range, so its verse
    // is 'steady' whether the master is quiet or slammed. A flat song has no
    // range to speak of and falls back to the absolute level.
    const level = spread > 0.2 ? (value - floor) / spread : value * 0.7;
    if (spread > 0.2 && k === peak && intensity.length >= 3) return 'climax';
    if (level >= 0.6 && step >= 0.2) return 'drop';
    if (level < 0.25) return 'calm';
    if (level >= 0.6) return 'lift';
    return 'steady';
  });
}

/** What the last bars before a boundary do: step up in level, a rising sweep, a held silence. */
function describeBuild(
  boundary: number,
  previousBoundary: number,
  stepRms: Float32Array,
  stepCentroid: Float32Array,
  stepOnsets: Float32Array,
  intensityStep: number,
  stepTime: (index: number) => number,
): ScoreBuild | null {
  const db = (from: number, to: number): number => {
    let power = 0;
    let n = 0;
    for (let i = Math.max(0, from); i < Math.min(stepRms.length, to); i++, n++) power += stepRms[i]! * stepRms[i]!;
    return 10 * Math.log10(power / Math.max(1, n) + 1e-10);
  };
  const room = boundary - previousBoundary;

  // Held silence: the last beat or two far below the bars before them — AND
  // the section then lands at least about as loud as those bars. A verse that
  // simply trails off into a quieter passage is an ending, not a held breath,
  // and must not earn a blackout and a flash.
  let gapBeats = 0;
  const bed = db(boundary - 10, boundary - 2);
  const landing = db(boundary, boundary + 4);
  if (db(boundary - 1, boundary) < bed - 9 && landing > bed - 3) {
    gapBeats = db(boundary - 2, boundary - 1) < bed - 9 ? 2 : 1;
  }

  // Level step across the boundary, ignoring the gap itself.
  const approach = db(boundary - 8 - gapBeats, boundary - gapBeats);
  const levelStep = Math.max(0, Math.min(1, (landing - approach) / 12));

  // Riser: brightness and onset density climbing together over the last 16 beats.
  const span = Math.min(16, room - 1);
  let riser = 0;
  if (span >= 8) {
    const series: number[] = [];
    for (let i = Math.max(0, boundary - span - gapBeats); i < boundary - gapBeats; i++) series.push(stepCentroid[i]! * 4 + stepOnsets[i]! * 0.05);
    riser = Math.max(0, trendCorrelation(series));
  }

  const strength = Math.max(levelStep, Math.max(0, intensityStep) * 1.2, riser > 0.6 ? riser * 0.6 : 0);
  if (strength < 0.15 && gapBeats === 0) return null;
  const leadSteps = Math.max(4, Math.min(riser > 0.5 ? 16 : 8, Math.floor(room / 2)));
  const at = stepTime(boundary);
  return {
    seconds: round3(at - stepTime(boundary - leadSteps)),
    strength: round3(Math.min(1, Math.max(strength, gapBeats > 0 ? 0.5 : 0))),
    gapSeconds: round3(at - stepTime(boundary - gapBeats)),
  };
}

/** Pearson correlation of a series with time: +1 is a steady climb. */
function trendCorrelation(series: number[]): number {
  const n = series.length;
  if (n < 3) return 0;
  const meanX = (n - 1) / 2;
  const meanY = series.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - meanX) * (series[i]! - meanY);
    sxx += (i - meanX) ** 2;
    syy += (series[i]! - meanY) ** 2;
  }
  return sxx > 0 && syy > 1e-12 ? sxy / Math.sqrt(sxx * syy) : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Key — Krumhansl–Schmuckler profile correlation.
// ───────────────────────────────────────────────────────────────────────────

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function estimateKey(chroma: Float32Array): ScoreKey {
  const correlations: Array<{ tonic: number; minor: boolean; r: number }> = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
      const rotated = Array.from({ length: 12 }, (_, pc) => profile[(pc - tonic + 12) % 12]!);
      correlations.push({ tonic, minor, r: pearson(chroma, rotated) });
    }
  }
  correlations.sort((a, b) => b.r - a.r);
  const best = correlations[0]!;
  // A key shares all its notes with its relative, and six of seven with its
  // neighbours on the circle of fifths — those always score close behind.
  // Confidence is the margin over the best key that is genuinely elsewhere
  // (two or more fifths away); being one fifth out costs 30° of hue, not more.
  const family = fifthsPosition(best);
  const rival = correlations.find((c) => {
    const apart = Math.abs(((fifthsPosition(c) - family + 18) % 12) - 6);
    return apart >= 2;
  });
  const margin = best.r - (rival?.r ?? 0);
  return { tonic: best.tonic, minor: best.minor, confidence: round3(Math.max(0, Math.min(1, best.r > 0 ? margin * 3 : 0))) };
}

/** Position on the circle of fifths (0 = C major / A minor), relative keys sharing a position. */
function fifthsPosition(key: { tonic: number; minor: boolean }): number {
  const majorTonic = key.minor ? (key.tonic + 3) % 12 : key.tonic;
  return (majorTonic * 7) % 12;
}

function keyShiftBetween(home: ScoreKey, key: ScoreKey): number {
  // On real recordings a section estimate under ~0.6 is wrong often enough to
  // repaint a verse for no musical reason. No shift is the safe answer.
  if (home.confidence < 0.6 || key.confidence < 0.6) return 0;
  return ((fifthsPosition(key) - fifthsPosition(home) + 18) % 12) - 6;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i]!;
    meanB += b[i]!;
  }
  meanA /= n;
  meanB /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i]! - meanA) * (b[i]! - meanB);
    saa += (a[i]! - meanA) ** 2;
    sbb += (b[i]! - meanB) ** 2;
  }
  return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Small DSP helpers.
// ───────────────────────────────────────────────────────────────────────────

/** Loudness at 2 values per second, 0..1, where 1 is the track's 95th-percentile level and 0 is 30 dB under it. */
function energyCurve(rms: Float32Array, fps: number): number[] {
  const stride = fps / 2;
  const levels: number[] = [];
  for (let start = 0; start < rms.length; start += stride) {
    let power = 0;
    let n = 0;
    for (let t = Math.floor(start); t < Math.min(rms.length, Math.floor(start + stride)); t++, n++) power += rms[t]! * rms[t]!;
    levels.push(10 * Math.log10(power / Math.max(1, n) + 1e-10));
  }
  const sorted = levels.slice().sort((a, b) => a - b);
  const reference = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  return levels.map((db) => Math.round(Math.max(0, Math.min(1, 1 + (db - reference) / 30)) * 100) / 100);
}

function hann(size: number): Float32Array {
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return out;
}

/** FFT bin → mel band index (−1 outside the analysed range). */
function melBandOfBin(sampleRate: number, frame: number): Int16Array {
  const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
  const lo = hzToMel(MEL_MIN_HZ);
  const hi = hzToMel(Math.min(MEL_MAX_HZ, sampleRate / 2));
  const out = new Int16Array(frame / 2).fill(-1);
  for (let b = 1; b < frame / 2; b++) {
    const hz = (b * sampleRate) / frame;
    if (hz < MEL_MIN_HZ || hz > MEL_MAX_HZ) continue;
    out[b] = Math.min(MEL_BANDS - 1, Math.floor(((hzToMel(hz) - lo) / (hi - lo)) * MEL_BANDS));
  }
  return out;
}

/** FFT bin → pitch class for 65 Hz–2.1 kHz (C2–C7), A = 440 Hz; −1 elsewhere. */
function chromaBinMap(sampleRate: number, frame: number): Int8Array {
  const out = new Int8Array(frame / 2).fill(-1);
  for (let b = 1; b < frame / 2; b++) {
    const hz = (b * sampleRate) / frame;
    if (hz < 65 || hz > 2100) continue;
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    out[b] = ((midi % 12) + 12) % 12;
  }
  return out;
}

/** Scale `length` values starting at `offset` to unit length, in place. */
function normalise(data: Float32Array, offset: number, length: number): void {
  let sq = 0;
  for (let i = 0; i < length; i++) sq += data[offset + i]! * data[offset + i]!;
  const norm = Math.sqrt(sq);
  if (norm > 1e-9) for (let i = 0; i < length; i++) data[offset + i]! /= norm;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** In-place radix-2 FFT with its twiddles and bit-reversal table built once. */
function createFft(size: number): (re: Float32Array, im: Float32Array) => void {
  if ((size & (size - 1)) !== 0) throw new Error('FFT requires a power-of-two size.');
  const cos = new Float32Array(size / 2);
  const sin = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / size);
    sin[i] = Math.sin((-2 * Math.PI * i) / size);
  }
  const reversed = new Uint32Array(size);
  const bits = Math.log2(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  return (re, im) => {
    for (let i = 0; i < size; i++) {
      const j = reversed[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const stride = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * stride]!;
          const wi = sin[k * stride]!;
          const a = start + k;
          const b = a + half;
          const tr = wr * re[b]! - wi * im[b]!;
          const ti = wr * im[b]! + wi * re[b]!;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  };
}
