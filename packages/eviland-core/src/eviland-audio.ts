// Eviland audio reactor — the moat.
//
// Turns raw FFT bytes into a rich, causal, structure-aware feature stream so
// the renderer can fire a DISTINCT visual event for each instrument instead of
// pulsing everything on one shared bass envelope (MilkDrop's failure, and
// every other visualizer's). Four leaps over the state of the art:
//   1. 24 mel-band half-wave spectral flux → per-band adaptive-threshold onset
//      bus, grouped into semantic voices (kick/bass/snare/hat/vocal).
//   2. Spatial-truth features: per-channel stereo width + pan.
//   3. Structural memory: a self-similarity novelty curve detects section
//      boundaries, and section fingerprints let a returning chorus be
//      RECOGNISED so the visual can rhyme with its earlier appearance.
//   4. Anticipation: a kick inter-onset-interval tempo estimate yields a beat
//      phase so the renderer can lead the beat instead of chasing it.
//
// Level is measured against the track, not the meter: a running reference
// follows the loud passages, so a quiet master lights up as fully as a slammed
// one and a verse still reads as quieter than its chorus.
//
// Pure TS, zero deps, allocation-free hot path. The renderer subscribes to the
// returned frame; it never polls raw FFT.

export type VoiceGroup = 'kick' | 'bass' | 'snare' | 'hat' | 'vocal' | 'other';

export interface EvilandOnset {
  band: number; // 0..BANDS-1
  group: VoiceGroup;
  intensity: number; // 0..1 (how far over threshold)
  sharpness: number; // 0..1 (attack steepness)
}

/**
 * Look-ahead cues for one frame, stamped on by the conductor when the playing
 * track has a song score (eviland-score.ts). Everything else on the frame is
 * causal — it describes audio that has already happened. These describe what
 * the song is ABOUT to do, so the Director and renderers can prepare for it.
 */
export interface ScoreCues {
  /** 0..1 — climbs through a build toward the downbeat of the next section. */
  anticipation: number;
  /** 0..1 — the held silence right before a drop. */
  blackout: number;
  /** 0..1 — set when a built-up section lands, then decays over about a second. */
  impact: number;
  /** True only on the frame the impact starts (fire one-shot effects here). */
  impactStart: boolean;
  /** The CURRENT section's intensity tier, known from its first frame. */
  tier: 'calm' | 'steady' | 'lift' | 'drop' | 'climax';
  /** Palette hue rotation in turns (20° per fifth): how far this section's key sits from the song's home key. */
  keyShift: number;
  /** 0..1 position in the track. */
  arc: number;
  /** A bar line was crossed this frame. */
  downbeat: boolean;
  /** Seconds until the next section starts (Infinity on the last one). */
  toBoundary: number;
}

export interface EvilandFrame {
  bands: Float32Array; // BANDS smoothed band magnitudes, 0..1, level-compensated (see energy)
  onsets: EvilandOnset[]; // onsets detected THIS frame
  // Semantic voice envelopes (asymmetric attack/release), 0..1.
  kick: number;
  bass: number;
  snare: number;
  hat: number;
  vocal: number;
  /**
   * Loudness 0..1 relative to THIS track: 1 at the running reference (where
   * its loud passages sit), 0 thirty dB under it. A quiet master and a loud one
   * read the same; a verse reads under its chorus.
   */
  energy: number;
  centroid: number; // spectral centroid (brightness) 0..1
  /**
   * 0 tonal .. 1 noisy, taken on the analyser's dB-mapped band magnitudes, so
   * most music reads 0.9-1.0. The looks' decay bindings were tuned to that
   * range; the field keeps its meaning. For a measure that separates a flute
   * from a pop mix from white noise, read `noisiness`.
   */
  flatness: number;
  /** 0 pure tone .. 1 white noise: spectral flatness of linear band power on a 30 dB scale. */
  noisiness: number;
  crest: number; // peakiness 0..1
  rolloff: number; // 0..1 (85% energy frequency, normalised)
  width: number; // stereo width 0..1
  pan: number; // -1 left .. +1 right
  beatPhase: number; // 0..1, 0 = on the beat; a sawtooth re-anchored on every kick
  beatConfidence: number; // 0..1
  bpm: number;
  /**
   * The beat clock in float beats, never reset within a track. Its fraction
   * agrees with beatPhase once the clock has locked, but it carries on across
   * beat lines, so an LFO slower than one cycle per beat stays continuous when
   * run from it. Absent on frames that did not come from the reactor or the
   * conductor; consumers fall back to beatPhase.
   */
  beatClock?: number;
  novelty: number; // structural novelty this frame 0..1
  sectionId: number; // monotonically increasing section index
  sectionChanged: boolean; // a section boundary fired this frame
  sectionReturn: number; // -1 if novel, else index of the matching prior section
  /**
   * The 24-float mel-band average for the section that just ENDED, made
   * available ONLY on the frame where sectionChanged === true. Null on every
   * other frame (including frames inside a section). Allocated once per real
   * boundary (~every 10-30s) — the hot path stays allocation-free.
   *
   * Consumers: the renderer-side memory bridge fingerprints sections into the
   * persistent VisualMemoryPlan. The visualizer itself does NOT read this — it
   * already gets section identity from sectionId + sectionReturn.
   */
  sectionFingerprint: Float32Array | null;
  /**
   * Present only while a scored track is playing. When it is, sectionId /
   * sectionChanged / sectionReturn and the beat fields above come from the
   * score too (exact, and known in advance) instead of the live estimators.
   */
  score?: ScoreCues;
}

export interface EvilandReactorConfig {
  sampleRate: number;
  fftSize: number;
  binCount: number;
  /** The analyser's byte mapping limits; default to the engine's -86 / -10 dB. */
  minDecibels?: number;
  maxDecibels?: number;
}

export const EVILAND_BANDS = 24;

const MIN_HZ = 20;
const MAX_HZ = 16000;
const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1);

// These are fixed frequency-band proxies, not instrument recognition or stem
// separation. The historical ids are retained for saved presets and replays.
// Overlapping instruments can excite any of these groups.
// Inclusive [lo, hi] band ranges; kept non-overlapping so groupPeak() and
// groupForBand() classify every boundary band identically.
const GROUP_BANDS: Record<Exclude<VoiceGroup, 'other'>, [number, number]> = {
  kick: [0, 2],
  bass: [3, 5],
  snare: [6, 9],
  vocal: [10, 14],
  hat: [19, 23],
};

/** Clamp into [lo, hi]; NaN reads as 0 first, so a bad input lands on a neutral value. */
function bounded(x: number, lo: number, hi: number): number {
  if (x !== x) x = 0;
  return x < lo ? lo : x > hi ? hi : x;
}
const unit = (x: number): number => bounded(x, 0, 1);

function groupForBand(band: number): VoiceGroup {
  if (band <= 2) return 'kick';
  if (band <= 5) return 'bass';
  if (band <= 9) return 'snare';
  if (band <= 14) return 'vocal';
  if (band >= 19) return 'hat';
  return 'other';
}

// One-pole asymmetric envelope follower (fast attack / slow release is the
// single biggest "alive vs seizure" lever).
class Env {
  value = 0;
  constructor(
    private readonly tauAttackMs: number,
    private readonly tauReleaseMs: number,
  ) {}
  step(x: number, dtMs: number): number {
    // An envelope that took a NaN would keep it for good: start it over, and
    // hold it through an input or a frame time that is not a number.
    if (!Number.isFinite(this.value)) this.value = 0;
    if (!Number.isFinite(x) || !Number.isFinite(dtMs)) return this.value;
    const tau = x > this.value ? this.tauAttackMs : this.tauReleaseMs;
    const k = 1 - Math.exp(-dtMs / Math.max(1, tau));
    this.value += k * (x - this.value);
    return this.value;
  }
}

export interface EvilandReactor {
  analyze(
    freq: Uint8Array,
    onsetFreq: Uint8Array,
    leftFreq: Uint8Array,
    rightFreq: Uint8Array,
    dtMs: number,
    nowMs: number,
  ): EvilandFrame;
  /**
   * Clears tempo/phase tracking, the loudness reference and structural memory
   * (band statistics, section boundaries, fingerprints). Call this whenever
   * the track changes — without it, the previous track's statistics and
   * timestamps make the first analyze() of a new track read as a huge
   * spectral jump, very likely firing a spurious sectionChanged, and
   * fingerprints/sectionId keep accumulating across every track in the
   * session instead of starting fresh per track.
   */
  reset(): void;
}

// Where a dense modern master's loud passages sit on the analyser's power
// scale (mean bin power through the engine's -86..-10 dB byte mapping; a
// sparse mix reads 10 dB under this at the same level). The reference starts
// here, so a normal master reads right from its first bar and only an
// unusually quiet or loud one needs the reference to move.
const REF_NOMINAL_DB = -50;
// The reference never falls below this far above the analyser's floor:
// anything quieter is mostly bins the analyser cannot see.
const REF_FLOOR_ABOVE_MIN_DB = 6;
// Within this of the analyser's floor a frame is silence (a gap, a fade's
// tail): it reads as no energy and leaves the reference where it is, so a
// pause does not pull the next section up.
const SILENCE_ABOVE_MIN_DB = 2;
// A passage this far under the reference is read as the loudest part of the
// track, and anything beyond it is 0 — the same 30 dB the score's energy
// curve uses.
const ENERGY_RANGE_DB = 30;
// Fast attack so a louder passage takes over the reference within a bar; a
// long release holds it through a verse or breakdown. Until the track has
// produced a passage near the reference it is only the nominal guess, so it
// releases quickly toward the loudest level heard so far (a quiet master, a
// soft intro) and stops a little above it, leaving the first chorus room to
// read as a lift.
const REF_ATTACK_MS = 400;
const REF_RELEASE_MS = 45000;
const REF_RELEASE_FAST_MS = 4000;
const REF_FAST_GAP_DB = 6;
// A quiet master is lifted so its bands and voices fill the same range a loud
// one does: in byte units (dB-linear), capped at about 23 dB.
const BAND_LIFT_MAX = 0.3;

export function createEvilandReactor(config: EvilandReactorConfig): EvilandReactor {
  const { sampleRate, fftSize, binCount } = config;
  const binHz = sampleRate / fftSize;
  const minDb = config.minDecibels ?? -86;
  const maxDb = config.maxDecibels ?? -10;
  const dbPerUnit = maxDb - minDb;
  const silenceDb = minDb + SILENCE_ABOVE_MIN_DB;
  const refFloorDb = minDb + REF_FLOOR_ABOVE_MIN_DB;

  // Byte → linear power, once. Bytes are linear in dB, so means taken on them
  // are means of dB; loudness and flatness want power.
  const powerOfByte = new Float64Array(256);
  for (let i = 0; i < 256; i++) powerOfByte[i] = 10 ** ((minDb + (i / 255) * dbPerUnit) / 10);
  const powerFloor = powerOfByte[0]!;

  // Precompute mel band → [startBin, endBin) once.
  const edgesMel: number[] = [];
  const loMel = hzToMel(MIN_HZ);
  const hiMel = hzToMel(Math.min(MAX_HZ, sampleRate / 2));
  for (let i = 0; i <= EVILAND_BANDS; i++) {
    edgesMel.push(loMel + ((hiMel - loMel) * i) / EVILAND_BANDS);
  }
  const bandStart = new Int32Array(EVILAND_BANDS);
  const bandEnd = new Int32Array(EVILAND_BANDS);
  let binTotal = 0;
  for (let b = 0; b < EVILAND_BANDS; b++) {
    const lo = Math.max(1, Math.floor(melToHz(edgesMel[b]!) / binHz));
    const hi = Math.max(lo + 1, Math.ceil(melToHz(edgesMel[b + 1]!) / binHz));
    bandStart[b] = lo;
    bandEnd[b] = Math.min(binCount, hi);
    binTotal += Math.max(1, bandEnd[b]! - lo);
  }

  // Per-band state.
  const bandMag = new Float32Array(EVILAND_BANDS); // smoothed magnitude, as the analyser gives it
  const bandOut = new Float32Array(EVILAND_BANDS); // the same, lifted to the loudness reference
  const prevOnsetBand = new Float32Array(EVILAND_BANDS); // previous unsmoothed band for flux
  const fluxMean = new Float32Array(EVILAND_BANDS); // rolling mean of flux
  const fluxVar = new Float32Array(EVILAND_BANDS); // rolling variance of flux
  const lastOnsetAt = new Float32Array(EVILAND_BANDS); // refractory timer
  const REFRACTORY_MS = 90;
  // Rolling flux statistics over about half a second, as a time constant so
  // the onset threshold behaves the same at 30 and 60 frames per second.
  const FLUX_STATS_TAU_MS = 550;

  // Semantic envelopes.
  const kickEnv = new Env(3, 160);
  const bassEnv = new Env(10, 250);
  const snareEnv = new Env(3, 150);
  const hatEnv = new Env(2, 120);
  const vocalEnv = new Env(20, 400);
  const energyEnv = new Env(10, 220);
  const centroidEnv = new Env(50, 800);
  const flatnessEnv = new Env(60, 700);
  const noisinessEnv = new Env(60, 700);
  const crestEnv = new Env(20, 300);
  const rolloffEnv = new Env(50, 600);
  const widthEnv = new Env(100, 1500);
  const panEnv = new Env(100, 1500);

  // Loudness reference (see the constants above), a slow loudness for the
  // fade gate, and the loudest slow level heard so far this track.
  let refDb = REF_NOMINAL_DB;
  let loudSlow = minDb;
  let loudHeard = minDb;
  // The last clock reading that was a number, for a frame that arrives without one.
  let lastNowMs = 0;

  // Tempo / phase from kick inter-onset intervals. A kick excites all three
  // kick bands, usually across two frames, so one EVENT is counted per
  // kick: the first band to fire opens a window and the rest are ignored.
  const KICK_EVENT_WINDOW_MS = 120;
  const KICK_EVENT_MIN_INTENSITY = 0.15;
  // Plausible beat intervals, 40-200 BPM.
  const IOI_MIN_MS = 300;
  const IOI_MAX_MS = 1500;
  // Once locked, a run of consecutive events that the lock rejects but that
  // agree with each other is a tempo change, and the lock is re-seeded from
  // the run. An octave of the lock is as likely a half-time feel or doubled
  // kicks as a change, so it has to hold twice as long.
  const RELOCK_RUN = 6;
  const RELOCK_RUN_OCTAVE = 12;
  const RELOCK_AGREE = 0.25;
  let lastKickAt = 0;
  const ioi: number[] = []; // recent kick intervals (ms)
  let ioiMedian = 0;
  const relockRun = new Float64Array(RELOCK_RUN_OCTAVE);
  let relockCount = 0;
  let relockRef = 0;
  let bpm = 0;
  let beatConfidence = 0;
  let lastDownbeatAt = 0;
  let beatClock = 0;

  // Structure: ~2 Hz history of band vectors for a novelty curve, plus stored
  // section fingerprints so returning sections can be recognised.
  const STRUCT_PERIOD_MS = 500;
  // The spectrum is folded into eight regions of three bands, and each region
  // is measured against its own running mean and spread before any distance
  // is taken. Raw band vectors of the same song are all nearly parallel, so a
  // verse-to-chorus change barely registered on them; and a chord change only
  // shuffles energy between neighbouring bands inside a region, while an
  // instrument entering or leaving moves a whole region. Novelty is the RMS
  // over regions of (mean of the last 2 s) − (mean of the 16 s before), in
  // units of the region's spread; the long background averages a chord cycle
  // out while an 8-bar section still stands clear of it. The ring keeps raw
  // region means and standardises them against the statistics of the moment,
  // so the first ticks of a track never sit in the background as stale
  // outliers. Statistics are cumulative over the first 20 s and a 20 s EMA
  // after that. A boundary is the rising edge through the threshold.
  const STRUCT_STATS_ALPHA = 1 - Math.exp(-0.5 / 20);
  const STRUCT_VAR_FLOOR = 1e-4;
  const Z_CLAMP = 3;
  const Z_GROUPS = 8;
  const Z_GROUP_BANDS = EVILAND_BANDS / Z_GROUPS;
  const Z_RING = 36; // ticks kept: 4 recent + 32 before
  const Z_RECENT = 4;
  // Nothing fires inside the first 10 s: the statistics are still forming and
  // the first chord change of a track would read as a section.
  const Z_MIN_TICKS = 20;
  const SECTION_NOVELTY_THRESH = 1.1;
  // Noise alone puts the distance near 0.5; the detector re-arms once it is back there.
  const SECTION_NOVELTY_REARM = 0.6;
  const SECTION_MIN_GAP_MS = 7000; // min ms since lastNoveltyAt (last boundary)
  const SECTION_MIN_LEN_MS = 5000; // min ms since sectionStartAt (current section length)
  // A level that has fallen this far over the last 10 s, and through the last
  // 5 s has fallen every second by at least the step, is a fade-out; a look
  // change while the song is leaving is not wanted. A quieter section steps
  // down and holds, and gets its look.
  const FADE_GATE_DB = 1.5;
  const FADE_GATE_STEP_DB = 0.25;
  const FADE_GATE_TICKS = 20;
  // Fingerprints are compared in the same z-space, against the track's
  // statistics so far; raw cosine of all-positive band means sat above 0.9 for
  // any two parts of one song and called every section a return.
  const SECTION_RETURN_SIM = 0.6;
  let lastStructAt = 0;
  let tickCount = 0;
  // Bands are averaged over the frames of each tick, so a tick is not a
  // sample of the beat phase it happened to land on.
  const tickAccum = new Float32Array(EVILAND_BANDS);
  let tickFrames = 0;
  const groupMag = new Float32Array(Z_GROUPS);
  const groupMean = new Float32Array(Z_GROUPS);
  const groupVar = new Float32Array(Z_GROUPS);
  const groupRing = new Float32Array(Z_RING * Z_GROUPS);
  const loudRing = new Float32Array(Z_RING);
  let armed = true;
  // Whole-track-so-far statistics for fingerprint identity.
  let cumCount = 0;
  const cumMean = new Float64Array(EVILAND_BANDS);
  const cumM2 = new Float64Array(EVILAND_BANDS);
  const zA = new Float32Array(EVILAND_BANDS);
  const zB = new Float32Array(EVILAND_BANDS);
  let sectionId = 0;
  let sectionStartAt = 0;
  const sectionAccum = new Float32Array(EVILAND_BANDS);
  let sectionFrames = 0;
  // Each entry remembers which real sectionId it was fingerprinted from —
  // sectionId is an unbounded, ever-incrementing counter, but this array is
  // FIFO-capped at 24, so its own index stops matching sectionId once more
  // than 24 sections have ever been fingerprinted (routine within one song).
  // sectionReturn must report the real sectionId (the Director keys its
  // `sections` map by sectionId), not this array's position.
  const fingerprints: { sectionId: number; fp: Float32Array }[] = [];
  let lastNoveltyAt = 0;

  const out: EvilandFrame = {
    bands: bandOut,
    onsets: [],
    kick: 0,
    bass: 0,
    snare: 0,
    hat: 0,
    vocal: 0,
    energy: 0,
    centroid: 0,
    flatness: 0,
    noisiness: 0,
    crest: 0,
    rolloff: 0,
    width: 0,
    pan: 0,
    beatPhase: 0,
    beatConfidence: 0,
    bpm: 0,
    beatClock: 0,
    novelty: 0,
    sectionId: 0,
    sectionChanged: false,
    sectionReturn: -1,
    sectionFingerprint: null,
  };
  const onsetPool: EvilandOnset[] = [];
  // Reusable scratch for the BPM median sort: avoids a per-frame [...ioi]
  // spread + Array.sort allocation. Sized for the ioi cap (16) once.
  const sortScratch = new Float64Array(16);

  function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < EVILAND_BANDS; i++) {
      dot += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
    }
    if (na < 1e-9 || nb < 1e-9) return 1;
    return dot / Math.sqrt(na * nb);
  }

  /** z-score a band mean against the track's statistics so far, into `into`. */
  function zScoreInto(fp: Float32Array, into: Float32Array): void {
    for (let b = 0; b < EVILAND_BANDS; b++) {
      const sd = Math.sqrt(Math.max(STRUCT_VAR_FLOOR, cumCount > 1 ? cumM2[b]! / cumCount : 0));
      const z = (fp[b]! - cumMean[b]!) / sd;
      into[b] = z < -Z_CLAMP ? -Z_CLAMP : z > Z_CLAMP ? Z_CLAMP : z;
    }
  }

  return {
    reset(): void {
      // Level.
      refDb = REF_NOMINAL_DB;
      loudSlow = minDb;
      loudHeard = minDb;
      // Tempo/phase.
      lastKickAt = 0;
      ioi.length = 0;
      ioiMedian = 0;
      relockCount = 0;
      relockRef = 0;
      bpm = 0;
      beatConfidence = 0;
      lastDownbeatAt = 0;
      beatClock = 0;
      // Structural memory.
      lastStructAt = 0;
      tickCount = 0;
      tickAccum.fill(0);
      tickFrames = 0;
      groupMean.fill(0);
      groupVar.fill(0);
      groupRing.fill(0);
      loudRing.fill(0);
      armed = true;
      cumCount = 0;
      cumMean.fill(0);
      cumM2.fill(0);
      sectionId = 0;
      sectionStartAt = 0;
      sectionAccum.fill(0);
      sectionFrames = 0;
      fingerprints.length = 0;
      lastNoveltyAt = 0;
      // out.novelty is only recomputed on struct-ticks (every ~500ms) — since
      // this reset itself doesn't count as one, leaving it alone would let the
      // old track's decayed novelty value leak into frames returned before the
      // next tick.
      out.novelty = 0;
      out.beatClock = 0;
    },
    analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, nowMs): EvilandFrame {
      const dt = Number.isFinite(dtMs) ? Math.max(1, Math.min(100, dtMs)) : 1000 / 60;
      // A clock that is not a number would stall every timer below.
      if (!Number.isFinite(nowMs)) nowMs = lastNowMs + dt;
      lastNowMs = nowMs;
      out.onsets.length = 0;
      const fluxAlpha = 1 - Math.exp(-dt / FLUX_STATS_TAU_MS);

      // --- per-band magnitude + half-wave-rectified spectral flux (onset) ---
      let totalMag = 0;
      let weighted = 0; // for centroid
      let logSum = 0; // for flatness (geometric mean via log)
      let logCount = 0;
      let logPowerSum = 0; // for noisiness (geometric mean of band power via log)
      let powerMeanSum = 0; // for noisiness (arithmetic mean of band power)
      let powerSum = 0; // for loudness
      let peak = 0;
      // Noisiness is read with the quiet master lifted to the nominal
      // reference, bins the analyser cannot see left at its floor: at a low
      // level the floor sits closer under the music, which reads flatter.
      const liftGain = 10 ** (Math.min(BAND_LIFT_MAX * dbPerUnit, Math.max(0, REF_NOMINAL_DB - refDb)) / 10);
      for (let b = 0; b < EVILAND_BANDS; b++) {
        const s = bandStart[b]!;
        const e = bandEnd[b]!;
        let sum = 0;
        let onsetSum = 0;
        let power = 0;
        let liftedPower = 0;
        for (let k = s; k < e; k++) {
          // A byte the analyser did not supply reads as silence, not as NaN in a running mean.
          const byte = freq[k]! | 0;
          sum += byte;
          onsetSum += onsetFreq[k]! | 0;
          power += powerOfByte[byte]!;
          liftedPower += byte > 0 ? powerOfByte[byte]! * liftGain : powerFloor;
        }
        const n = Math.max(1, e - s);
        const mag = sum / n / 255; // 0..1 smoothed-source magnitude
        const onsetMag = onsetSum / n / 255; // 0..1 unsmoothed-source magnitude
        bandMag[b] = bandMag[b]! + (mag - bandMag[b]!) * 0.35; // light visual smoothing
        const bandPower = e > s ? liftedPower / n : powerFloor;
        powerSum += power;
        powerMeanSum += bandPower;
        logPowerSum += Math.log(bandPower);

        // Half-wave rectified flux against previous unsmoothed band.
        const flux = Math.max(0, onsetMag - prevOnsetBand[b]!);
        prevOnsetBand[b] = onsetMag;

        // Rolling mean/variance of the flux.
        const d = flux - fluxMean[b]!;
        fluxMean[b]! += fluxAlpha * d;
        fluxVar[b]! += fluxAlpha * (d * d - fluxVar[b]!);
        const std = Math.sqrt(Math.max(0, fluxVar[b]!));
        const thresh = fluxMean[b]! + 2.0 * std + 0.004;

        if (flux > thresh && nowMs - lastOnsetAt[b]! > REFRACTORY_MS) {
          lastOnsetAt[b] = nowMs;
          const intensity = unit((flux - thresh) / (thresh + 0.02));
          const sharpness = unit(flux / (fluxMean[b]! + 0.02));
          const group = groupForBand(b);
          const ev = onsetPool[out.onsets.length] ?? { band: 0, group: 'other' as VoiceGroup, intensity: 0, sharpness: 0 };
          ev.band = b;
          ev.group = group;
          ev.intensity = intensity;
          ev.sharpness = sharpness;
          onsetPool[out.onsets.length] = ev;
          out.onsets.push(ev);

          // One beat event per kick, timed by its first band. The decaying
          // tail of a kick re-triggers the top band a few frames on at near
          // zero intensity; that is not a beat.
          if (group === 'kick' && intensity >= KICK_EVENT_MIN_INTENSITY && nowMs - lastDownbeatAt > KICK_EVENT_WINDOW_MS) {
            const interval = nowMs - lastKickAt;
            // Once locked, an interval far from the median is a fill, an
            // eighth-note bass or a missed kick, not a tempo change. An event
            // that does not fit keeps the reference where it was, so the next
            // one is measured from the last beat that did, and a run of
            // eighths still reads at the beat.
            const plausible = interval >= IOI_MIN_MS && interval < IOI_MAX_MS;
            const agrees = ioi.length < 4 || (interval > 0.6 * ioiMedian && interval < 1.6 * ioiMedian);
            if (lastKickAt === 0 || interval >= IOI_MAX_MS) {
              lastKickAt = nowMs;
            } else if (plausible && agrees) {
              ioi.push(interval);
              if (ioi.length > 16) ioi.shift();
              lastKickAt = nowMs;
            }
            // The re-lock run is measured from the previous event whether or
            // not it fitted, and against the lock rather than the anchor: at
            // twice the tempo every other event still fits the old beat, and
            // the run must build up one event per beat regardless.
            const spacing = nowMs - lastDownbeatAt;
            const spacingFits = spacing > 0.6 * ioiMedian && spacing < 1.6 * ioiMedian;
            if (ioi.length >= 4 && !spacingFits && spacing >= IOI_MIN_MS && spacing < IOI_MAX_MS) {
              if (relockCount > 0 && Math.abs(spacing - relockRef) > RELOCK_AGREE * relockRef) relockCount = 0;
              if (relockCount === 0) relockRef = spacing;
              relockRun[relockCount] = spacing;
              relockCount++;
              const ratio = relockRef / ioiMedian;
              const octave = Math.abs(ratio - 2) < 0.2 || Math.abs(ratio - 0.5) < 0.05;
              if (relockCount >= (octave ? RELOCK_RUN_OCTAVE : RELOCK_RUN)) {
                ioi.length = 0;
                for (let i = 0; i < relockCount; i++) ioi.push(relockRun[i]!);
                relockCount = 0;
                lastKickAt = nowMs;
              }
            } else {
              relockCount = 0;
            }
            lastDownbeatAt = nowMs;
          }
        }

        totalMag += mag;
        weighted += b * mag;
        peak = Math.max(peak, mag);
        if (mag > 1e-4) {
          logSum += Math.log(mag);
          logCount++;
        }
      }

      // --- spectral statistics ---
      const meanMag = totalMag / EVILAND_BANDS;
      const centroidRaw = totalMag > 1e-6 ? weighted / totalMag / (EVILAND_BANDS - 1) : 0;
      const geoMean = logCount > 0 ? Math.exp(logSum / logCount) : 0;
      const flatnessRaw = meanMag > 1e-6 ? unit(geoMean / meanMag) : 0;
      // Noisiness on linear power, every band included: a lone sine is one
      // hot band against the floor and reads tonal, white noise reads 1. The
      // ratio is put on a 30 dB scale so music spreads over the range instead
      // of crowding the bottom.
      const geoPower = Math.exp(logPowerSum / EVILAND_BANDS);
      const meanPower = powerMeanSum / EVILAND_BANDS;
      const noisinessRaw = meanPower > powerFloor * 1.5 ? unit(1 + Math.log10(geoPower / meanPower) / 3) : 0;
      const crestRaw = meanMag > 1e-6 ? unit((peak / meanMag) / 8) : 0;
      // rolloff: band holding 85% cumulative energy. Use the smoothed display
      // magnitudes (bandMag) for BOTH the cumulative sum and the threshold so
      // transients can't bias the chosen band by mixing smoothed/raw sources.
      let bandMagTotal = 0;
      for (let b = 0; b < EVILAND_BANDS; b++) bandMagTotal += bandMag[b]!;
      let cum = 0;
      let rollBand = EVILAND_BANDS - 1;
      const energy85 = bandMagTotal * 0.85;
      for (let b = 0; b < EVILAND_BANDS; b++) {
        cum += bandMag[b]!;
        if (cum >= energy85) {
          rollBand = b;
          break;
        }
      }
      const rolloffRaw = rollBand / (EVILAND_BANDS - 1);

      // --- loudness against the track's own reference ---
      // The reference and the slow level integrate this, so it has to be a number.
      const loudRaw = 10 * Math.log10(powerSum / binTotal + 1e-20);
      const loudDb = loudRaw > minDb ? loudRaw : minDb;
      loudSlow += (loudDb - loudSlow) * (1 - Math.exp(-dt / 1000));
      if (loudSlow > loudHeard) loudHeard = loudSlow;
      const silent = loudDb <= silenceDb;
      if (loudDb > refDb) {
        refDb += (loudDb - refDb) * (1 - Math.exp(-dt / REF_ATTACK_MS));
      } else if (!silent) {
        const tau = refDb > loudHeard + REF_FAST_GAP_DB ? REF_RELEASE_FAST_MS : REF_RELEASE_MS;
        refDb += (loudDb - refDb) * (1 - Math.exp(-dt / tau));
      }
      if (refDb < refFloorDb) refDb = refFloorDb;
      const energyRaw = silent ? 0 : unit((loudDb - (refDb - ENERGY_RANGE_DB)) / ENERGY_RANGE_DB);
      // Lift a quiet master's bands to where a normal one sits. Bands at the
      // analyser's floor carry no information and stay at 0.
      const lift = bounded((REF_NOMINAL_DB - refDb) / dbPerUnit, 0, BAND_LIFT_MAX);
      for (let b = 0; b < EVILAND_BANDS; b++) {
        const m = bandMag[b]!;
        bandOut[b] = m > 0.002 ? unit(m + lift) : 0;
      }

      // --- semantic voice envelopes (peak band magnitude per group) ---
      const groupPeak = (g: Exclude<VoiceGroup, 'other'>): number => {
        const [lo, hi] = GROUP_BANDS[g];
        let m = 0;
        for (let b = lo; b <= hi && b < EVILAND_BANDS; b++) m = Math.max(m, bandOut[b]!);
        return m;
      };
      out.kick = kickEnv.step(groupPeak('kick'), dt);
      out.bass = bassEnv.step(groupPeak('bass'), dt);
      out.snare = snareEnv.step(groupPeak('snare'), dt);
      out.hat = hatEnv.step(groupPeak('hat'), dt);
      out.vocal = vocalEnv.step(groupPeak('vocal'), dt);
      out.energy = energyEnv.step(energyRaw, dt);
      out.centroid = centroidEnv.step(centroidRaw, dt);
      out.flatness = flatnessEnv.step(flatnessRaw, dt);
      out.noisiness = noisinessEnv.step(noisinessRaw, dt);
      out.crest = crestEnv.step(crestRaw, dt);
      out.rolloff = rolloffEnv.step(rolloffRaw, dt);

      // --- stereo width + pan from per-channel band energy ---
      let lSum = 0;
      let rSum = 0;
      let sideSum = 0;
      let midSum = 0;
      for (let k = 1; k < binCount; k++) {
        const l = (leftFreq[k]! | 0) / 255;
        const r = (rightFreq[k]! | 0) / 255;
        lSum += l;
        rSum += r;
        sideSum += Math.abs(l - r);
        midSum += (l + r) * 0.5;
      }
      // Mono detection: one channel essentially silent → treat as no stereo
      // info (width 0, pan 0). Without this, mono sources pin widthRaw to 1.0
      // because rSum≈0 makes sideSum/midSum saturate.
      const isMono = lSum < 1e-4 || rSum < 1e-4;
      const widthRaw = !isMono && midSum > 1e-6 ? unit(sideSum / midSum) : 0;
      // Clean (R - L) / (R + L) form — algebraically identical to the prior
      // *2 / (2*(R+L)) trick but no longer brittle to edits.
      const panRaw = !isMono && lSum + rSum > 1e-6 ? (rSum - lSum) / (rSum + lSum + 1e-6) : 0;
      out.width = widthEnv.step(widthRaw, dt);
      out.pan = panEnv.step(bounded(panRaw, -1, 1), dt);

      // --- tempo + phase (anticipation) ---
      if (ioi.length >= 4) {
        // Median interval is robust to the occasional missed/extra kick. Use a
        // reusable Float64Array scratch + .subarray().sort() so the per-frame
        // path stays allocation-free (Float64Array.sort is numeric by default).
        const n = ioi.length;
        for (let i = 0; i < n; i++) sortScratch[i] = ioi[i]!;
        const view = sortScratch.subarray(0, n);
        view.sort();
        const median = view[Math.floor(n / 2)]!;
        ioiMedian = median;
        const estBpm = 60000 / median;
        bpm += (estBpm - bpm) * 0.1;
        // Confidence = how tightly intervals cluster around the median.
        let spread = 0;
        for (const v of ioi) spread += Math.abs(v - median);
        spread /= ioi.length;
        beatConfidence = unit(1 - spread / (median * 0.5));
      } else {
        beatConfidence *= 0.99;
      }
      out.bpm = bpm;
      out.beatConfidence = beatConfidence;
      if (bpm > 1 && lastDownbeatAt > 0) {
        const beatMs = 60000 / bpm;
        out.beatPhase = (((nowMs - lastDownbeatAt) % beatMs) / beatMs + 1) % 1;
        // The clock runs at the estimated tempo and is steered toward the
        // kick anchor by speeding up or slowing down, never by jumping, so
        // it stays continuous and monotonic while it locks.
        let err = out.beatPhase - (beatClock - Math.floor(beatClock));
        if (err > 0.5) err -= 1;
        else if (err < -0.5) err += 1;
        beatClock += (dt / beatMs) * (1 + 0.8 * err);
      } else {
        out.beatPhase = 0;
      }
      out.beatClock = beatClock;

      // --- structural memory: novelty curve + section fingerprints ---
      out.sectionChanged = false;
      out.sectionReturn = -1;
      // sectionFingerprint is non-null ONLY on the frame a boundary fires; reset
      // here so any null-check downstream reads false on every other frame.
      out.sectionFingerprint = null;
      sectionFrames++;
      tickFrames++;
      for (let b = 0; b < EVILAND_BANDS; b++) {
        sectionAccum[b]! += bandMag[b]!;
        tickAccum[b]! += bandMag[b]!;
      }
      if (nowMs - lastStructAt >= STRUCT_PERIOD_MS) {
        lastStructAt = nowMs;
        const slot = tickCount % Z_RING;
        cumCount++;
        groupMag.fill(0);
        for (let b = 0; b < EVILAND_BANDS; b++) {
          const x = tickAccum[b]! / tickFrames;
          tickAccum[b] = 0;
          groupMag[Math.floor(b / Z_GROUP_BANDS)]! += x / Z_GROUP_BANDS;
          const delta = x - cumMean[b]!;
          cumMean[b]! += delta / cumCount;
          cumM2[b]! += delta * (x - cumMean[b]!);
        }
        tickFrames = 0;
        const statsAlpha = Math.max(STRUCT_STATS_ALPHA, 1 / (tickCount + 1));
        for (let g = 0; g < Z_GROUPS; g++) {
          const x = groupMag[g]!;
          if (tickCount === 0) {
            groupMean[g] = x;
            groupVar[g] = 0;
          } else {
            const d = x - groupMean[g]!;
            groupMean[g]! += statsAlpha * d;
            groupVar[g]! += statsAlpha * (d * d - groupVar[g]!);
          }
          groupRing[slot * Z_GROUPS + g] = x;
        }
        loudRing[slot] = loudSlow;
        tickCount++;

        if (tickCount >= Z_MIN_TICKS) {
          const olderCount = Math.min(Z_RING - Z_RECENT, tickCount - Z_RECENT);
          let dist = 0;
          for (let g = 0; g < Z_GROUPS; g++) {
            const mean = groupMean[g]!;
            const sd = Math.sqrt(Math.max(STRUCT_VAR_FLOOR, groupVar[g]!));
            let recent = 0;
            let older = 0;
            for (let a = 0; a < Z_RECENT + olderCount; a++) {
              const at = (((tickCount - 1 - a) % Z_RING) + Z_RING) % Z_RING;
              const z = (groupRing[at * Z_GROUPS + g]! - mean) / sd;
              const clamped = z < -Z_CLAMP ? -Z_CLAMP : z > Z_CLAMP ? Z_CLAMP : z;
              if (a < Z_RECENT) recent += clamped;
              else older += clamped;
            }
            const diff = recent / Z_RECENT - older / olderCount;
            dist += diff * diff;
          }
          dist = Math.sqrt(dist / Z_GROUPS);
          out.novelty = unit((dist - 0.5) / 1.5);

          // Fade gate: the last second sits FADE_GATE_DB under the level of
          // 5-10 s ago, and each of the last five seconds under the one before.
          let fading = false;
          if (tickCount >= FADE_GATE_TICKS) {
            const level = (back: number): number => loudRing[(((tickCount - 1 - back) % Z_RING) + Z_RING) % Z_RING]!;
            const second = (back: number): number => (level(back) + level(back + 1)) / 2;
            let before = 0;
            for (let a = 10; a < 20; a++) before += level(a) / 10;
            fading = before - second(0) >= FADE_GATE_DB;
            for (let w = 0; w < 4 && fading; w++) {
              if (second(2 * w) > second(2 * w + 2) - FADE_GATE_STEP_DB) fading = false;
            }
          }

          if (dist < SECTION_NOVELTY_THRESH * SECTION_NOVELTY_REARM) armed = true;
          // The rising edge through the threshold, not too soon after the last, = boundary.
          if (armed && dist >= SECTION_NOVELTY_THRESH && !fading && nowMs - lastNoveltyAt > SECTION_MIN_GAP_MS && nowMs - sectionStartAt > SECTION_MIN_LEN_MS) {
            armed = false;
            lastNoveltyAt = nowMs;
            // Fingerprint the section we're leaving.
            const fp = new Float32Array(EVILAND_BANDS);
            if (sectionFrames > 0) for (let b = 0; b < EVILAND_BANDS; b++) fp[b] = sectionAccum[b]! / sectionFrames;
            // Does it match a stored section? (visual rhyme — returning chorus)
            let bestMatchSectionId = -1;
            let bestSim = SECTION_RETURN_SIM; // threshold to call it a "return"
            zScoreInto(fp, zA);
            for (let i = 0; i < fingerprints.length; i++) {
              zScoreInto(fingerprints[i]!.fp, zB);
              const s = cosine(zA, zB);
              if (s > bestSim) {
                bestSim = s;
                bestMatchSectionId = fingerprints[i]!.sectionId;
              }
            }
            // Tag with the section that's ending (sectionId before the
            // increment below), matching the section fingerprints are taken of.
            fingerprints.push({ sectionId, fp });
            if (fingerprints.length > 24) fingerprints.shift();
            sectionId++;
            sectionStartAt = nowMs;
            sectionFrames = 0;
            sectionAccum.fill(0);
            out.sectionChanged = true;
            out.sectionReturn = bestMatchSectionId;
            // Surface the just-fingerprinted section so the renderer-side memory
            // bridge can persist it. The one Float32Array(24) allocation per real
            // boundary (~every 10-30s) is the entire per-frame cost — the rest of
            // the hot path stays allocation-free.
            out.sectionFingerprint = fp;
          }
        } else {
          out.novelty = 0;
        }
      } else {
        out.novelty *= 0.9;
      }
      out.sectionId = sectionId;

      return out;
    },
  };
}
