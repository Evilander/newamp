// External analysis tap for Bit-Perfect Exclusive mode.
//
// When the native WASAPI-exclusive engine owns playback, the renderer's Web
// Audio graph is silent — every AnalyserNode would read zero and the entire
// visualizer stack (Eviland, butterchurn, detached projector) would idle. This
// module rebuilds the exact AnalyserNode read surface from raw PCM windows
// shipped from the main process at ~30Hz, so AudioEngine's get*Data methods
// can serve identical bytes and no visualizer code changes.
//
// Faithful to the Web Audio spec (and the engine's analyser config):
//   - Blackman window, forward FFT, magnitudes scaled by 1/fftSize
//   - time smoothing S[k] = tau*S_prev[k] + (1-tau)*|X[k]|  (tau = 0.24 for the
//     smoothed visualizer tap, 0 for the onset/L/R taps — engine.ts:225,234)
//   - byte = 255 * clamp((20*log10(S) - minDb) / (maxDb - minDb)), min=-86 max=-10
//   - time-domain byte = clamp(128 * (1 + sample))

const FFT_SIZE = 2048;
const BIN_COUNT = FFT_SIZE / 2;
const MIN_DB = -86;
const MAX_DB = -10;
const SMOOTHING = 0.24;

// Precomputed Blackman window (matches the Web Audio AnalyserNode default).
const blackman = new Float32Array(FFT_SIZE);
for (let n = 0; n < FFT_SIZE; n++) {
  const a0 = 0.42;
  const a1 = 0.5;
  const a2 = 0.08;
  blackman[n] =
    a0 - a1 * Math.cos((2 * Math.PI * n) / FFT_SIZE) + a2 * Math.cos((4 * Math.PI * n) / FFT_SIZE);
}

// Iterative radix-2 FFT (in-place, split re/im arrays). 2048-point at 4 taps x
// 30Hz is ~2M flops/s — negligible.
const revTable = new Uint32Array(FFT_SIZE);
{
  const bits = Math.log2(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    revTable[i] = r;
  }
}
const twiddleCos = new Float32Array(FFT_SIZE / 2);
const twiddleSin = new Float32Array(FFT_SIZE / 2);
for (let i = 0; i < FFT_SIZE / 2; i++) {
  twiddleCos[i] = Math.cos((-2 * Math.PI * i) / FFT_SIZE);
  twiddleSin[i] = Math.sin((-2 * Math.PI * i) / FFT_SIZE);
}

function fftMagnitudes(input: Float32Array, re: Float32Array, im: Float32Array, out: Float32Array): void {
  for (let i = 0; i < FFT_SIZE; i++) {
    re[i] = (input[revTable[i]!] ?? 0) * blackman[revTable[i]!]!;
    im[i] = 0;
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let base = 0; base < FFT_SIZE; base += size) {
      for (let k = 0; k < half; k++) {
        const tIdx = k * step;
        const c = twiddleCos[tIdx]!;
        const s = twiddleSin[tIdx]!;
        const i0 = base + k;
        const i1 = base + k + half;
        const tr = re[i1]! * c - im[i1]! * s;
        const ti = re[i1]! * s + im[i1]! * c;
        re[i1] = re[i0]! - tr;
        im[i1] = im[i0]! - ti;
        re[i0] = re[i0]! + tr;
        im[i0] = im[i0]! + ti;
      }
    }
  }
  for (let k = 0; k < BIN_COUNT; k++) {
    out[k] = Math.hypot(re[k]!, im[k]!) / FFT_SIZE;
  }
}

function magnitudesToBytes(smoothed: Float32Array, out: Uint8Array): void {
  const range = MAX_DB - MIN_DB;
  for (let k = 0; k < BIN_COUNT; k++) {
    const mag = smoothed[k]!;
    const db = mag > 0 ? 20 * Math.log10(mag) : -Infinity;
    const scaled = ((db - MIN_DB) / range) * 255;
    out[k] = scaled < 0 ? 0 : scaled > 255 ? 255 : Math.round(scaled);
  }
}

class Channel {
  readonly smoothed = new Float32Array(BIN_COUNT);
  readonly bytes = new Uint8Array(BIN_COUNT);
  private readonly mags = new Float32Array(BIN_COUNT);

  constructor(private readonly smoothing: number) {}

  update(samples: Float32Array, re: Float32Array, im: Float32Array): void {
    fftMagnitudes(samples, re, im, this.mags);
    const tau = this.smoothing;
    for (let k = 0; k < BIN_COUNT; k++) {
      this.smoothed[k] = tau * this.smoothed[k]! + (1 - tau) * this.mags[k]!;
    }
    magnitudesToBytes(this.smoothed, this.bytes);
  }

  decayToSilence(): void {
    this.smoothed.fill(0);
    this.bytes.fill(0);
  }
}

export class ExternalAnalysisTap {
  readonly fftSize = FFT_SIZE;
  readonly frequencyBinCount = BIN_COUNT;

  private readonly smoothedMono = new Channel(SMOOTHING);
  private readonly onsetMono = new Channel(0);
  private readonly left = new Channel(0);
  private readonly right = new Channel(0);
  private readonly timeBytes = new Uint8Array(FFT_SIZE).fill(128);
  private readonly mono = new Float32Array(FFT_SIZE);
  private readonly chLeft = new Float32Array(FFT_SIZE);
  private readonly chRight = new Float32Array(FFT_SIZE);
  private readonly scratchRe = new Float32Array(FFT_SIZE);
  private readonly scratchIm = new Float32Array(FFT_SIZE);
  private sampleRate = 48000;
  private lastFeedAt = 0;

  /**
   * Feed one PCM window (interleaved stereo float32, most recent audible
   * samples). Windows shorter than fftSize are left-padded with silence;
   * longer ones use the tail.
   */
  feed(interleaved: Float32Array, channels: number, sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.lastFeedAt = performance.now();
    const frames = Math.floor(interleaved.length / Math.max(1, channels));
    const usable = Math.min(frames, FFT_SIZE);
    const skip = frames - usable;
    this.mono.fill(0);
    this.chLeft.fill(0);
    this.chRight.fill(0);
    const offset = FFT_SIZE - usable;
    if (channels >= 2) {
      for (let i = 0; i < usable; i++) {
        const l = interleaved[(skip + i) * channels]!;
        const r = interleaved[(skip + i) * channels + 1]!;
        this.chLeft[offset + i] = l;
        this.chRight[offset + i] = r;
        this.mono[offset + i] = (l + r) * 0.5;
      }
    } else {
      for (let i = 0; i < usable; i++) {
        const s = interleaved[skip + i]!;
        this.chLeft[offset + i] = s;
        this.chRight[offset + i] = s;
        this.mono[offset + i] = s;
      }
    }

    this.smoothedMono.update(this.mono, this.scratchRe, this.scratchIm);
    this.onsetMono.update(this.mono, this.scratchRe, this.scratchIm);
    this.left.update(this.chLeft, this.scratchRe, this.scratchIm);
    this.right.update(this.chRight, this.scratchRe, this.scratchIm);

    for (let i = 0; i < FFT_SIZE; i++) {
      const b = 128 * (1 + this.mono[i]!);
      this.timeBytes[i] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
    }
  }

  /** True when a window arrived recently enough to be considered live. */
  isFresh(): boolean {
    return performance.now() - this.lastFeedAt < 500;
  }

  /** Zero all analysis state (paused/stopped) so visuals decay to idle. */
  silence(): void {
    this.smoothedMono.decayToSilence();
    this.onsetMono.decayToSilence();
    this.left.decayToSilence();
    this.right.decayToSilence();
    this.timeBytes.fill(128);
  }

  getSampleRate(): number {
    return this.sampleRate;
  }

  private copyBytes(src: Uint8Array, buf: Uint8Array): void {
    const n = Math.min(src.length, buf.length);
    buf.set(src.subarray(0, n));
    if (buf.length > n) buf.fill(src === this.timeBytes ? 128 : 0, n);
  }

  getFreqData(buf: Uint8Array): void {
    this.copyBytes(this.smoothedMono.bytes, buf);
  }
  getOnsetFreqData(buf: Uint8Array): void {
    this.copyBytes(this.onsetMono.bytes, buf);
  }
  getLeftFreqData(buf: Uint8Array): void {
    this.copyBytes(this.left.bytes, buf);
  }
  getRightFreqData(buf: Uint8Array): void {
    this.copyBytes(this.right.bytes, buf);
  }
  getTimeData(buf: Uint8Array): void {
    this.copyBytes(this.timeBytes, buf);
  }
  getOnsetTimeData(buf: Uint8Array): void {
    this.copyBytes(this.timeBytes, buf);
  }
}
