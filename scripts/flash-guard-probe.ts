// Browser half of `npm run test:flash-guard-render` (flash-guard-render-test.mjs).
//
// Drives the REAL output routes on a fixed 60 Hz clock and reads back what
// each one displays:
//   - the production shader painter (startShaderVisualizer, Burning Cloud and
//     the other shader looks) with the Punch reactivity and a theme accent,
//     fed by an AnalyserNode emulation of a dense four-on-the-floor track
//   - the Eviland renderer, fed by the real reactor on the same audio
//   - the 2D presenter (offscreen 2D painter → GPU guard) and the CPU guard
//     on synthetic strobes, including flicker whose pixels flash out of step,
//     and the GPU guard against the TypeScript spec
// Each route runs with protection off, then on. Flashes are counted the way
// flash analysers count them: per-pixel pairs in a sliding 60-frame window,
// whole-field pairs from the frame mean, and for each whole-field pair the
// share of pixels that make both opposing transitions.
import butterchurn from 'butterchurn';
import butterchurnPresets from 'butterchurn-presets';
import { startShaderVisualizer } from '../src/components/Visualizer';
import { setFlashGuardEnabled } from '../src/lib/vizPrefs';
import { createEvilandRenderer, type EvilandPalette } from '../src/visualizer/eviland';
import { createEvilandReactor } from '../src/visualizer/eviland-audio';
import { liveGradeFor, resolveEvilandPalette, tuneEvilandFrame } from '../src/visualizer/eviland-appearance';
import { createEvilandLivePipeline } from '../src/visualizer/eviland-live-pipeline';
import { generate } from '../src/visualizer/eviland-randomizer';
import { attachFlashGuard, createGuarded2dSurface, gpuFlashGuardSupported } from '../src/visualizer/flash-guard-host';
import { createParticleFlowRenderer } from '../src/visualizer/particle-flow';
import { createCanvasFlashGuard } from '../src/visualizer/flash-guard-2d';
import {
  FLASH_GUARD_COLS,
  FLASH_GUARD_ROWS,
  LINEAR_BYTE,
  applyGuard,
  createFlashGuardState,
  createTapFrame,
  guardPixel,
  linearToSrgb,
  stepFlashGuard,
  tapX,
  tapY,
  type FlashGuardState,
  type GuardedPixel,
  type TapFrame,
} from '../src/visualizer/flash-guard';

const W = 160;
const H = 90;
const FPS = 60;
const SECONDS = 8;
const FRAMES = FPS * SECONDS;
// Frames per run: the reduced sweep for software GL runs shorter clips.
let runFrames = FRAMES;
const SR = 48000;
const N = 2048;
const BINS = 1024;

// The window is hidden; the frame gate skips painting while document.hidden.
Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
document.documentElement.style.setProperty('--accent', '#39ff14');
document.documentElement.style.setProperty('--accent-dim', '#1aa30a');

// ── Audio: generated fixtures, and an AnalyserNode emulation ────────────────

function prng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** 120 BPM kick with a pitch drop, 8th-note noise hats, a 110 Hz drone. */
function densePcm(seconds: number): Float32Array {
  const rand = prng(0x4e455741);
  const pcm = new Float32Array(SR * seconds);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SR;
    const k = t % 0.5;
    const h = t % 0.25;
    pcm[i] = 0.46 * Math.sin(2 * Math.PI * (48 * k + (55 * (1 - Math.exp(-k * 30))) / 30)) * Math.exp(-k * 13)
      + (rand() * 2 - 1) * 0.08 * Math.exp(-h * 70)
      + 0.05 * Math.sin(2 * Math.PI * 110 * t);
  }
  return pcm;
}

/** Sparse plucked guitar notes over near-silence. */
function sparsePcm(seconds: number): Float32Array {
  const rand = prng(0x5a17);
  const onsets = [0.4, 1.1, 1.95, 3.2, 4.05, 5.9, 6.35];
  const notes = [110, 146.832, 196, 246.942, 329.628, 220];
  const pcm = new Float32Array(SR * seconds);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SR;
    let x = (rand() - 0.5) * 0.0012;
    onsets.forEach((start, j) => {
      const d = t - start;
      if (d < 0 || d >= 2.2) return;
      const f = notes[j % notes.length]!;
      const env = (1 - Math.exp(-d * 1100)) * Math.exp(-d * 3.2);
      let sum = 0;
      for (let h = 1; h < 9; h++) sum += (Math.sin(2 * Math.PI * f * h * d + j * 0.3) * Math.exp(-d * h * 0.65)) / (h * h ** 0.2);
      x += 0.12 * env * sum;
    });
    pcm[i] = x;
  }
  return pcm;
}

function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= N; len *= 2) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let j = 0; j < len / 2; j++) {
        const c = Math.cos(a * j);
        const s = Math.sin(a * j);
        const k = i + j + len / 2;
        const u = i + j;
        const tr = re[k]! * c - im[k]! * s;
        const ti = re[k]! * s + im[k]! * c;
        re[k] = re[u]! - tr;
        im[k] = im[u]! - ti;
        re[u] = re[u]! + tr;
        im[u] = im[u]! + ti;
      }
    }
  }
}

interface AnalyserFrame {
  freq: Uint8Array;
  onset: Uint8Array;
  wave: Uint8Array;
}

/** What the engine's analysers report at 60 Hz: Blackman window, −86..−10 dB bytes, smoothing 0.24. */
function analyse(pcm: Float32Array): AnalyserFrame[] {
  const smooth = new Float64Array(BINS);
  const frames: AnalyserFrame[] = [];
  const bytes = (v: number): number => Math.max(0, Math.min(255, Math.floor((255 * (20 * Math.log10(Math.max(1e-10, v)) + 86)) / 76)));
  for (let f = 0; f < FRAMES; f++) {
    const end = Math.floor((f / FPS) * SR);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const wave = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      const v = pcm[end - N + k] ?? 0;
      wave[k] = Math.max(0, Math.min(255, 128 + Math.floor(v * 128)));
      re[k] = v * (0.42 - 0.5 * Math.cos((2 * Math.PI * k) / N) + 0.08 * Math.cos((4 * Math.PI * k) / N));
    }
    fft(re, im);
    const freq = new Uint8Array(BINS);
    const onset = new Uint8Array(BINS);
    for (let k = 0; k < BINS; k++) {
      const mag = Math.hypot(re[k]!, im[k]!) / N;
      smooth[k] = 0.24 * smooth[k]! + 0.76 * mag;
      onset[k] = bytes(mag);
      freq[k] = bytes(smooth[k]!);
    }
    frames.push({ freq, onset, wave });
  }
  return frames;
}

function fakeEngine(frames: AnalyserFrame[], at: () => number) {
  return {
    frequencyBinCount: BINS,
    fftSize: N,
    getSampleRate: () => SR,
    getState: () => ({ playing: true }),
    getFreqData: (b: Uint8Array) => b.set(frames[at()]!.freq.subarray(0, b.length)),
    getOnsetFreqData: (b: Uint8Array) => b.set(frames[at()]!.onset.subarray(0, b.length)),
    getLeftFreqData: (b: Uint8Array) => b.set(frames[at()]!.freq.subarray(0, b.length)),
    getRightFreqData: (b: Uint8Array) => b.set(frames[at()]!.freq.subarray(0, b.length)),
    getTimeData: (b: Uint8Array) => b.set(frames[at()]!.wave.subarray(0, b.length)),
  };
}

// ── Flash counting, the way flash analysers do it ──────────────────────────

const LINEAR = Float32Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function makeCounter(n: number, threshold: number, red = false, keepEvents = false) {
  const low = new Float32Array(n);
  const high = new Float32Array(n);
  const phase = new Uint8Array(n);
  const counts = new Uint8Array(n);
  const loAt = new Int32Array(n);
  const hiAt = new Int32Array(n);
  const riseLow = new Int32Array(n);
  const ring = Array.from({ length: FPS }, () => new Uint8Array(n));
  let maxArea = 0;
  let peak = 0;
  let total = 0;
  const events: Array<{ region: number; frame: number; lowFrame: number; highFrame: number }> = [];
  return {
    frame(values: Float32Array, t: number) {
      let area = 0;
      const slot = ring[t % FPS]!;
      for (let i = 0; i < n; i++) {
        counts[i] = counts[i]! - slot[i]!;
        slot[i] = 0;
        const v = values[i]!;
        if (!phase[i]) {
          if (v < low[i]!) {
            low[i] = v;
            loAt[i] = t;
          }
          if (v - low[i]! >= threshold && (red || low[i]! < 0.8)) {
            phase[i] = 1;
            high[i] = v;
            hiAt[i] = t;
            riseLow[i] = loAt[i]!;
          }
        } else {
          if (v > high[i]!) {
            high[i] = v;
            hiAt[i] = t;
          }
          if (high[i]! - v >= threshold) {
            phase[i] = 0;
            low[i] = v;
            loAt[i] = t;
            slot[i] = 1;
            counts[i] = counts[i]! + 1;
            total++;
            if (keepEvents) events.push({ region: i, frame: t, lowFrame: riseLow[i]!, highFrame: hiAt[i]! });
          }
        }
        if (counts[i]! >= 4) area++;
        peak = Math.max(peak, counts[i]!);
      }
      maxArea = Math.max(maxArea, area / n);
    },
    result: () => ({ maxAreaWithAtLeast4PairsPerSecond: maxArea, peakPairsAtAnyPixel: peak, totalPixelPairs: total }),
    events,
  };
}

interface Analysis {
  general: ReturnType<ReturnType<typeof makeCounter>['result']>;
  red: ReturnType<ReturnType<typeof makeCounter>['result']>;
  /** Whole-field pairs where at least a quarter of the pixels made both transitions. */
  confirmedPairs: Array<{ seconds: number; area: number }>;
  /** Most confirmed whole-field pairs in any one-second window. */
  maxConfirmedPerSecond: number;
  /** Most whole-field (frame-mean) pairs in any one-second window, area ignored. */
  maxFieldPairsPerSecond: number;
  /**
   * Most pairs in any one-second window of any 1%-of-the-screen region (every
   * tile-aligned 2x3-tile window of the 32x18 grid, this canvas standing for
   * the whole screen): the scale the guard works at, counted independently.
   */
  maxRegionalPerSecond: number;
  /** The per-frame mean of the region that flashed most (for diagnosis). */
  worstRegion: { index: number; series: number[] };
  meanLuminance: number;
}

/** Collects frames from one run and counts flashes. `diffAgainst` (RGBA per frame) reports mean |Δ|. */
function createAnalysis(w: number, h: number) {
  const n = w * h;
  const lum = new Float32Array(n);
  const red = new Float32Array(n);
  const general = makeCounter(n, 0.1);
  const redCounter = makeCounter(n, 0.0625, true);
  const regions = makeCounter(5, 0.1, false, true);
  const means = new Float32Array(5);
  const cols = FLASH_GUARD_COLS;
  const rows = FLASH_GUARD_ROWS;
  const tiles = new Float32Array(cols * rows);
  const tileCounts = new Float32Array(cols * rows);
  for (let i = 0; i < n; i++) {
    tileCounts[Math.min(rows - 1, Math.floor((Math.floor(i / w) * rows) / h)) * cols + Math.min(cols - 1, Math.floor(((i % w) * cols) / w))] += 1;
  }
  const RW = 2;
  const RH = 3;
  const localMeans = new Float32Array((cols - RW + 1) * (rows - RH + 1));
  const local = makeCounter(localMeans.length, 0.1);
  const localHistory: Float32Array[] = [];
  const saved: Float32Array[] = [];
  let lumSum = 0;
  let t = 0;
  return {
    add(rgba: Uint8Array) {
      means.fill(0);
      tiles.fill(0);
      for (let i = 0; i < n; i++) {
        const r = LINEAR[rgba[i * 4]!]!;
        const g = LINEAR[rgba[i * 4 + 1]!]!;
        const b = LINEAR[rgba[i * 4 + 2]!]!;
        lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        red[i] = r / (r + g + b + 1e-9) >= 0.8 ? Math.max(0, r - g - b) : 0;
        const x = i % w;
        const y = Math.floor(i / w);
        means[(x >= w / 2 ? 1 : 0) + (y >= h / 2 ? 2 : 0)] += lum[i]! / (n / 4);
        means[4] += lum[i]! / n;
        tiles[Math.min(rows - 1, Math.floor((y * rows) / h)) * cols + Math.min(cols - 1, Math.floor((x * cols) / w))] += lum[i]!;
        lumSum += lum[i]!;
      }
      for (let k = 0; k < tiles.length; k++) tiles[k] = tiles[k]! / Math.max(1, tileCounts[k]!);
      let r = 0;
      for (let y0 = 0; y0 <= rows - RH; y0++) {
        for (let x0 = 0; x0 <= cols - RW; x0++, r++) {
          let sum = 0;
          for (let yy = y0; yy < y0 + RH; yy++) for (let xx = x0; xx < x0 + RW; xx++) sum += tiles[yy * cols + xx]!;
          localMeans[r] = sum / (RW * RH);
        }
      }
      saved.push(lum.slice());
      regions.frame(means, t);
      general.frame(lum, t);
      redCounter.frame(red, t);
      local.frame(localMeans, t);
      localHistory.push(localMeans.slice());
      t++;
    },
    finish(): Analysis {
      const confirmedPairs: Array<{ seconds: number; area: number }> = [];
      const fieldFrames: number[] = [];
      for (const event of regions.events) {
        if (event.region !== 4) continue;
        fieldFrames.push(event.frame);
        const low = saved[event.lowFrame]!;
        const peak = saved[event.highFrame]!;
        const end = saved[event.frame]!;
        let both = 0;
        for (let k = 0; k < n; k++) {
          if (peak[k]! - low[k]! >= 0.1 && peak[k]! - end[k]! >= 0.1 && Math.min(low[k]!, end[k]!) < 0.8) both++;
        }
        if (both / n >= 0.25) confirmedPairs.push({ seconds: event.frame / FPS, area: both / n });
      }
      return {
        general: general.result(),
        red: redCounter.result(),
        confirmedPairs,
        maxConfirmedPerSecond: maxInWindow(confirmedPairs.map((p) => Math.round(p.seconds * FPS))),
        maxFieldPairsPerSecond: maxInWindow(fieldFrames),
        maxRegionalPerSecond: local.result().peakPairsAtAnyPixel,
        worstRegion: worstRegion(localHistory),
        meanLuminance: lumSum / (n * Math.max(1, t)),
      };
    },
  };
}

/** The region whose own series has the most pairs in a second, and that series. */
function worstRegion(history: Float32Array[]): { index: number; series: number[] } {
  let best = { index: -1, count: -1 };
  const regions = history[0]?.length ?? 0;
  for (let r = 0; r < regions; r++) {
    const counter = makeCounter(1, 0.1);
    const value = new Float32Array(1);
    history.forEach((frame, t) => {
      value[0] = frame[r]!;
      counter.frame(value, t);
    });
    const count = counter.result().peakPairsAtAnyPixel;
    if (count > best.count) best = { index: r, count };
  }
  return { index: best.index, series: best.index < 0 ? [] : history.map((frame) => Math.round(frame[best.index]! * 10000) / 10000) };
}

function maxInWindow(frames: number[]): number {
  let best = 0;
  for (let i = 0, j = 0; i < frames.length; i++) {
    while (frames[i]! - frames[j]! >= FPS) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** A canvas the area gate reads as fullscreen, with a small drawing buffer. */
function stageCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${screen.width}px;height:${screen.height}px`;
  document.body.append(canvas);
  return canvas;
}

let rafCallback: FrameRequestCallback | null = null;
window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  rafCallback = cb;
  return 1;
};
window.cancelAnimationFrame = () => {
  rafCallback = null;
};

interface RunResult {
  analysis: Analysis;
  /** Mean |Δ| per RGB channel (0..255) against the reference run, if given. */
  meanAbsDiff?: number;
  frames: Uint8Array[];
  /** The drawing buffer the frames were read from (W x H at most). */
  width: number;
  height: number;
}

function readFrame(gl: WebGL2RenderingContext, w = W, h = H): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

function meanAbs(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
  return sum / ((a.length / 4) * 3);
}

function finishRun(frames: Uint8Array[], reference?: Uint8Array[], width = W, height = H): RunResult {
  const analysis = createAnalysis(W, H);
  let diff = 0;
  frames.forEach((frame, i) => {
    analysis.add(frame);
    if (reference) diff += meanAbs(frame, reference[i]!);
  });
  return { analysis: analysis.finish(), meanAbsDiff: reference ? diff / frames.length : undefined, frames, width, height };
}

function shaderRun(mode: string, audio: AnalyserFrame[], guarded: boolean, reference?: Uint8Array[]): RunResult {
  setFlashGuardEnabled(guarded);
  let at = 0;
  const canvas = stageCanvas();
  const stop = startShaderVisualizer({
    canvas,
    canvasRef: { current: canvas },
    engine: fakeEngine(audio, () => at) as never,
    mode: mode as never,
    tuning: { current: { palette: 'theme', reactivity: 'punch' } },
    // Just under 60 Hz so a fixed 60 Hz clock never lands a hair early.
    frameIntervalMs: 1000 / 61,
    dprCap: 1,
    maxPixels: W * H,
  });
  if (!stop) throw new Error(`shader visualizer ${mode} did not start`);
  const gl = canvas.getContext('webgl2')!;
  const frames: Uint8Array[] = [];
  for (at = 0; at < runFrames; at++) {
    rafCallback?.(10_000 + (at / FPS) * 1000);
    frames.push(readFrame(gl));
  }
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  stop();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  canvas.remove();
  return finishRun(frames, reference, width, height);
}

const EVILAND_PALETTE: EvilandPalette = { accent: [0.22, 1, 0.08], dark: [0.1, 0.64, 0.04], light: [1, 1, 1], bg: [0.02, 0.024, 0.04] };

function evilandRun(seed: string, audio: AnalyserFrame[], guarded: boolean, reference?: Uint8Array[]): RunResult {
  setFlashGuardEnabled(guarded);
  const canvas = stageCanvas();
  const renderer = createEvilandRenderer(canvas, { quality: 'high', smoke: true, seed: 'flash-guard' });
  if (!renderer) throw new Error('Eviland renderer unavailable');
  renderer.resize(W, H, 1);
  renderer.setConfig(generate(seed).config);
  const guard = attachFlashGuard(canvas.getContext('webgl2'), canvas);
  const reactor = createEvilandReactor({ sampleRate: SR, fftSize: N, binCount: BINS });
  const gl = canvas.getContext('webgl2')!;
  const frames: Uint8Array[] = [];
  const dt = 1000 / FPS;
  for (let f = 0; f < runFrames; f++) {
    const a = audio[f]!;
    const frame = reactor.analyze(a.freq, a.onset, a.freq, a.freq, dt, 10_000 + f * dt);
    renderer.setWaveform(a.wave.subarray(0, 256));
    renderer.render(tuneEvilandFrame(frame, 'punch'), EVILAND_PALETTE, dt, 'host');
    guard?.apply(dt);
    frames.push(readFrame(gl));
  }
  guard?.dispose();
  renderer.dispose();
  canvas.remove();
  return finishRun(frames, reference);
}

interface MilkdropVisualizer {
  loadPreset(preset: unknown, blendSeconds: number): void;
  render(opts: unknown): void;
}

const milkdropFactory = ((butterchurn as unknown as { default?: unknown }).default ?? butterchurn) as {
  createVisualizer(ctx: BaseAudioContext, canvas: HTMLCanvasElement, opts: unknown): MilkdropVisualizer;
};
const presetApi = ((butterchurnPresets as unknown as { default?: unknown }).default ?? butterchurnPresets) as {
  getPresets(): Record<string, unknown>;
};

/**
 * The MilkDrop iframe's route: real Butterchurn (with the Eviland Live
 * pipeline when `live`), audio bytes pre-emphasised the way the parent
 * posts them for Punch, and the guard attached after render() exactly as
 * butterchurn-iframe/main.ts does. Math.random is seeded so preset
 * equations repeat between the unguarded and guarded run.
 */
function milkdropRun(preset: unknown, audio: AnalyserFrame[], guarded: boolean, live: boolean, reference?: Uint8Array[]): RunResult {
  setFlashGuardEnabled(guarded);
  const random = Math.random;
  Math.random = prng(0xb0c5);
  const canvas = stageCanvas();
  canvas.width = W;
  canvas.height = H;
  const bc = milkdropFactory.createVisualizer(new OfflineAudioContext(1, SR, SR), canvas, { width: W, height: H, meshWidth: 24, meshHeight: 18 });
  const pipeline = live ? createEvilandLivePipeline(bc, 'high') : null;
  if (live && !pipeline) throw new Error('Eviland Live pipeline refused this Butterchurn build');
  bc.loadPreset(preset, 0);
  const gl = canvas.getContext('webgl2')!;
  const guard = attachFlashGuard(gl, canvas);
  if (!guard) throw new Error('flash guard unavailable in the Butterchurn context');
  const reactor = createEvilandReactor({ sampleRate: SR, fftSize: N, binCount: BINS });
  const config = generate('flash-guard::live').config;
  const samples = new Uint8Array(1024);
  const frames: Uint8Array[] = [];
  const dt = 1000 / FPS;
  try {
    for (let f = 0; f < runFrames; f++) {
      const a = audio[f]!;
      for (let i = 0; i < samples.length; i++) {
        const lifted = (((a.wave[i * 2] ?? 128) - 128) / 128) * 1.4;
        samples[i] = 128 + Math.round((lifted / (1 + Math.abs(lifted))) * 127);
      }
      if (pipeline) {
        const frame = reactor.analyze(a.freq, a.onset, a.freq, a.freq, dt, 10_000 + f * dt);
        pipeline.update({
          frame: tuneEvilandFrame(frame, 'punch'),
          palette: resolveEvilandPalette('look', EVILAND_PALETTE, f / FPS, undefined, config.palette),
          config,
          seed: 'flash-guard',
          waveMode: 'auto',
          grade: liveGradeFor('look'),
        });
        pipeline.advance(dt);
      }
      bc.render({ audioLevels: { timeByteArray: samples, timeByteArrayL: samples, timeByteArrayR: samples }, elapsedTime: 1 / FPS });
      guard.apply(dt);
      frames.push(readFrame(gl));
    }
  } finally {
    guard.dispose();
    pipeline?.dispose();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
    Math.random = random;
  }
  return finishRun(frames, reference);
}

type Painter = (ctx: CanvasRenderingContext2D, t: number) => void;

/** A frame per time step through the 2D presenter (GPU guard). */
function presenterRun(paint: Painter, guarded: boolean, reference?: Uint8Array[]): RunResult {
  setFlashGuardEnabled(guarded);
  const canvas = stageCanvas();
  const surface = createGuarded2dSurface(canvas, true, true);
  surface.paint.width = W;
  surface.paint.height = H;
  const ctx = surface.paint.getContext('2d', { alpha: false })!;
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('2D presenter did not take the GPU route');
  const frames: Uint8Array[] = [];
  for (let f = 0; f < runFrames; f++) {
    paint(ctx, f / FPS);
    surface.show(1000 / FPS);
    frames.push(readFrame(gl));
  }
  surface.dispose();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  canvas.remove();
  return finishRun(frames, reference);
}

/** The same through the CPU guard on a plain 2D canvas. */
function canvasGuardRun(paint: Painter): RunResult {
  const canvas = stageCanvas();
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const guard = createCanvasFlashGuard()!;
  const frames: Uint8Array[] = [];
  for (let f = 0; f < runFrames; f++) {
    paint(ctx, f / FPS);
    guard.apply(canvas, 1000 / FPS, 1);
    // getImageData is top row first; flash counting doesn't care.
    frames.push(new Uint8Array(ctx.getImageData(0, 0, W, H).data));
  }
  canvas.remove();
  return finishRun(frames);
}

const square = (hz: number, t: number): boolean => Math.floor(t * hz * 2) % 2 === 0;
const fill = (colorAt: (t: number) => string): Painter => (ctx, t) => {
  ctx.fillStyle = colorAt(t);
  ctx.fillRect(0, 0, W, H);
};
const strobe = (hz: number, on: string, off: string): Painter => fill((t) => (square(hz, t) ? on : off));

/** A painter from a per-pixel linear grey level. */
function pixels(level: (x: number, y: number, t: number) => number): Painter {
  const image = new ImageData(W, H);
  const bytes = new Map<number, number>();
  const encode = (v: number): number => {
    let b = bytes.get(v);
    if (b == null) bytes.set(v, (b = Math.round(linearToSrgb(v) * 255)));
    return b;
  };
  return (ctx, t) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const b = encode(level(x, y, t));
        const p = (y * W + x) * 4;
        image.data[p] = image.data[p + 1] = image.data[p + 2] = b;
        image.data[p + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  };
}

/**
 * Flicker whose pixels flash out of step: block means barely move, or cancel
 * exactly, while far more than a quarter of every 1% region flashes.
 */
const DISPERSED: Array<[string, Painter]> = [
  ['stripes 40% 0-0.2 10Hz', pixels((x, y, t) => (x % 5 < 2 && square(10, t) ? 0.2 : 0))],
  ['dots 30% 0-0.3 12Hz', pixels((x, y, t) => ((x + 3 * y) % 10 < 3 && square(12, t) ? 0.3 : 0))],
  ['8px checkerboard reversing 0-0.6 8Hz', pixels((x, y, t) => ((((x >> 3) + (y >> 3)) % 2 === 0) === square(8, t) ? 0.6 : 0))],
  ['1px checkerboard reversing 0.05-0.5 15Hz', pixels((x, y, t) => (((x + y) % 2 === 0) === square(15, t) ? 0.5 : 0.05))],
];

/**
 * Fine texture against the tap grid, at a size where there are fewer taps
 * than pixels: at 1024x576 a tile is 32x32 pixels and gets 16x16 taps, two
 * pixels to a tap. A regular lattice would sample only every other column
 * there, so every even column strobing (half the picture) would never be
 * seen. Counted pixel by pixel on what the presenter shows; returns the most
 * flashes a second at any pixel and the share of pixels past three.
 */
function latticeRun(guarded: boolean): { peakPairsAtAnyPixel: number; pixelsWith4PairsPerSecond: number } {
  const w = 1024;
  const h = 576;
  setFlashGuardEnabled(guarded);
  const canvas = stageCanvas();
  const surface = createGuarded2dSurface(canvas, true, true);
  surface.paint.width = w;
  surface.paint.height = h;
  const ctx = surface.paint.getContext('2d', { alpha: false })!;
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('2D presenter did not take the GPU route');
  const bright = Math.round(linearToSrgb(0.5) * 255);
  const images = [false, true].map((on) => {
    const image = new ImageData(w, h);
    for (let k = 0; k < w * h; k++) {
      const b = on && (k % w) % 2 === 0 ? bright : 0;
      image.data[k * 4] = image.data[k * 4 + 1] = image.data[k * 4 + 2] = b;
      image.data[k * 4 + 3] = 255;
    }
    return image;
  });
  const counter = makeCounter(w * h, 0.1);
  const lum = new Float32Array(w * h);
  const px = new Uint8Array(w * h * 4);
  for (let f = 0; f < runFrames; f++) {
    ctx.putImageData(images[square(10, f / FPS) ? 1 : 0]!, 0, 0);
    surface.show(1000 / FPS);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let k = 0; k < w * h; k++) lum[k] = 0.2126 * LINEAR[px[k * 4]!]! + 0.7152 * LINEAR[px[k * 4 + 1]!]! + 0.0722 * LINEAR[px[k * 4 + 2]!]!;
    counter.frame(lum, f);
  }
  surface.dispose();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  canvas.remove();
  const r = counter.result();
  return { peakPairsAtAnyPixel: r.peakPairsAtAnyPixel, pixelsWith4PairsPerSecond: Math.round(r.maxAreaWithAtLeast4PairsPerSecond * 10000) / 100 };
}

/**
 * GPU vs spec where there are fewer taps than pixels (640x360, 512x288 taps),
 * so where in its cell each tap samples matters: in a 1 px checkerboard
 * reversing, a tap on the other pixel of its cell sees the opposite phase.
 * The spec runs open on what the GPU showed, as in contentParity(), over
 * every pixel of every third row for three seconds. Taps easing out of a hold
 * climb slowly through the rise threshold, and float rounding can put that
 * crossing a frame apart on the two, so this is judged on the average: taps
 * that sample different pixels move it by an order of magnitude.
 */
function jitterParity(): { meanByteDiff: number; maxByteDiff: number; over4: number; limitedPixels: number; worst: string[] } {
  const w = 640;
  const h = 360;
  setFlashGuardEnabled(true);
  const canvas = stageCanvas();
  const surface = createGuarded2dSurface(canvas, true, true);
  surface.paint.width = w;
  surface.paint.height = h;
  const ctx = surface.paint.getContext('2d', { alpha: false })!;
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('2D presenter did not take the GPU route');
  const high = Math.round(linearToSrgb(0.5) * 255);
  const low = Math.round(linearToSrgb(0.05) * 255);
  // Bytes per phase in GL order (row 0 at the bottom, as the guard sees it).
  const glBytes = [false, true].map((on) => Uint8Array.from({ length: w * h }, (_, k) => {
    const x = k % w;
    const y = Math.floor(k / w);
    return ((x + y) % 2 === 0) === on ? high : low;
  }));
  const images = glBytes.map((bytes) => {
    const image = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const b = bytes[(h - 1 - y) * w + x]!;
        const k = (y * w + x) * 4;
        image.data[k] = image.data[k + 1] = image.data[k + 2] = b;
        image.data[k + 3] = 255;
      }
    }
    return image;
  });
  const state = createFlashGuardState(w, h);
  const input = createTapFrame({ x: state.tapsX, y: state.tapsY });
  const shown = createTapFrame({ x: state.tapsX, y: state.tapsY });
  const result: GuardedPixel = { gain: 1, desat: 1 };
  const colour = new Float32Array(3);
  const out = new Uint8Array(w * h * 4);
  let sum = 0;
  let max = 0;
  let count = 0;
  let over4 = 0;
  const worst: string[] = [];
  for (let f = 0; f < FPS * 3; f++) {
    const phase = square(15, f / FPS) ? 1 : 0;
    const bytes = glBytes[phase]!;
    ctx.putImageData(images[phase]!, 0, 0);
    surface.show(1000 / FPS);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    for (let j = 0; j < state.tapsY; j++) {
      for (let i = 0; i < state.tapsX; i++) {
        input.lum[j * state.tapsX + i] = LINEAR[bytes[tapY(i, j, state.tapsY, h) * w + tapX(i, j, state.tapsX, w)]!]!;
        input.red[j * state.tapsX + i] = 0;
      }
    }
    stepFlashGuard(state, input, f > 0 ? shown : null, 1 / FPS, 1 / (FLASH_GUARD_COLS * FLASH_GUARD_ROWS));
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x++) {
        const b = bytes[y * w + x]!;
        const v = LINEAR[b]!;
        guardPixel(state, x, y, v, v, v, result);
        const untouched = result.gain === 1 && result.desat === 1;
        if (!untouched) applyGuard(v, v, v, result, colour);
        const expected = untouched ? b : Math.round(linearToSrgb(colour[1]!) * 255);
        const got = out[(y * w + x) * 4 + 1]!;
        if (untouched && got === b) continue;
        const d = Math.abs(got - expected);
        sum += d;
        max = Math.max(max, d);
        if (d > 4) {
          over4++;
          if (worst.length < 4) worst.push(`f${f} ${x},${y} got ${got} want ${expected} gain ${result.gain.toFixed(3)}`);
        }
        count++;
      }
    }
    for (let j = 0; j < state.tapsY; j++) {
      for (let i = 0; i < state.tapsX; i++) {
        const k = (tapY(i, j, state.tapsY, h) * w + tapX(i, j, state.tapsX, w)) * 4;
        shown.lum[j * state.tapsX + i] = 0.2126 * LINEAR[out[k]!]! + 0.7152 * LINEAR[out[k + 1]!]! + 0.0722 * LINEAR[out[k + 2]!]!;
        shown.red[j * state.tapsX + i] = 0;
      }
    }
  }
  surface.dispose();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  canvas.remove();
  return { meanByteDiff: Math.round((sum / Math.max(1, count)) * 1000) / 1000, maxByteDiff: max, over4, limitedPixels: count, worst };
}

function latticeCheck(failures: string[]): Record<string, unknown> {
  const before = latticeRun(false);
  const after = latticeRun(true);
  if (before.peakPairsAtAnyPixel <= 3) failures.push(`even columns at 1024x576 did not flash before the guard (${before.peakPairsAtAnyPixel}/s)`);
  if (after.peakPairsAtAnyPixel > 3) failures.push(`even columns at 1024x576: ${after.peakPairsAtAnyPixel} flashes/s at a pixel after the guard`);
  const parity = jitterParity();
  if (parity.meanByteDiff > 0.05) failures.push(`1 px checkerboard at 640x360: GPU differs from the spec by ${parity.meanByteDiff} levels on average`);
  return { before, after, parity };
}

/**
 * On real content a tap that lands within rounding of a threshold can go
 * either way on the GPU and in the spec, and the two histories part from
 * there, so pixel-for-pixel equality isn't expected; on average they must
 * still agree to a level.
 */
function checkDrift<T extends { meanByteDiff: number }>(parity: T, failures: string[]): T {
  if (parity.meanByteDiff > 1) failures.push(`Burning Cloud dense: GPU drifts from the spec by ${parity.meanByteDiff} levels on average`);
  return parity;
}

/** Out-of-step flicker through the presenter and the CPU guard: no pixel may flash more than three times a second. */
function dispersedRuns(failures: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, paint] of DISPERSED) {
    const plain = presenterRun(paint, false);
    const gpu = presenterRun(paint, true, plain.frames);
    const cpu = canvasGuardRun(paint);
    out[name] = { before: summary(plain), presenter: summary(gpu), canvas2d: summary(cpu), parity: contentParity(plain, gpu) };
    const peak = (r: RunResult) => r.analysis.general.peakPairsAtAnyPixel;
    if (peak(plain) <= 3) failures.push(`${name}: did not flash before the guard (${peak(plain)}/s at a pixel)`);
    if (peak(gpu) > 3) failures.push(`${name} via presenter: ${peak(gpu)} flashes/s at a pixel`);
    if (peak(cpu) > 3) failures.push(`${name} via CPU guard: ${peak(cpu)} flashes/s at a pixel`);
    // Every transition here is far from a threshold, so the GPU must show
    // what the spec shows, pixel for pixel, up to rounding.
    const parity = (out[name] as { parity: { maxByteDiff: number } }).parity;
    if (parity.maxByteDiff > 2) failures.push(`${name}: GPU differs from the spec by up to ${parity.maxByteDiff} levels at a pixel`);
    // judge()'s other limits, but not its calm rule: these means are calm by
    // construction, which is the point.
    const a = gpu.analysis;
    const worst = Math.max(a.maxConfirmedPerSecond, a.maxFieldPairsPerSecond, a.maxRegionalPerSecond);
    if (worst > 3) failures.push(`${name} via presenter: ${worst} flashes/s over an area after the guard`);
  }
  return out;
}

/**
 * GPU guard vs the TypeScript spec on a uniform full-screen square wave, the
 * spec closed on its own output: the largest difference in displayed
 * luminance on any frame.
 */
function specParity(hz: number): { maxLumDiff: number; frames: number } {
  const state = createFlashGuardState(W, H);
  const taps = { x: state.tapsX, y: state.tapsY };
  const input = createTapFrame(taps);
  const shown = createTapFrame(taps);
  const result: GuardedPixel = { gain: 1, desat: 1 };
  const lowByte = 64;
  const highByte = 200;
  const run = presenterRun(strobe(hz, `rgb(${highByte},${highByte},${highByte})`, `rgb(${lowByte},${lowByte},${lowByte})`), true);
  let maxLumDiff = 0;
  run.frames.forEach((frame, f) => {
    const v = LINEAR[square(hz, f / FPS) ? highByte : lowByte]!;
    input.lum.fill(v);
    input.red.fill(0);
    stepFlashGuard(state, input, f > 0 ? shown : null, 1 / FPS, 1 / (FLASH_GUARD_COLS * FLASH_GUARD_ROWS));
    guardPixel(state, W >> 1, H >> 1, v, v, v, result);
    shown.lum.fill(v * result.gain);
    // Centre pixel of the GPU output vs the spec's.
    const p = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 4;
    const gpu = 0.2126 * LINEAR[frame[p]!]! + 0.7152 * LINEAR[frame[p + 1]!]! + 0.0722 * LINEAR[frame[p + 2]!]!;
    maxLumDiff = Math.max(maxLumDiff, Math.abs(gpu - shown.lum[0]!));
  });
  return { maxLumDiff, frames: run.frames.length };
}

/** Linear-light taps of a readback state.width x state.height inside a W-wide frame, where the GPU puts them. */
function readTaps(frame: Uint8Array, state: FlashGuardState, out: TapFrame): void {
  for (let j = 0; j < state.tapsY; j++) {
    for (let i = 0; i < state.tapsX; i++) {
      const p = (tapY(i, j, state.tapsY, state.height) * W + tapX(i, j, state.tapsX, state.width)) * 4;
      const r = LINEAR_BYTE[frame[p]!]!;
      const g = LINEAR_BYTE[frame[p + 1]!]!;
      const b = LINEAR_BYTE[frame[p + 2]!]!;
      out.lum[j * state.tapsX + i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      out.red[j * state.tapsX + i] = r / (r + g + b + 1e-9) >= 0.8 ? Math.max(0, r - g - b) : 0;
    }
  }
}

/**
 * GPU guard vs the spec on real content, every pixel. The spec runs on the
 * unguarded frames and is fed what the GPU actually showed, so each frame
 * compares the two plans from the same history (closed on its own output the
 * spec would drift on rounding alone). Reports how far the GPU's pixels are
 * from the spec's, in bytes, over the pixels either one changed.
 */
function contentParity(plain: RunResult, guarded: RunResult): { meanByteDiff: number; maxByteDiff: number; over4: number; limitedPixels: number } {
  const state = createFlashGuardState(guarded.width, guarded.height);
  const taps = { x: state.tapsX, y: state.tapsY };
  const input = createTapFrame(taps);
  const shown = createTapFrame(taps);
  const result: GuardedPixel = { gain: 1, desat: 1 };
  const colour = new Float32Array(3);
  let sum = 0;
  let max = 0;
  let over4 = 0;
  let count = 0;
  plain.frames.forEach((frame, f) => {
    readTaps(frame, state, input);
    // The shader loop's first frame is guarded with its nominal interval.
    stepFlashGuard(state, input, f > 0 ? shown : null, f > 0 ? 1 / FPS : 1 / 61, 1 / (FLASH_GUARD_COLS * FLASH_GUARD_ROWS));
    const out = guarded.frames[f]!;
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const p = (y * W + x) * 4;
        const r = LINEAR_BYTE[frame[p]!]!;
        const g = LINEAR_BYTE[frame[p + 1]!]!;
        const b = LINEAR_BYTE[frame[p + 2]!]!;
        guardPixel(state, x, y, r, g, b, result);
        const untouched = result.gain === 1 && result.desat === 1;
        if (!untouched) applyGuard(r, g, b, result, colour);
        let d = 0;
        let changed = !untouched;
        for (let c = 0; c < 3; c++) {
          const expected = untouched ? frame[p + c]! : Math.round(linearToSrgb(colour[c]!) * 255);
          d = Math.max(d, Math.abs(out[p + c]! - expected));
          if (out[p + c] !== frame[p + c]) changed = true;
        }
        if (!changed) continue;
        sum += d;
        max = Math.max(max, d);
        if (d > 4) over4++;
        count++;
      }
    }
    readTaps(out, state, shown);
  });
  return { meanByteDiff: Math.round((sum / Math.max(1, count)) * 1000) / 1000, maxByteDiff: max, over4, limitedPixels: count };
}

/**
 * GPU cost of the guard at a real resolution: batches of Burning Cloud
 * frames closed by a 1-pixel readPixels (which waits for the GPU), with and
 * without the guard, plus the JS time spent inside apply().
 */
function measureCost(width: number, height: number): Record<string, number> {
  const audio = analyse(densePcm(SECONDS));
  const results: Record<string, number> = {};
  for (const guarded of [false, true]) {
    setFlashGuardEnabled(guarded);
    let at = 0;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px`;
    document.body.append(canvas);
    const stop = startShaderVisualizer({
      canvas,
      canvasRef: { current: canvas },
      engine: fakeEngine(audio, () => at % FRAMES) as never,
      mode: 'burning-cloud' as never,
      tuning: { current: { palette: 'theme', reactivity: 'punch' } },
      frameIntervalMs: 1000 / 61,
      dprCap: 1,
      maxPixels: width * height,
    });
    if (!stop) throw new Error('shader visualizer did not start');
    const gl = canvas.getContext('webgl2')!;
    const pixel = new Uint8Array(4);
    const step = () => {
      rafCallback?.(10_000 + (at / FPS) * 1000);
      at++;
    };
    for (let i = 0; i < 30; i++) step();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const batches: number[] = [];
    for (let b = 0; b < 7; b++) {
      const start = performance.now();
      for (let i = 0; i < 24; i++) step();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      batches.push((performance.now() - start) / 24);
    }
    batches.sort((a, b) => a - b);
    results[guarded ? 'guardedMsPerFrame' : 'plainMsPerFrame'] = Math.round(batches[3]! * 1000) / 1000;
    results[`drawingBuffer${guarded ? 'Guarded' : 'Plain'}`] = gl.drawingBufferWidth * gl.drawingBufferHeight;
    stop();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  }
  results.guardMsPerFrame = Math.round((results.guardedMsPerFrame! - results.plainMsPerFrame!) * 1000) / 1000;
  return results;
}

/**
 * The guard alone at a real resolution: a context that only clears (a flash
 * every frame, so the guard does its full work) timed in batches closed by a
 * 1-pixel readPixels, with and without apply(), interleaved; medians of 15.
 */
function measureIsolated(width: number, height: number): { withGuardMs: number; clearOnlyMs: number; guardMs: number } {
  setFlashGuardEnabled(true);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${screen.width}px;height:${screen.height}px`;
  document.body.append(canvas);
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false })!;
  const guard = attachFlashGuard(gl, canvas)!;
  const pixel = new Uint8Array(4);
  let frame = 0;
  const batch = (guarded: boolean): number => {
    const start = performance.now();
    for (let i = 0; i < 24; i++, frame++) {
      gl.clearColor((frame % 2) * 0.8, 0.1, 0.1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (guarded) guard.apply(1000 / 60);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return (performance.now() - start) / 24;
  };
  // Warm up past shader compilation and the GPU's clock ramp.
  for (let b = 0; b < 5; b++) {
    batch(true);
    batch(false);
  }
  const withGuard: number[] = [];
  const clearOnly: number[] = [];
  for (let b = 0; b < 15; b++) {
    withGuard.push(batch(true));
    clearOnly.push(batch(false));
  }
  guard.dispose();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  canvas.remove();
  const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { withGuardMs: round(median(withGuard)), clearOnlyMs: round(median(clearOnly)), guardMs: round(median(withGuard) - median(clearOnly)) };
}

/**
 * JS time inside one apply() call (command submission only), averaged over
 * 200 calls: the page clock is too coarse to time one. The GPU catches up
 * between calls, outside the timing, so a full command queue doesn't count
 * as JS time.
 */
function measureApplyCpu(width: number, height: number): number {
  setFlashGuardEnabled(true);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${screen.width}px;height:${screen.height}px`;
  document.body.append(canvas);
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false })!;
  const guard = attachFlashGuard(gl, canvas)!;
  let total = 0;
  const pixel = new Uint8Array(4);
  for (let i = 0; i < 220; i++) {
    gl.clearColor((i % 2) * 0.8, 0.1, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const start = performance.now();
    guard.apply(1000 / 60);
    if (i >= 20) total += performance.now() - start;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  }
  guard.dispose();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  canvas.remove();
  return Math.round((total / 200) * 1000) / 1000;
}

function summary(run: RunResult) {
  const a = run.analysis;
  return {
    maxConfirmedPerSecond: a.maxConfirmedPerSecond,
    confirmedPairs: a.confirmedPairs.length,
    firstConfirmed: a.confirmedPairs.slice(0, 8).map((p) => `${p.seconds.toFixed(3)}s@${(p.area * 100).toFixed(1)}%`),
    maxFieldPairsPerSecond: a.maxFieldPairsPerSecond,
    maxRegionalPerSecond: a.maxRegionalPerSecond,
    pixelsWith4PairsPerSecond: Math.round(a.general.maxAreaWithAtLeast4PairsPerSecond * 10000) / 100,
    peakPairsAtAnyPixel: a.general.peakPairsAtAnyPixel,
    redPixelsWith4PairsPerSecond: Math.round(a.red.maxAreaWithAtLeast4PairsPerSecond * 10000) / 100,
    peakRedPairsAtAnyPixel: a.red.peakPairsAtAnyPixel,
    meanLuminance: Math.round(a.meanLuminance * 10000) / 10000,
    meanAbsDiff: run.meanAbsDiff == null ? undefined : Math.round(run.meanAbsDiff * 10000) / 10000,
  };
}

/**
 * The checks every guarded run gets against its unguarded twin: no more than
 * three flashes a second at any scale an analyser or the guard looks at, and
 * content with no flashing past two a second at any of them left untouched.
 */
function judge(name: string, plain: RunResult, guarded: RunResult, failures: string[]): void {
  const a = guarded.analysis;
  if (a.maxConfirmedPerSecond > 3) failures.push(`${name}: ${a.maxConfirmedPerSecond} confirmed flashes/s after the guard`);
  if (a.maxFieldPairsPerSecond > 3) failures.push(`${name}: ${a.maxFieldPairsPerSecond} whole-field flashes/s after the guard`);
  if (a.maxRegionalPerSecond > 3) failures.push(`${name}: ${a.maxRegionalPerSecond} flashes/s in a 1% region after the guard`);
  const p = plain.analysis;
  const calm = p.maxRegionalPerSecond <= 2 && p.maxFieldPairsPerSecond <= 2;
  if (calm && (guarded.meanAbsDiff ?? 0) > 0.5) {
    failures.push(`${name}: changed by ${guarded.meanAbsDiff!.toFixed(3)} / 255 with nothing flashing past 2/s to limit`);
  }
}

function rendererName(): string {
  const probe = document.createElement('canvas').getContext('webgl2');
  const info = probe?.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(probe!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : probe ? 'unknown' : 'no WebGL2';
  probe?.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

/**
 * Which guard each output route gets in this browser, found the way the app
 * finds it (the same probes and constructors, on a fullscreen canvas), and
 * whether the guarded route still draws something.
 */
function routeReport(audio: AnalyserFrame[]): Record<string, string> {
  const routes: Record<string, string> = { gpuGuardSupported: String(gpuFlashGuardSupported()) };
  const settle = (canvas: HTMLCanvasElement, gl: WebGL2RenderingContext | null) => {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  };
  {
    const canvas = stageCanvas();
    const stop = startShaderVisualizer({
      canvas,
      canvasRef: { current: canvas },
      engine: fakeEngine(audio, () => 30) as never,
      mode: 'plasma-grid' as never,
      tuning: { current: { palette: 'theme', reactivity: 'punch' } },
      frameIntervalMs: 1000 / 61,
      dprCap: 1,
      maxPixels: W * H,
    });
    routes.shaderLooks = stop ? 'gpu guard' : 'guarded 2D painters (canvas left unbound)';
    stop?.();
    settle(canvas, stop ? canvas.getContext('webgl2') : null);
  }
  {
    const canvas = stageCanvas();
    const renderer = createEvilandRenderer(canvas, { quality: 'low', smoke: true });
    const gl = renderer ? canvas.getContext('webgl2') : null;
    const guard = gl ? attachFlashGuard(gl, canvas) : null;
    routes.eviland = !renderer ? 'no renderer: guarded 2D fallback' : guard ? 'gpu guard' : 'RENDERER WITHOUT GUARD';
    guard?.dispose();
    renderer?.dispose();
    settle(canvas, gl);
  }
  {
    const canvas = stageCanvas();
    const renderer = gpuFlashGuardSupported() ? createParticleFlowRenderer(canvas, { particles: 2000, smoke: true }) : null;
    const gl = renderer ? canvas.getContext('webgl2') : null;
    const guard = gl ? attachFlashGuard(gl, canvas) : null;
    routes.particleFlow = !renderer ? 'guarded 2D fallback' : guard ? 'gpu guard' : 'RENDERER WITHOUT GUARD';
    guard?.dispose();
    renderer?.dispose();
    settle(canvas, gl);
  }
  {
    const canvas = stageCanvas();
    canvas.width = W;
    canvas.height = H;
    let bc: MilkdropVisualizer | null = null;
    try {
      bc = milkdropFactory.createVisualizer(new OfflineAudioContext(1, SR, SR), canvas, { width: W, height: H, meshWidth: 24, meshHeight: 18 });
    } catch {
      bc = null;
    }
    const gl = bc ? canvas.getContext('webgl2') : null;
    const guard = gl ? attachFlashGuard(gl, canvas) : null;
    const live = bc && guard ? createEvilandLivePipeline(bc, 'low') : null;
    // The iframe throws without a guard; the parent then paints its guarded
    // 2D fallback on its own (unbound) canvas.
    routes.milkdropIframe = !bc ? 'no Butterchurn: parent guarded 2D fallback' : guard ? 'gpu guard' : 'no guard: parent guarded 2D fallback';
    routes.evilandLiveIframe = !guard ? routes.milkdropIframe : live ? 'gpu guard (Live pipeline)' : 'gpu guard (plain MilkDrop, Live pipeline refused)';
    live?.dispose();
    guard?.dispose();
    settle(canvas, gl);
  }
  {
    const canvas = stageCanvas();
    const surface = createGuarded2dSurface(canvas, true, true);
    const gl = canvas.getContext('webgl2');
    const paints = !!surface.paint.getContext('2d');
    routes.painters2d = gl ? `gpu guard presenter (paints: ${paints})` : `cpu guard in place (paints: ${paints})`;
    surface.dispose();
    settle(canvas, gl);
  }
  routes.cpuGuard = createCanvasFlashGuard() ? 'available' : 'UNAVAILABLE';
  return routes;
}

/**
 * The reduced sweep for software GL (CI runners, VMs, SwiftShader), where the
 * full one takes far too long: the route report, Burning Cloud on dense
 * music, calm shader looks, one Eviland, MilkDrop and Live run each, the
 * strobes and out-of-step flicker through the presenter and the CPU guard,
 * spec parity, and the guard's cost at the size the low tier renders at.
 * Same checks and limits as the full sweep.
 */
async function reducedRun() {
  const failures: string[] = [];
  const report: Record<string, unknown> = { sweep: 'reduced', gpu: rendererName() };
  const timings: Record<string, number> = {};
  const timed = <T>(name: string, fn: () => T): T => {
    const start = performance.now();
    const result = fn();
    timings[name] = Math.round(performance.now() - start);
    return result;
  };
  const dense = analyse(densePcm(SECONDS));
  const sparse = analyse(sparsePcm(SECONDS));
  report.routes = timed('routes', () => routeReport(dense));

  // 1. Burning Cloud with Punch on dense music, full length.
  const before = timed('burningCloudBefore', () => shaderRun('burning-cloud', dense, false));
  const after = timed('burningCloudAfter', () => shaderRun('burning-cloud', dense, true, before.frames));
  report.burningCloudDense = { before: summary(before), after: summary(after) };
  if (before.analysis.maxConfirmedPerSecond < 4) failures.push(`Burning Cloud dense did not reproduce the hazard before the guard (${before.analysis.maxConfirmedPerSecond}/s)`);
  judge('Burning Cloud dense', before, after, failures);
  report.contentParity = timed('contentParity', () => checkDrift(contentParity(before, after), failures));

  // 2. Calm content: looks that never pass the limit must come through
  // unchanged, whatever the flash counts call calm.
  runFrames = FPS * 4;
  const calm: Record<string, unknown> = {};
  for (const mode of ['plasma-grid', 'starfield-warp']) {
    const plain = timed(`${mode}Plain`, () => shaderRun(mode, sparse, false));
    const guarded = timed(`${mode}Guarded`, () => shaderRun(mode, sparse, true, plain.frames));
    judge(`${mode} sparse`, plain, guarded, failures);
    if (plain.analysis.maxRegionalPerSecond <= 3 && guarded.meanAbsDiff! > 0.5) {
      failures.push(`${mode} sparse: changed by ${guarded.meanAbsDiff!.toFixed(3)} / 255 with nothing over the limit`);
    }
    calm[mode] = { before: summary(plain), after: summary(guarded) };
  }
  report.calm = calm;

  // 3. One run on each of the other GPU routes.
  const routesRun: Record<string, unknown> = {};
  const eviPlain = timed('evilandPlain', () => evilandRun('flash-guard::a', dense, false));
  const eviGuarded = timed('evilandGuarded', () => evilandRun('flash-guard::a', dense, true, eviPlain.frames));
  judge('Eviland dense', eviPlain, eviGuarded, failures);
  routesRun.eviland = { before: summary(eviPlain), after: summary(eviGuarded) };
  const catalog = Object.entries(presetApi.getPresets()).sort(([a], [b]) => a.localeCompare(b));
  const [mdName, mdPreset] = catalog.find(([name]) => name.includes('Storm of the Eye')) ?? catalog[0]!;
  for (const live of [false, true]) {
    const plain = timed(`milkdrop${live ? 'Live' : ''}Plain`, () => milkdropRun(mdPreset, dense, false, live));
    const guarded = timed(`milkdrop${live ? 'Live' : ''}Guarded`, () => milkdropRun(mdPreset, dense, true, live, plain.frames));
    judge(`${live ? 'Eviland Live' : 'MilkDrop'} "${mdName}" dense`, plain, guarded, failures);
    routesRun[live ? 'evilandLive' : 'milkdrop'] = { preset: mdName, before: summary(plain), after: summary(guarded) };
  }
  report.routesRun = routesRun;

  // 4. Strobes: 2 Hz untouched, 8 Hz and red held, both guards.
  const synthetic: Record<string, unknown> = {};
  for (const hz of [2, 8]) {
    const on = 'rgb(200,200,200)';
    const off = 'rgb(20,20,20)';
    const plain = timed(`strobe${hz}Plain`, () => presenterRun(strobe(hz, on, off), false));
    const gpu = timed(`strobe${hz}Presenter`, () => presenterRun(strobe(hz, on, off), true, plain.frames));
    const cpu = timed(`strobe${hz}Cpu`, () => canvasGuardRun(strobe(hz, on, off)));
    synthetic[`${hz}Hz`] = { before: summary(plain), presenter: summary(gpu), canvas2d: summary(cpu) };
    judge(`${hz} Hz strobe via presenter`, plain, gpu, failures);
    if (cpu.analysis.maxFieldPairsPerSecond > 3) failures.push(`${hz} Hz strobe via CPU guard: ${cpu.analysis.maxFieldPairsPerSecond} flashes/s`);
    if (hz === 2 && gpu.meanAbsDiff! > 0.5) failures.push(`2 Hz pulse changed by ${gpu.meanAbsDiff!.toFixed(3)} / 255 through the presenter`);
  }
  const redGpu = timed('red8Presenter', () => presenterRun(strobe(8, 'rgb(230,20,20)', 'rgb(90,90,90)'), true));
  const redCpu = timed('red8Cpu', () => canvasGuardRun(strobe(8, 'rgb(230,20,20)', 'rgb(90,90,90)')));
  synthetic.red8Hz = { presenter: summary(redGpu), canvas2d: summary(redCpu) };
  if (redGpu.analysis.red.peakPairsAtAnyPixel > 3) failures.push(`8 Hz red strobe via presenter: ${redGpu.analysis.red.peakPairsAtAnyPixel} red flashes/s at a pixel`);
  if (redCpu.analysis.red.peakPairsAtAnyPixel > 3) failures.push(`8 Hz red strobe via CPU guard: ${redCpu.analysis.red.peakPairsAtAnyPixel} red flashes/s at a pixel`);
  report.synthetic = synthetic;
  report.dispersed = timed('dispersed', () => dispersedRuns(failures));
  report.lattice = timed('lattice', () => latticeCheck(failures));

  report.specParity = { '8Hz': timed('parity', () => specParity(8)) };
  if ((report.specParity as { '8Hz': { maxLumDiff: number } })['8Hz'].maxLumDiff > 0.01) failures.push('GPU guard differs from the spec at 8Hz');

  // 5. Cost at the low tier's fullscreen budget (1.05 MP at 30 fps) and 1080p.
  report.cost = {
    isolatedLowTier: timed('costIsolatedLow', () => measureIsolated(1366, 768)),
    isolated1080: timed('costIsolated1080', () => measureIsolated(1920, 1080)),
    burningCloudLowTier: timed('costBurningCloudLow', () => measureCost(1366, 768)),
    applyCpuMsLowTier: measureApplyCpu(1366, 768),
  };
  runFrames = FRAMES;
  setFlashGuardEnabled(true);
  report.timingsMs = timings;
  return { failures, ...report };
}

async function run() {
  const failures: string[] = [];
  const dense = analyse(densePcm(SECONDS));
  const sparse = analyse(sparsePcm(SECONDS));
  const report: Record<string, unknown> = { sweep: 'full', gpu: rendererName() };

  // 1. Burning Cloud, Punch, theme accent, dense music: the look that showed
  // the hazard.
  const before = shaderRun('burning-cloud', dense, false);
  const after = shaderRun('burning-cloud', dense, true, before.frames);
  report.burningCloudDense = { before: summary(before), after: summary(after) };
  if (before.analysis.maxConfirmedPerSecond < 4) failures.push(`Burning Cloud dense did not reproduce the hazard before the guard (${before.analysis.maxConfirmedPerSecond}/s)`);
  judge('Burning Cloud dense', before, after, failures);
  report.contentParity = checkDrift(contentParity(before, after), failures);

  // 2. Every shader look, on sparse and on dense music.
  const shaderModes = ['burning-cloud', 'aurora', 'neon-waves', 'neon-ribbons', 'plasma-grid', 'kaleido-bloom', 'liquid-aurora-storm', 'fractal-pulse', 'starfield-warp', 'spectral-tunnel'];
  const shaders: Record<string, unknown> = {};
  for (const mode of shaderModes) {
    const plainSparse = shaderRun(mode, sparse, false);
    const guardedSparse = shaderRun(mode, sparse, true, plainSparse.frames);
    judge(`${mode} sparse`, plainSparse, guardedSparse, failures);
    const entry: Record<string, unknown> = { sparse: { before: summary(plainSparse), after: summary(guardedSparse) } };
    if (mode !== 'burning-cloud') {
      const plainDense = shaderRun(mode, dense, false);
      const guardedDense = shaderRun(mode, dense, true, plainDense.frames);
      judge(`${mode} dense`, plainDense, guardedDense, failures);
      entry.dense = { before: summary(plainDense), after: summary(guardedDense) };
    }
    shaders[mode] = entry;
  }
  report.shaders = shaders;

  // 3. Eviland, on dense and sparse music.
  const eviland: Record<string, unknown> = {};
  for (const seed of ['flash-guard::a', 'flash-guard::b']) {
    const entry: Record<string, unknown> = {};
    for (const [name, audio] of [['dense', dense], ['sparse', sparse]] as const) {
      const plain = evilandRun(seed, audio, false);
      const guarded = evilandRun(seed, audio, true, plain.frames);
      judge(`Eviland ${seed} ${name}`, plain, guarded, failures);
      entry[name] = { before: summary(plain), after: summary(guarded) };
    }
    eviland[seed] = entry;
  }
  report.eviland = eviland;

  // 4. MilkDrop and Eviland Live (the iframe's route), a spread of presets.
  const catalog = Object.entries(presetApi.getPresets()).sort(([a], [b]) => a.localeCompare(b));
  const picks = catalog.filter((_, i) => i % Math.max(1, Math.floor(catalog.length / 8)) === 0).slice(0, 8);
  const milkdrop: Record<string, unknown> = {};
  for (const [name, preset] of picks) {
    const plain = milkdropRun(preset, dense, false, false);
    const guarded = milkdropRun(preset, dense, true, false, plain.frames);
    judge(`MilkDrop "${name}" dense`, plain, guarded, failures);
    milkdrop[name] = { before: summary(plain), after: summary(guarded) };
  }
  for (const [name, preset] of picks.slice(0, 3)) {
    for (const [label, audio] of [['dense', dense], ['sparse', sparse]] as const) {
      const plain = milkdropRun(preset, audio, false, true);
      const guarded = milkdropRun(preset, audio, true, true, plain.frames);
      judge(`Eviland Live "${name}" ${label}`, plain, guarded, failures);
      milkdrop[`live: ${name} (${label})`] = { before: summary(plain), after: summary(guarded) };
    }
  }
  report.milkdrop = milkdrop;

  // 5. Synthetic strobes through the 2D presenter and the CPU guard.
  const synthetic: Record<string, unknown> = {};
  for (const hz of [2, 4, 8, 15]) {
    const on = 'rgb(200,200,200)';
    const off = 'rgb(20,20,20)';
    const plain = presenterRun(strobe(hz, on, off), false);
    const gpu = presenterRun(strobe(hz, on, off), true, plain.frames);
    const cpu = canvasGuardRun(strobe(hz, on, off));
    synthetic[`${hz}Hz`] = { before: summary(plain), presenter: summary(gpu), canvas2d: summary(cpu) };
    judge(`${hz} Hz strobe via presenter`, plain, gpu, failures);
    if (cpu.analysis.maxFieldPairsPerSecond > 3) failures.push(`${hz} Hz strobe via CPU guard: ${cpu.analysis.maxFieldPairsPerSecond} flashes/s`);
    if (hz === 2 && gpu.meanAbsDiff! > 0.5) failures.push(`2 Hz pulse changed by ${gpu.meanAbsDiff!.toFixed(3)} / 255 through the presenter`);
  }
  // Saturated red ↔ grey of the same luminance.
  const redPlain = presenterRun(strobe(8, 'rgb(230,20,20)', 'rgb(90,90,90)'), false);
  const redGpu = presenterRun(strobe(8, 'rgb(230,20,20)', 'rgb(90,90,90)'), true);
  const redCpu = canvasGuardRun(strobe(8, 'rgb(230,20,20)', 'rgb(90,90,90)'));
  synthetic.red8Hz = { before: summary(redPlain), presenter: summary(redGpu), canvas2d: summary(redCpu) };
  const redPeak = (r: RunResult) => r.analysis.red.peakPairsAtAnyPixel;
  if (redPeak(redPlain) <= 3) failures.push(`8 Hz red strobe did not flash red before the guard (${redPeak(redPlain)}/s)`);
  if (redPeak(redGpu) > 3) failures.push(`8 Hz red strobe via presenter: ${redPeak(redGpu)} red flashes/s at a pixel`);
  if (redPeak(redCpu) > 3) failures.push(`8 Hz red strobe via CPU guard: ${redPeak(redCpu)} red flashes/s at a pixel`);
  report.synthetic = synthetic;
  report.dispersed = dispersedRuns(failures);
  report.lattice = latticeCheck(failures);

  // 6. GPU vs spec.
  report.specParity = { '8Hz': specParity(8), '2Hz': specParity(2) };
  for (const [name, parity] of Object.entries(report.specParity as Record<string, { maxLumDiff: number }>)) {
    if (parity.maxLumDiff > 0.01) failures.push(`GPU guard differs from the spec by ${parity.maxLumDiff.toFixed(4)} at ${name}`);
  }

  // 7. Cost at real resolutions.
  report.cost = {
    isolated1080: measureIsolated(1920, 1080),
    isolated2160: measureIsolated(3840, 2160),
    burningCloud1080: measureCost(1920, 1080),
    burningCloud2160: measureCost(3840, 2160),
    applyCpuMs1080: measureApplyCpu(1920, 1080),
  };

  setFlashGuardEnabled(true);
  return { failures, ...report };
}

/** One shader look on dense music, guarded: its counts and worst 1% region. */
async function debug(mode: string) {
  const dense = analyse(densePcm(SECONDS));
  const plain = shaderRun(mode, dense, false);
  const guarded = shaderRun(mode, dense, true, plain.frames);
  setFlashGuardEnabled(true);
  return {
    failures: [],
    mode,
    before: { ...summary(plain), worstRegion: plain.analysis.worstRegion },
    after: { ...summary(guarded), worstRegion: guarded.analysis.worstRegion },
  };
}

(window as unknown as { __flashGuardProbe: () => Promise<unknown> }).__flashGuardProbe = run;
(window as unknown as { __flashGuardReduced: () => Promise<unknown> }).__flashGuardReduced = reducedRun;
(window as unknown as { __flashGuardDebug: (mode: string) => Promise<unknown> }).__flashGuardDebug = debug;
