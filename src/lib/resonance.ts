// Resonance — the live audio drives the whole UI chrome via a few :root CSS
// custom properties. ONE rAF loop, pure math, no per-frame React. Consumers are
// plain CSS on transform/opacity (compositor-only). Self-throttles: it stops
// entirely when paused/hidden/low-tier and eases the vars to zero so the app
// becomes a clean static theme on weak hardware.
//
// Vars written to document.documentElement:
//   --amp-energy  0..1  smoothed overall loudness (slow breath)
//   --amp-beat    0..1  fast kick pulse (attack 1, decay *0.85)
//   --amp-bright  0..1  spectral centroid / tonal brightness (high tier only)
//   --accent-live / --amp-bg1 / --amp-bg2 / --amp-ink-live  per-track art palette

import { engine } from '../store/usePlayerStore';
import { extractAccent } from './albumColor';
import type { QualityTier } from './adaptiveQuality';

export interface ResonanceOpts {
  tier: QualityTier;
  reactive: boolean; // ambientReactivity resolved to a boolean
  reducedMotion: boolean;
}

type OptsGetter = () => ResonanceOpts;

const root = typeof document !== 'undefined' ? document.documentElement : null;

let rafId = 0;
let running = false;
let optsGetter: OptsGetter | null = null;
let engineUnsub: (() => void) | null = null;

const HISTORY = 45; // ~1s of bass-energy history at ~45fps
const hist = new Float32Array(HISTORY);
let histIdx = 0;
let energyEwma = 0;
let brightEwma = 0.5;
let beat = 0;
let lastBeatAt = 0;

let lastEnergyWritten = -1;
let lastBeatWritten = -1;
let lastBrightWritten = -1;

let freqBuf: Uint8Array<ArrayBuffer> | null = null;
let onsetBuf: Uint8Array<ArrayBuffer> | null = null;
let currentTrackId: number | null = null;

function setVar(name: string, value: number, last: number): number {
  if (Math.abs(value - last) < 0.004) return last; // skip redundant DOM writes
  root?.style.setProperty(name, value.toFixed(3));
  return value;
}

function neutralize(): void {
  lastEnergyWritten = setVar('--amp-energy', 0, lastEnergyWritten);
  lastBeatWritten = setVar('--amp-beat', 0, lastBeatWritten);
}

function frame(now: number): void {
  if (!running || !optsGetter) return;
  const opts = optsGetter();
  const state = engine.getState();
  const active =
    opts.reactive &&
    !opts.reducedMotion &&
    opts.tier !== 'low' &&
    state.playing &&
    !(typeof document !== 'undefined' && document.hidden);

  if (!active) {
    energyEwma += (0 - energyEwma) * 0.15;
    beat *= 0.8;
    lastEnergyWritten = setVar('--amp-energy', energyEwma, lastEnergyWritten);
    lastBeatWritten = setVar('--amp-beat', beat, lastBeatWritten);
    if (energyEwma < 0.01 && beat < 0.01) {
      neutralize();
      running = false;
      rafId = 0;
      return; // engine.subscribe / visibilitychange will restart us
    }
    rafId = requestAnimationFrame(frame);
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
  energyEwma += (energy - energyEwma) * 0.1;

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
    beat *= 0.85;
  }
  hist[histIdx] = e;
  histIdx = (histIdx + 1) % HISTORY;

  lastEnergyWritten = setVar('--amp-energy', energyEwma, lastEnergyWritten);
  lastBeatWritten = setVar('--amp-beat', beat, lastBeatWritten);

  // Brightness (tonal mood) only on high tier — it's an extra spectrum pass.
  if (opts.tier === 'high') {
    let mag = 0;
    let weighted = 0;
    for (let i = 0; i < bins; i++) {
      mag += freqBuf[i]!;
      weighted += i * freqBuf[i]!;
    }
    const centroid = mag ? weighted / mag / bins : 0.5;
    brightEwma += (centroid - brightEwma) * 0.05;
    lastBrightWritten = setVar('--amp-bright', brightEwma, lastBrightWritten);
  }

  rafId = requestAnimationFrame(frame);
}

function ensureRunning(): void {
  if (running || !optsGetter) return;
  running = true;
  rafId = requestAnimationFrame(frame);
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

function onVisibility(): void {
  if (typeof document === 'undefined') return;
  if (!document.hidden && engine.getState().playing) ensureRunning();
}

export function startResonance(getOpts: OptsGetter): void {
  optsGetter = getOpts;
  if (!engineUnsub) {
    engineUnsub = engine.subscribe((state) => {
      if (state.trackId !== currentTrackId) {
        currentTrackId = state.trackId ?? null;
        applyAccent(currentTrackId);
      }
      if (state.playing) ensureRunning();
    });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  const st = engine.getState();
  currentTrackId = st.trackId ?? null;
  applyAccent(currentTrackId);
  ensureRunning();
}

// Call after a settings/tier change so a stopped loop re-evaluates and restarts.
export function pokeResonance(): void {
  if (optsGetter) ensureRunning();
}

export function stopResonance(): void {
  optsGetter = null;
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
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
}
