// One honest adaptive quality tier — self-contained, no "pressure" abstractions.
// A static hardware prior (cores / memory / GPU string) sets a baseline; a tiny
// rAF-delta EWMA monitor downgrades live when frames are genuinely dropping.
// Everything reactive (Resonance, future visualizer tiers) reads this.

import { useSyncExternalStore } from 'react';
import { api } from './api';

export type QualityTier = 'high' | 'medium' | 'low';
export type PerformanceSetting = 'auto' | 'high' | 'lite';

// --- static hardware prior (computed once) -----------------------------------

let staticTier: QualityTier | null = null;
// Reported by the main process once the GPU process is up (see main.ts
// publishGpuCompositing); the WebGL renderer string alone misses the case
// where WebGL still runs on the GPU but the window is composited in software.
let softwareCompositing = false;
let compositingWatched = false;

function watchCompositing(): void {
  if (compositingWatched) return;
  compositingWatched = true;
  const apply = (enabled: boolean | null) => {
    if (enabled === null || !enabled === softwareCompositing) return;
    softwareCompositing = !enabled;
    staticTier = null;
    notify();
  };
  void api.getGpuCompositing().then(apply, () => undefined);
  api.onGpuCompositing(apply);
}

// null = no WebGL context at all, which on Linux usually means Chromium
// blocklisted the GPU driver and the whole page is software-composited.
// undefined = a context exists but the renderer string is hidden.
function readGpuRenderer(): string | null | undefined {
  try {
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (!dbg) return undefined;
    return gl.getParameter((dbg as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL) as string;
  } catch {
    return undefined;
  }
}

function computeStaticTier(): QualityTier {
  if (staticTier) return staticTier;
  const nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined;
  const cores = nav?.hardwareConcurrency ?? 4;
  const mem = (nav as unknown as { deviceMemory?: number } | undefined)?.deviceMemory ?? 4;
  const renderer = readGpuRenderer();
  const gpu = (renderer ?? '').toLowerCase();
  // Software compositing is the strongest signal: Electron reports it directly.
  // The WebGL renderer string catches the rest (Mesa llvmpipe/softpipe,
  // SwiftShader, Windows' "Basic Render Driver").
  const softwareRenderer =
    softwareCompositing ||
    renderer === null ||
    /swiftshader|llvmpipe|softpipe|basic render driver|software/.test(gpu);

  // Start neutral; adjust on real signals (buckets, never exact values — both
  // hardwareConcurrency and deviceMemory are privacy-coarsened).
  let score = 2;
  if (cores >= 8) score += 2;
  else if (cores <= 2) score -= 2;
  if (mem >= 8) score += 1;
  else if (mem <= 2) score -= 2;
  if (softwareRenderer) score -= 4;

  staticTier = softwareRenderer ? 'low' : score >= 4 ? 'high' : score >= 1 ? 'medium' : 'low';
  return staticTier;
}

// --- live frame-budget monitor (sampled rAF deltas, pure math) ----------------
// Only armed while something that depends on the tier could be animating
// (Resonance arms it during visible playback). While armed it samples frame
// timing in short bursts: a continuous rAF loop keeps the renderer producing
// frames at display refresh (165 Hz on some monitors) for as long as it runs.

const SAMPLE_MS = 1000;
const REST_MS = 9000;

let liveDowngrade: QualityTier | null = null; // null = no live downgrade
let ewma = 16.7;
let lastTs = 0;
let burstStart = 0;
let monitorRunning = false;
let restTimer = 0;
let rafId = 0;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

function tick(now: number): void {
  rafId = 0;
  if (!monitorRunning) return;
  if (!burstStart) burstStart = now;
  if (lastTs > 0) {
    const dt = now - lastTs;
    if (dt < 100) ewma += (dt - ewma) * 0.1; // reject tab-throttle / breakpoint spikes
  }
  lastTs = now;
  // Hysteresis: only two coarse states so it doesn't oscillate. ≥28ms (~36fps)
  // sustained → force low; ≥20ms (~50fps) → cap medium; else clear.
  const next: QualityTier | null = ewma >= 28 ? 'low' : ewma >= 20 ? 'medium' : null;
  if (next !== liveDowngrade) {
    liveDowngrade = next;
    notify();
  }
  if (now - burstStart < SAMPLE_MS) {
    rafId = requestAnimationFrame(tick);
    return;
  }
  restTimer = window.setTimeout(startBurst, REST_MS);
}

function startBurst(): void {
  restTimer = 0;
  if (!monitorRunning) return;
  lastTs = 0; // the rest gap is not a frame
  burstStart = 0;
  rafId = requestAnimationFrame(tick);
}

export function setFrameMonitorActive(active: boolean): void {
  if (!active) {
    monitorRunning = false;
    if (restTimer) window.clearTimeout(restTimer);
    if (rafId) cancelAnimationFrame(rafId);
    restTimer = 0;
    rafId = 0;
    return;
  }
  if (monitorRunning || typeof requestAnimationFrame === 'undefined') return;
  monitorRunning = true;
  startBurst();
}

function clampTier(base: QualityTier, cap: QualityTier | null): QualityTier {
  if (!cap) return base;
  const order: QualityTier[] = ['low', 'medium', 'high'];
  return order[Math.min(order.indexOf(base), order.indexOf(cap))]!;
}

export function getAdaptiveTier(setting: PerformanceSetting = 'auto'): QualityTier {
  if (setting === 'high') return 'high';
  if (setting === 'lite') return 'low';
  return clampTier(computeStaticTier(), liveDowngrade);
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  watchCompositing();
  return () => {
    subscribers.delete(cb);
  };
}

export function useAdaptiveQuality(setting: PerformanceSetting = 'auto'): QualityTier {
  return useSyncExternalStore(
    subscribe,
    () => getAdaptiveTier(setting),
    () => (setting === 'high' ? 'high' : setting === 'lite' ? 'low' : 'medium'),
  );
}
