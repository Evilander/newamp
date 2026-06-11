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
// Pure TS, zero deps, allocation-free hot path. The renderer subscribes to the
// returned frame; it never polls raw FFT.

export type VoiceGroup = 'kick' | 'bass' | 'snare' | 'hat' | 'vocal' | 'other';

export interface EvilandOnset {
  band: number; // 0..BANDS-1
  group: VoiceGroup;
  intensity: number; // 0..1 (how far over threshold)
  sharpness: number; // 0..1 (attack steepness)
}

export interface EvilandFrame {
  bands: Float32Array; // BANDS smoothed band magnitudes, 0..1
  onsets: EvilandOnset[]; // onsets detected THIS frame
  // Semantic voice envelopes (asymmetric attack/release), 0..1.
  kick: number;
  bass: number;
  snare: number;
  hat: number;
  vocal: number;
  energy: number; // overall loudness 0..1
  centroid: number; // spectral centroid (brightness) 0..1
  flatness: number; // 0 tonal .. 1 noisy
  crest: number; // peakiness 0..1
  rolloff: number; // 0..1 (85% energy frequency, normalised)
  width: number; // stereo width 0..1
  pan: number; // -1 left .. +1 right
  beatPhase: number; // 0..1, 0 = on the beat
  beatConfidence: number; // 0..1
  bpm: number;
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
}

export interface EvilandReactorConfig {
  sampleRate: number;
  fftSize: number;
  binCount: number;
}

export const EVILAND_BANDS = 24;

const MIN_HZ = 20;
const MAX_HZ = 16000;
const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1);

// Which raw bands belong to each semantic voice (see spec §Part 1).
// Inclusive [lo, hi] band ranges; kept non-overlapping so groupPeak() and
// groupForBand() classify every boundary band identically.
const GROUP_BANDS: Record<Exclude<VoiceGroup, 'other'>, [number, number]> = {
  kick: [0, 2],
  bass: [3, 5],
  snare: [6, 9],
  vocal: [10, 14],
  hat: [19, 23],
};

function groupForBand(band: number): VoiceGroup {
  if (band <= 2) return 'kick';
  if (band <= 5) return 'bass';
  if (band <= 9) return 'snare';
  if (band <= 14) return 'vocal';
  if (band >= 19) return 'hat';
  return 'other';
}

// One-pole asymmetric envelope follower (fast attack / slow release is the
// single biggest "alive vs seizure" lever — see research §1.9).
class Env {
  value = 0;
  constructor(
    private readonly tauAttackMs: number,
    private readonly tauReleaseMs: number,
  ) {}
  step(x: number, dtMs: number): number {
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
}

export function createEvilandReactor(config: EvilandReactorConfig): EvilandReactor {
  const { sampleRate, fftSize, binCount } = config;
  const binHz = sampleRate / fftSize;

  // Precompute mel band → [startBin, endBin) once.
  const edgesMel: number[] = [];
  const loMel = hzToMel(MIN_HZ);
  const hiMel = hzToMel(Math.min(MAX_HZ, sampleRate / 2));
  for (let i = 0; i <= EVILAND_BANDS; i++) {
    edgesMel.push(loMel + ((hiMel - loMel) * i) / EVILAND_BANDS);
  }
  const bandStart = new Int32Array(EVILAND_BANDS);
  const bandEnd = new Int32Array(EVILAND_BANDS);
  for (let b = 0; b < EVILAND_BANDS; b++) {
    const lo = Math.max(1, Math.floor(melToHz(edgesMel[b]!) / binHz));
    const hi = Math.max(lo + 1, Math.ceil(melToHz(edgesMel[b + 1]!) / binHz));
    bandStart[b] = lo;
    bandEnd[b] = Math.min(binCount, hi);
  }

  // Per-band state.
  const bandMag = new Float32Array(EVILAND_BANDS); // smoothed display magnitude
  const prevOnsetBand = new Float32Array(EVILAND_BANDS); // previous unsmoothed band for flux
  const fluxMean = new Float32Array(EVILAND_BANDS); // rolling mean of flux
  const fluxVar = new Float32Array(EVILAND_BANDS); // rolling variance of flux
  const lastOnsetAt = new Float32Array(EVILAND_BANDS); // refractory timer
  const REFRACTORY_MS = 90;

  // Semantic envelopes.
  const kickEnv = new Env(3, 160);
  const bassEnv = new Env(10, 250);
  const snareEnv = new Env(3, 150);
  const hatEnv = new Env(2, 120);
  const vocalEnv = new Env(20, 400);
  const energyEnv = new Env(10, 220);
  const centroidEnv = new Env(50, 800);
  const flatnessEnv = new Env(60, 700);
  const crestEnv = new Env(20, 300);
  const rolloffEnv = new Env(50, 600);
  const widthEnv = new Env(100, 1500);
  const panEnv = new Env(100, 1500);

  // Tempo / phase from kick inter-onset intervals.
  let lastKickAt = 0;
  const ioi: number[] = []; // recent kick intervals (ms)
  let bpm = 0;
  let beatConfidence = 0;
  let lastDownbeatAt = 0;

  // Structure: ~2 Hz history of band vectors for a novelty curve, plus stored
  // section fingerprints so returning sections can be recognised.
  const STRUCT_PERIOD_MS = 500;
  // Structure-detection tuning. A slower recent-average EMA keeps a genuine
  // musical change reading as "novel" instead of being absorbed within ~3s,
  // and relaxed time guards let real sections fire ~2x more often — this is
  // what gives the visualizer MilkDrop-like variety. See
  // docs/superpowers/specs/2026-06-09-eviland-evolving-variety-design.md.
  const STRUCT_RECENT_ALPHA = 0.06; // was 0.18
  const SECTION_NOVELTY_THRESH = 0.22; // unchanged
  const SECTION_MIN_GAP_MS = 3500; // min ms since lastNoveltyAt (last boundary) — was 6000
  const SECTION_MIN_LEN_MS = 3500; // min ms since sectionStartAt (current section length) — was 6000
  let lastStructAt = 0;
  const recentAvg = new Float32Array(EVILAND_BANDS);
  let recentInit = false;
  let sectionId = 0;
  let sectionStartAt = 0;
  const sectionAccum = new Float32Array(EVILAND_BANDS);
  let sectionFrames = 0;
  const fingerprints: Float32Array[] = [];
  let lastNoveltyAt = 0;

  const out: EvilandFrame = {
    bands: bandMag,
    onsets: [],
    kick: 0,
    bass: 0,
    snare: 0,
    hat: 0,
    vocal: 0,
    energy: 0,
    centroid: 0,
    flatness: 0,
    crest: 0,
    rolloff: 0,
    width: 0,
    pan: 0,
    beatPhase: 0,
    beatConfidence: 0,
    bpm: 0,
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

  return {
    analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, nowMs): EvilandFrame {
      const dt = Math.max(1, Math.min(100, dtMs));
      out.onsets.length = 0;

      // --- per-band magnitude + half-wave-rectified spectral flux (onset) ---
      let totalMag = 0;
      let weighted = 0; // for centroid
      let logSum = 0; // for flatness (geometric mean via log)
      let logCount = 0;
      let peak = 0;
      for (let b = 0; b < EVILAND_BANDS; b++) {
        const s = bandStart[b]!;
        const e = bandEnd[b]!;
        let sum = 0;
        let onsetSum = 0;
        for (let k = s; k < e; k++) {
          sum += freq[k]!;
          onsetSum += onsetFreq[k]!;
        }
        const n = Math.max(1, e - s);
        const mag = sum / n / 255; // 0..1 smoothed-source magnitude
        const onsetMag = onsetSum / n / 255; // 0..1 unsmoothed-source magnitude
        bandMag[b] = bandMag[b]! + (mag - bandMag[b]!) * 0.35; // light visual smoothing

        // Half-wave rectified flux against previous unsmoothed band.
        const flux = Math.max(0, onsetMag - prevOnsetBand[b]!);
        prevOnsetBand[b] = onsetMag;

        // Rolling mean/variance (~1s window @ ~60fps → α≈0.03).
        const a = 0.03;
        const d = flux - fluxMean[b]!;
        fluxMean[b]! += a * d;
        fluxVar[b]! += a * (d * d - fluxVar[b]!);
        const std = Math.sqrt(Math.max(0, fluxVar[b]!));
        const thresh = fluxMean[b]! + 2.0 * std + 0.004;

        if (flux > thresh && nowMs - lastOnsetAt[b]! > REFRACTORY_MS) {
          lastOnsetAt[b] = nowMs;
          const intensity = Math.min(1, (flux - thresh) / (thresh + 0.02));
          const sharpness = Math.min(1, flux / (fluxMean[b]! + 0.02));
          const group = groupForBand(b);
          const ev = onsetPool[out.onsets.length] ?? { band: 0, group: 'other' as VoiceGroup, intensity: 0, sharpness: 0 };
          ev.band = b;
          ev.group = group;
          ev.intensity = intensity;
          ev.sharpness = sharpness;
          onsetPool[out.onsets.length] = ev;
          out.onsets.push(ev);

          if (group === 'kick') {
            if (lastKickAt > 0) {
              const interval = nowMs - lastKickAt;
              if (interval > 250 && interval < 1500) {
                // plausible 40–240 BPM
                ioi.push(interval);
                if (ioi.length > 16) ioi.shift();
              }
            }
            lastKickAt = nowMs;
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
      const flatnessRaw = meanMag > 1e-6 ? Math.min(1, geoMean / meanMag) : 0;
      const crestRaw = meanMag > 1e-6 ? Math.min(1, (peak / meanMag) / 8) : 0;
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
      const energyRaw = Math.min(1, Math.pow(meanMag, 0.7) * 1.6);

      // --- semantic voice envelopes (peak band magnitude per group) ---
      const groupPeak = (g: Exclude<VoiceGroup, 'other'>): number => {
        const [lo, hi] = GROUP_BANDS[g];
        let m = 0;
        for (let b = lo; b <= hi && b < EVILAND_BANDS; b++) m = Math.max(m, bandMag[b]!);
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
      out.crest = crestEnv.step(crestRaw, dt);
      out.rolloff = rolloffEnv.step(rolloffRaw, dt);

      // --- stereo width + pan from per-channel band energy ---
      let lSum = 0;
      let rSum = 0;
      let sideSum = 0;
      let midSum = 0;
      for (let k = 1; k < binCount; k++) {
        const l = leftFreq[k]! / 255;
        const r = rightFreq[k]! / 255;
        lSum += l;
        rSum += r;
        sideSum += Math.abs(l - r);
        midSum += (l + r) * 0.5;
      }
      // Mono detection: one channel essentially silent → treat as no stereo
      // info (width 0, pan 0). Without this, mono sources pin widthRaw to 1.0
      // because rSum≈0 makes sideSum/midSum saturate.
      const isMono = lSum < 1e-4 || rSum < 1e-4;
      const widthRaw = !isMono && midSum > 1e-6 ? Math.min(1, sideSum / midSum) : 0;
      // Clean (R - L) / (R + L) form — algebraically identical to the prior
      // *2 / (2*(R+L)) trick but no longer brittle to edits.
      const panRaw = !isMono && lSum + rSum > 1e-6 ? (rSum - lSum) / (rSum + lSum + 1e-6) : 0;
      out.width = widthEnv.step(widthRaw, dt);
      out.pan = panEnv.step(Math.max(-1, Math.min(1, panRaw)), dt);

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
        const estBpm = 60000 / median;
        bpm += (estBpm - bpm) * 0.1;
        // Confidence = how tightly intervals cluster around the median.
        let spread = 0;
        for (const v of ioi) spread += Math.abs(v - median);
        spread /= ioi.length;
        beatConfidence = Math.max(0, Math.min(1, 1 - spread / (median * 0.5)));
      } else {
        beatConfidence *= 0.99;
      }
      out.bpm = bpm;
      out.beatConfidence = beatConfidence;
      if (bpm > 1 && lastDownbeatAt > 0) {
        const beatMs = 60000 / bpm;
        out.beatPhase = (((nowMs - lastDownbeatAt) % beatMs) / beatMs + 1) % 1;
      } else {
        out.beatPhase = 0;
      }

      // --- structural memory: novelty curve + section fingerprints ---
      out.sectionChanged = false;
      out.sectionReturn = -1;
      // sectionFingerprint is non-null ONLY on the frame a boundary fires; reset
      // here so any null-check downstream reads false on every other frame.
      out.sectionFingerprint = null;
      sectionFrames++;
      for (let b = 0; b < EVILAND_BANDS; b++) sectionAccum[b]! += bandMag[b]!;
      if (nowMs - lastStructAt >= STRUCT_PERIOD_MS) {
        lastStructAt = nowMs;
        if (!recentInit) {
          for (let b = 0; b < EVILAND_BANDS; b++) recentAvg[b] = bandMag[b]!;
          recentInit = true;
        }
        // current vs slow-moving recent average → novelty.
        const tmp = new Float32Array(EVILAND_BANDS);
        for (let b = 0; b < EVILAND_BANDS; b++) tmp[b] = bandMag[b]!;
        const sim = cosine(tmp, recentAvg);
        out.novelty = Math.max(0, Math.min(1, 1 - sim));
        for (let b = 0; b < EVILAND_BANDS; b++) recentAvg[b]! += (bandMag[b]! - recentAvg[b]!) * STRUCT_RECENT_ALPHA;

        // A sustained novelty spike, not too soon after the last, = boundary.
        if (out.novelty > SECTION_NOVELTY_THRESH && nowMs - lastNoveltyAt > SECTION_MIN_GAP_MS && nowMs - sectionStartAt > SECTION_MIN_LEN_MS) {
          lastNoveltyAt = nowMs;
          // Fingerprint the section we're leaving.
          const fp = new Float32Array(EVILAND_BANDS);
          if (sectionFrames > 0) for (let b = 0; b < EVILAND_BANDS; b++) fp[b] = sectionAccum[b]! / sectionFrames;
          // Does it match a stored section? (visual rhyme — returning chorus)
          let bestIdx = -1;
          let bestSim = 0.86; // threshold to call it a "return"
          for (let i = 0; i < fingerprints.length; i++) {
            const s = cosine(fp, fingerprints[i]!);
            if (s > bestSim) {
              bestSim = s;
              bestIdx = i;
            }
          }
          fingerprints.push(fp);
          if (fingerprints.length > 24) fingerprints.shift();
          sectionId++;
          sectionStartAt = nowMs;
          sectionFrames = 0;
          sectionAccum.fill(0);
          out.sectionChanged = true;
          out.sectionReturn = bestIdx;
          // Surface the just-fingerprinted section so the renderer-side memory
          // bridge can persist it. The one Float32Array(24) allocation per real
          // boundary (~every 10-30s) is the entire per-frame cost — the rest of
          // the hot path stays allocation-free.
          out.sectionFingerprint = fp;
        }
      } else {
        out.novelty *= 0.9;
      }
      out.sectionId = sectionId;

      return out;
    },
  };
}
