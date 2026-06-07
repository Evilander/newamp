// One honest adaptive quality tier — self-contained, no "pressure" abstractions.
// A static hardware prior (cores / memory / GPU string) sets a baseline; a tiny
// rAF-delta EWMA monitor downgrades live when frames are genuinely dropping.
// Everything reactive (Resonance, future visualizer tiers) reads this.

import { useSyncExternalStore } from 'react';

export type QualityTier = 'high' | 'medium' | 'low';
export type PerformanceSetting = 'auto' | 'high' | 'lite';

// --- static hardware prior (computed once) -----------------------------------

let staticTier: QualityTier | null = null;

function readGpuRenderer(): string | undefined {
  try {
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return undefined;
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
  const gpu = (readGpuRenderer() ?? '').toLowerCase();
  const softwareRenderer = /swiftshader|llvmpipe|software/.test(gpu);

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

// --- live frame-budget monitor (one rAF loop, pure math) ---------------------

let liveDowngrade: QualityTier | null = null; // null = no live downgrade
let ewma = 16.7;
let lastTs = 0;
let monitorRunning = false;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

function tick(now: number): void {
  if (!monitorRunning) return;
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
  requestAnimationFrame(tick);
}

function ensureMonitor(): void {
  if (monitorRunning || typeof requestAnimationFrame === 'undefined') return;
  monitorRunning = true;
  lastTs = 0;
  requestAnimationFrame(tick);
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
  ensureMonitor();
  return () => {
    subscribers.delete(cb);
    // Stop the rAF monitor when the last consumer leaves — `tick` bails on its
    // next frame because it checks `monitorRunning` up top. Without this the
    // frame-budget loop ran forever (one wasted rAF/frame for the app's life).
    if (subscribers.size === 0) monitorRunning = false;
  };
}

export function useAdaptiveQuality(setting: PerformanceSetting = 'auto'): QualityTier {
  return useSyncExternalStore(
    subscribe,
    () => getAdaptiveTier(setting),
    () => (setting === 'high' ? 'high' : setting === 'lite' ? 'low' : 'medium'),
  );
}
