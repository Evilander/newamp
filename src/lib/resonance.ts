// Resonance — the live audio drives a few UI surfaces via CSS custom
// properties. ONE paced 30 Hz loop, pure math, no per-frame React.
// Self-throttles: it stops entirely when paused/hidden/low-tier and eases the
// vars to zero so the app becomes a clean static theme on weak hardware.
//
// The per-tick vars are written ONLY onto elements marked [data-amp], never
// :root. Custom properties inherit, so a :root write restyles the whole
// document; at display refresh (165 Hz on some monitors) that alone cost most
// of a CPU core with a large library view mounted. Consumers read the vars on
// the tagged element itself or its pseudo-elements.
//
// Per-tick vars (on [data-amp] elements), updated at TICK_MS cadence:
//   --amp-energy  0..1  smoothed overall loudness (slow breath)
//   --amp-beat    0..1  fast kick pulse (attack 1, exponential decay)
//   --amp-b1..b4  0..1  four band levels, bass to treble (the "now playing"
//                       EQ bars; fast attack, slower fall like a meter)
// Per-track vars (on :root, once per track change):
//   --accent-live / --amp-bg1 / --amp-bg2 / --amp-ink-live  art palette

import { engine } from '../store/usePlayerStore';
import { extractAccent } from './albumColor';
import { setFrameMonitorActive, type QualityTier } from './adaptiveQuality';
import { AMBIENT_FRAME_MS, requestPacedFrame } from './pacedFrame';

export interface ResonanceOpts {
  tier: QualityTier;
  reactive: boolean; // ambientReactivity resolved to a boolean
  reducedMotion: boolean;
}

type OptsGetter = () => ResonanceOpts;

const root = typeof document !== 'undefined' ? document.documentElement : null;

let cancelTick: (() => void) | null = null;
let running = false;
let optsGetter: OptsGetter | null = null;
let engineUnsub: (() => void) | null = null;

// Fixed analysis cadence, independent of the display refresh rate. The
// smoothing constants below were tuned per ~45 fps frame; they are applied
// per elapsed time so 60 Hz and 165 Hz monitors behave the same.
const TICK_MS = AMBIENT_FRAME_MS;
const REF_FRAME_MS = 1000 / 45;
const HISTORY = 30; // ~1s of bass-energy history at TICK_MS
const hist = new Float32Array(HISTORY);
let histIdx = 0;
let energyEwma = 0;
let beat = 0;
let lastBeatAt = 0;
let lastTickAt = 0;

let lastEnergyWritten = -1;
let lastBeatWritten = -1;

// Band edges in Hz for --amp-b1..--amp-b4.
const BAND_EDGES = [40, 150, 600, 2500, 10000];
const BAND_VARS = ['--amp-b1', '--amp-b2', '--amp-b3', '--amp-b4'];
const bandLevel = new Float32Array(4);
const bandWritten = new Float32Array(4).fill(-1);

// Elements that consume the per-tick vars. Re-queried every TARGET_REFRESH
// ticks so views mounting/unmounting pick up or drop consumers.
const TARGET_REFRESH = 15;
let targets: HTMLElement[] = [];
let ticksSinceQuery = TARGET_REFRESH;

let freqBuf: Uint8Array<ArrayBuffer> | null = null;
let onsetBuf: Uint8Array<ArrayBuffer> | null = null;
let currentTrackId: number | null = null;

function refreshTargets(): void {
  if (typeof document === 'undefined') return;
  targets = Array.from(document.querySelectorAll<HTMLElement>('[data-amp]'));
  ticksSinceQuery = 0;
  // A freshly mounted consumer has no inline value yet; force the next write.
  lastEnergyWritten = -1;
  lastBeatWritten = -1;
  bandWritten.fill(-1);
}

function setVar(name: string, value: number, last: number): number {
  if (Math.abs(value - last) < 0.01) return last; // skip redundant DOM writes
  const text = value.toFixed(3);
  for (const el of targets) el.style.setProperty(name, text);
  return value;
}

// Per-frame smoothing factor `k` (tuned at REF_FRAME_MS) scaled to `dtMs`.
function decayFor(k: number, dtMs: number): number {
  return Math.pow(k, dtMs / REF_FRAME_MS);
}

function neutralize(): void {
  lastEnergyWritten = setVar('--amp-energy', 0, lastEnergyWritten);
  lastBeatWritten = setVar('--amp-beat', 0, lastBeatWritten);
  bandLevel.fill(0);
  writeBands();
}

function writeBands(): void {
  for (let b = 0; b < 4; b++) bandWritten[b] = setVar(BAND_VARS[b]!, bandLevel[b]!, bandWritten[b]!);
}

function frame(now: number): void {
  cancelTick = null;
  if (!running || !optsGetter) return;
  const dt = lastTickAt ? Math.min(250, now - lastTickAt) : TICK_MS;
  lastTickAt = now;
  if (++ticksSinceQuery >= TARGET_REFRESH) refreshTargets();
  const opts = optsGetter();
  const state = engine.getState();
  const active =
    opts.reactive &&
    !opts.reducedMotion &&
    opts.tier !== 'low' &&
    state.playing &&
    !(typeof document !== 'undefined' && document.hidden);

  if (!active) {
    energyEwma *= decayFor(0.85, dt);
    beat *= decayFor(0.8, dt);
    for (let b = 0; b < 4; b++) bandLevel[b] = bandLevel[b]! * decayFor(0.8, dt);
    lastEnergyWritten = setVar('--amp-energy', energyEwma, lastEnergyWritten);
    lastBeatWritten = setVar('--amp-beat', beat, lastBeatWritten);
    writeBands();
    if (energyEwma < 0.01 && beat < 0.01 && Math.max(...bandLevel) < 0.01) {
      neutralize();
      running = false;
      return; // engine.subscribe / visibilitychange will restart us
    }
    scheduleTick(now);
    return;
  }

  const bins = engine.frequencyBinCount;
  if (!freqBuf || freqBuf.length !== bins) {
    freqBuf = new Uint8Array(new ArrayBuffer(bins));
    onsetBuf = new Uint8Array(new ArrayBuffer(bins));
  }
  // Smoothed spectrum for energy/brightness; unsmoothed onset tap for beats.
  engine.getFreqData(freqBuf!);
  engine.getOnsetFreqData(onsetBuf!);

  // Overall energy (slow breath).
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += freqBuf[i]!;
  const energy = sum / (bins * 255);
  energyEwma += (energy - energyEwma) * (1 - decayFor(0.9, dt));

  // Bass-band onset → beat, with a variance-adaptive threshold + refractory gap.
  const sampleRate = engine.getSampleRate?.() || 44100;
  const binHz = sampleRate / engine.fftSize;
  const loBin = Math.max(1, Math.floor(20 / binHz));
  const hiBin = Math.max(loBin + 1, Math.ceil(150 / binHz));
  const onset = onsetBuf!;
  let e = 0;
  for (let i = loBin; i <= hiBin; i++) e += onset[i]! * onset[i]!;
  e /= hiBin - loBin + 1;
  let avg = 0;
  for (let i = 0; i < HISTORY; i++) avg += hist[i]!;
  avg /= HISTORY;
  let varc = 0;
  for (let i = 0; i < HISTORY; i++) {
    const d = hist[i]! - avg;
    varc += d * d;
  }
  varc /= HISTORY;
  const c = Math.max(1.05, Math.min(2.2, -0.0025714 * varc + 1.5142857));
  if (e > c * avg && avg > 0 && now - lastBeatAt > 140) {
    beat = 1;
    lastBeatAt = now;
  } else {
    beat *= decayFor(0.85, dt);
  }
  hist[histIdx] = e;
  histIdx = (histIdx + 1) % HISTORY;

  lastEnergyWritten = setVar('--amp-energy', energyEwma, lastEnergyWritten);
  lastBeatWritten = setVar('--amp-beat', beat, lastBeatWritten);

  // Four band meters. The analyser bytes are already dB-scaled (-86..-10 dBFS),
  // so a linear window over them reads like a level meter.
  for (let b = 0; b < 4; b++) {
    const lo = Math.max(1, Math.floor(BAND_EDGES[b]! / binHz));
    const hi = Math.min(bins - 1, Math.max(lo, Math.ceil(BAND_EDGES[b + 1]! / binHz)));
    let bandSum = 0;
    for (let i = lo; i <= hi; i++) bandSum += freqBuf[i]!;
    const level = Math.max(0, Math.min(1, (bandSum / ((hi - lo + 1) * 255) - 0.3) / 0.55));
    const cur = bandLevel[b]!;
    bandLevel[b] = level > cur ? cur + (level - cur) * 0.7 : cur + (level - cur) * (1 - decayFor(0.82, dt));
  }
  writeBands();

  scheduleTick(now);
}

function scheduleTick(frameStart: number): void {
  const spent = performance.now() - frameStart;
  cancelTick = requestPacedFrame(frame, Math.max(0, TICK_MS - spent), true);
}

function ensureRunning(): void {
  if (running || !optsGetter) return;
  running = true;
  lastTickAt = 0;
  ticksSinceQuery = TARGET_REFRESH;
  cancelTick = requestPacedFrame(frame, 0);
}

function applyAccent(trackId: number | null): void {
  if (!root || !trackId) return;
  const url = `newart://track/${trackId}/art`;
  const idle: (cb: () => void) => void =
    typeof window !== 'undefined' &&
    (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
      ? (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback
      : (cb) => setTimeout(cb, 200);
  idle(() => {
    void extractAccent(url)
      .then((pal) => {
        if (!pal) return;
        if (engine.getState().trackId !== trackId) return; // track changed; stale
        root.style.setProperty('--accent-live', pal.accent);
        root.style.setProperty('--amp-bg1', pal.bg1);
        root.style.setProperty('--amp-bg2', pal.bg2);
        root.style.setProperty('--amp-ink-live', pal.ink);
        root.dataset.ampAccent = 'on';
      })
      // extractAccent never rejects today, but harden the fire-and-forget so a
      // future change can't surface as an unhandled rejection in an idle callback.
      .catch(() => undefined);
  });
}

// The adaptive-tier frame monitor only matters while the UI could be reacting.
function syncFrameMonitor(playing: boolean): void {
  setFrameMonitorActive(playing && !(typeof document !== 'undefined' && document.hidden));
}

function onVisibility(): void {
  if (typeof document === 'undefined') return;
  const playing = engine.getState().playing;
  syncFrameMonitor(playing);
  if (!document.hidden && playing) ensureRunning();
}

export function startResonance(getOpts: OptsGetter): void {
  optsGetter = getOpts;
  if (!engineUnsub) {
    engineUnsub = engine.subscribe((state) => {
      if (state.trackId !== currentTrackId) {
        currentTrackId = state.trackId ?? null;
        applyAccent(currentTrackId);
      }
      syncFrameMonitor(state.playing);
      if (state.playing) ensureRunning();
    });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  const st = engine.getState();
  currentTrackId = st.trackId ?? null;
  applyAccent(currentTrackId);
  syncFrameMonitor(st.playing);
  ensureRunning();
}

// Call after a settings/tier change so a stopped loop re-evaluates and restarts.
export function pokeResonance(): void {
  if (optsGetter) ensureRunning();
}

export function stopResonance(): void {
  optsGetter = null;
  setFrameMonitorActive(false);
  running = false;
  cancelTick?.();
  cancelTick = null;
  if (engineUnsub) {
    engineUnsub();
    engineUnsub = null;
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
  }
  if (root) {
    delete root.dataset.ampAccent;
  }
  neutralize();
  targets = [];
}
