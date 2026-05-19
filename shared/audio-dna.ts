// Audio DNA: per-track perceptual feature vectors.
//
// Pure-math feature extraction over decoded mono PCM. No I/O, no ffmpeg, no
// platform deps — runs identically in node and the browser. Callers feed in a
// Float32Array of normalized samples (range -1..1) at a known sample rate and
// receive a deterministic TrackDna vector that downstream features (Sounds
// Like, Living Tags, Sonic Diff, the wallpaper spectrogram) consume.
//
// The vector intentionally stays small. Each scalar is normalized into a
// roughly 0..1 (or labelled-units) range so cosine similarity over the band
// energies + lightweight per-feature distances both behave sensibly.

export const AUDIO_DNA_VERSION = 1;
export const AUDIO_DNA_TARGET_SAMPLE_RATE = 22050;
export const AUDIO_DNA_FRAME_SIZE = 2048;
export const AUDIO_DNA_HOP_SIZE = 1024;
export const AUDIO_DNA_MAX_SECONDS = 60;

const BAND_EDGES_HZ = [0, 200, 500, 1500, 4000, 11025];

export interface TrackDna {
  v: typeof AUDIO_DNA_VERSION;
  framesAnalyzed: number;
  secondsAnalyzed: number;
  rms: number;            // 0..1, perceptual loudness proxy
  dynamicRange: number;   // 0..1, frame RMS variance scaled
  brightness: number;     // 0..1, spectral centroid normalized to nyquist
  flatness: number;       // 0..1, geometric mean / arithmetic mean of spectrum
  bands: number[];        // 5 entries, each 0..1, summing to ~1
  onsetDensity: number;   // 0..1, onsets per second normalized
  rolloff: number;        // 0..1, 85th percentile spectral roll-off / nyquist
}

export function emptyTrackDna(): TrackDna {
  return {
    v: AUDIO_DNA_VERSION,
    framesAnalyzed: 0,
    secondsAnalyzed: 0,
    rms: 0,
    dynamicRange: 0,
    brightness: 0,
    flatness: 0,
    bands: [0, 0, 0, 0, 0],
    onsetDensity: 0,
    rolloff: 0,
  };
}

export function isValidTrackDna(value: unknown): value is TrackDna {
  if (!value || typeof value !== 'object') return false;
  const dna = value as Partial<TrackDna>;
  if (dna.v !== AUDIO_DNA_VERSION) return false;
  if (!Array.isArray(dna.bands) || dna.bands.length !== 5) return false;
  return (
    typeof dna.rms === 'number' &&
    typeof dna.brightness === 'number' &&
    typeof dna.flatness === 'number' &&
    typeof dna.dynamicRange === 'number' &&
    typeof dna.onsetDensity === 'number' &&
    typeof dna.rolloff === 'number'
  );
}

export interface ComputeDnaOptions {
  sampleRate: number;
  maxSeconds?: number;
  frameSize?: number;
  hopSize?: number;
}

export function computeTrackDna(samples: Float32Array, opts: ComputeDnaOptions): TrackDna {
  const sampleRate = opts.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('computeTrackDna requires a positive sampleRate.');
  }
  const frameSize = opts.frameSize ?? AUDIO_DNA_FRAME_SIZE;
  const hopSize = opts.hopSize ?? AUDIO_DNA_HOP_SIZE;
  const maxSeconds = opts.maxSeconds ?? AUDIO_DNA_MAX_SECONDS;
  const maxSamples = Math.min(samples.length, Math.floor(maxSeconds * sampleRate));
  if (maxSamples < frameSize) return emptyTrackDna();

  const window = hannWindow(frameSize);
  const frameBuffer = new Float32Array(frameSize);
  const real = new Float32Array(frameSize);
  const imag = new Float32Array(frameSize);
  const magnitudes = new Float32Array(frameSize / 2);
  const bandEdges = bandEdgesToBins(BAND_EDGES_HZ, sampleRate, frameSize);

  const frameRms: number[] = [];
  let centroidAcc = 0;
  let flatnessAcc = 0;
  let rolloffAcc = 0;
  const bandAcc = new Float64Array(5);
  const fluxFrames: number[] = [];
  let prevMagnitudes: Float32Array | null = null;
  let frames = 0;

  for (let start = 0; start + frameSize <= maxSamples; start += hopSize) {
    for (let i = 0; i < frameSize; i++) {
      frameBuffer[i] = samples[start + i]! * window[i]!;
      real[i] = frameBuffer[i]!;
      imag[i] = 0;
    }
    fftInPlace(real, imag);

    let frameEnergy = 0;
    for (let i = 0; i < magnitudes.length; i++) {
      const mag = Math.hypot(real[i]!, imag[i]!);
      magnitudes[i] = mag;
      frameEnergy += mag * mag;
    }

    let rmsSum = 0;
    for (let i = 0; i < frameSize; i++) rmsSum += frameBuffer[i]! * frameBuffer[i]!;
    const rms = Math.sqrt(rmsSum / frameSize);
    frameRms.push(rms);

    if (frameEnergy > 0) {
      centroidAcc += spectralCentroid(magnitudes, sampleRate, frameSize);
      flatnessAcc += spectralFlatness(magnitudes);
      rolloffAcc += spectralRolloff(magnitudes, 0.85);
      const totals = bandEnergies(magnitudes, bandEdges);
      const sum = totals.reduce((a, b) => a + b, 0) || 1;
      for (let i = 0; i < 5; i++) bandAcc[i]! += totals[i]! / sum;
    }

    if (prevMagnitudes) {
      let flux = 0;
      for (let i = 0; i < magnitudes.length; i++) {
        const d = magnitudes[i]! - prevMagnitudes[i]!;
        if (d > 0) flux += d;
      }
      fluxFrames.push(flux);
    } else {
      prevMagnitudes = new Float32Array(magnitudes.length);
    }
    prevMagnitudes.set(magnitudes);
    frames++;
  }

  if (frames === 0) return emptyTrackDna();

  const meanRms = frameRms.reduce((a, b) => a + b, 0) / frameRms.length;
  const varianceRms = frameRms.reduce((acc, v) => acc + (v - meanRms) * (v - meanRms), 0) / frameRms.length;
  const dynamicRange = clamp01(Math.sqrt(varianceRms) * 4);

  const bands = Array.from(bandAcc, (v) => clamp01(v / frames));
  const brightness = clamp01(centroidAcc / frames / (sampleRate / 2));
  const flatness = clamp01(flatnessAcc / frames);
  const rolloff = clamp01(rolloffAcc / frames / (sampleRate / 2));

  const onsetDensity = computeOnsetDensity(fluxFrames, sampleRate, hopSize);
  const secondsAnalyzed = (frames * hopSize) / sampleRate;

  return {
    v: AUDIO_DNA_VERSION,
    framesAnalyzed: frames,
    secondsAnalyzed: round3(secondsAnalyzed),
    rms: clamp01(meanRms * 2),
    dynamicRange,
    brightness,
    flatness,
    bands,
    onsetDensity,
    rolloff,
  };
}

export function dnaCosineSimilarity(a: TrackDna, b: TrackDna): number {
  const av = dnaToVector(a);
  const bv = dnaToVector(b);
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < av.length; i++) {
    dot += av[i]! * bv[i]!;
    aMag += av[i]! * av[i]!;
    bMag += bv[i]! * bv[i]!;
  }
  if (aMag === 0 || bMag === 0) return 0;
  const cos = dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
  return clamp01((cos + 1) / 2);
}

export function dnaDistance(a: TrackDna, b: TrackDna): number {
  const av = dnaToVector(a);
  const bv = dnaToVector(b);
  let sumSq = 0;
  for (let i = 0; i < av.length; i++) {
    const d = av[i]! - bv[i]!;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / av.length);
}

export function dnaToVector(dna: TrackDna): number[] {
  return [
    dna.rms,
    dna.dynamicRange,
    dna.brightness,
    dna.flatness,
    dna.rolloff,
    dna.onsetDensity,
    ...dna.bands,
  ];
}

export function pcmFromInt16(buf: Buffer | Uint8Array): Float32Array {
  const view = buf instanceof Buffer ? buf : Buffer.from(buf);
  const count = Math.floor(view.byteLength / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = view.readInt16LE(i * 2);
    out[i] = v / 32768;
  }
  return out;
}

function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

function bandEdgesToBins(edgesHz: number[], sampleRate: number, frameSize: number): number[] {
  const nyquist = sampleRate / 2;
  return edgesHz.map((hz) => {
    if (hz <= 0) return 0;
    if (hz >= nyquist) return frameSize / 2;
    return Math.min(frameSize / 2, Math.round((hz / nyquist) * (frameSize / 2)));
  });
}

function spectralCentroid(magnitudes: Float32Array, sampleRate: number, frameSize: number): number {
  let weighted = 0;
  let total = 0;
  for (let i = 1; i < magnitudes.length; i++) {
    const hz = (i * sampleRate) / frameSize;
    const m = magnitudes[i]!;
    weighted += hz * m;
    total += m;
  }
  return total > 0 ? weighted / total : 0;
}

function spectralFlatness(magnitudes: Float32Array): number {
  let geo = 0;
  let arith = 0;
  let count = 0;
  for (let i = 1; i < magnitudes.length; i++) {
    const m = magnitudes[i]!;
    if (m <= 0) continue;
    geo += Math.log(m);
    arith += m;
    count++;
  }
  if (count === 0) return 0;
  const geoMean = Math.exp(geo / count);
  const arithMean = arith / count;
  return arithMean > 0 ? geoMean / arithMean : 0;
}

function spectralRolloff(magnitudes: Float32Array, threshold: number): number {
  let total = 0;
  for (let i = 0; i < magnitudes.length; i++) total += magnitudes[i]!;
  if (total <= 0) return 0;
  const target = total * threshold;
  let running = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    running += magnitudes[i]!;
    if (running >= target) return i;
  }
  return magnitudes.length - 1;
}

function bandEnergies(magnitudes: Float32Array, edges: number[]): number[] {
  const out = new Array(edges.length - 1).fill(0);
  for (let b = 0; b < out.length; b++) {
    const start = edges[b]!;
    const end = edges[b + 1]!;
    let acc = 0;
    for (let i = start; i < end; i++) acc += magnitudes[i]! * magnitudes[i]!;
    out[b] = acc;
  }
  return out;
}

function computeOnsetDensity(flux: number[], sampleRate: number, hopSize: number): number {
  if (flux.length === 0) return 0;
  const mean = flux.reduce((a, b) => a + b, 0) / flux.length;
  const variance = flux.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / flux.length;
  const threshold = mean + Math.sqrt(variance);
  let onsets = 0;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i]! > threshold && flux[i]! >= flux[i - 1]! && flux[i]! > flux[i + 1]!) onsets++;
  }
  const seconds = (flux.length * hopSize) / sampleRate;
  if (seconds <= 0) return 0;
  return clamp01((onsets / seconds) / 8);
}

function fftInPlace(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT requires power-of-two size.');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = real[i]!; real[i] = real[j]!; real[j] = t;
      t = imag[i]!; imag[i] = imag[j]!; imag[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angleStep = (-2 * Math.PI) / len;
    const wReal = Math.cos(angleStep);
    const wImag = Math.sin(angleStep);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const tr = curReal * real[b]! - curImag * imag[b]!;
        const ti = curReal * imag[b]! + curImag * real[b]!;
        real[b] = real[a]! - tr;
        imag[b] = imag[a]! - ti;
        real[a] = real[a]! + tr;
        imag[a] = imag[a]! + ti;
        const newReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = newReal;
      }
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
