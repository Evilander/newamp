import type { VisualizerPreset } from '@shared/types';
import type { VizPerformance } from '../components/Visualizer';

export const VIZ_AUTO_VJ_KEY = 'newamp:viz:autoVj';

// Auto-VJ dwell preference. Zero preserves the original energy-led 14–30 s.
const VJ_DWELL_KEY = 'newamp:viz:vj-dwell';
const VJ_DWELL_EVENT = 'newamp:vj-dwell';
export const VJ_DWELL_OPTIONS = [
  { seconds: 0, label: 'Auto (14–30 seconds)' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 300, label: '5 minutes' },
] as const;

export function normalizeVjDwell(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(5, Math.min(3600, Math.round(seconds)));
}

export function readVjDwell(): number {
  try { return normalizeVjDwell(Number(window.localStorage.getItem(VJ_DWELL_KEY))); }
  catch { return 0; }
}

export function setVjDwell(seconds: number): void {
  try { window.localStorage.setItem(VJ_DWELL_KEY, String(normalizeVjDwell(seconds))); }
  catch { /* keep the default when storage is unavailable */ }
  window.dispatchEvent(new Event(VJ_DWELL_EVENT));
}

export function watchVjDwell(onChange: (seconds: number) => void): () => void {
  const read = (): void => onChange(readVjDwell());
  const storage = (event: StorageEvent): void => {
    if (event.key === VJ_DWELL_KEY || event.key === null) read();
  };
  window.addEventListener(VJ_DWELL_EVENT, read);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(VJ_DWELL_EVENT, read);
    window.removeEventListener('storage', storage);
  };
}

export function vjSwitchDue(elapsedMs: number, energy: number, dwellSeconds: number): boolean {
  const seconds = normalizeVjDwell(dwellSeconds);
  return seconds ? elapsedMs >= seconds * 1000 : elapsedMs > 14000 && (energy > 0.42 || elapsedMs > 30000);
}

const AUTO_VJ_BALANCED: VisualizerPreset[] = [
  'eviland',
  'particle-flow',
  'kaleido-bloom',
  'liquid-aurora-storm',
  'fractal-pulse',
  'starfield-warp',
  'spectral-tunnel',
  'tempo-pulse',
  'lattice-strobe',
  'liquid-mercury',
  'neon-waves',
  'plasma-grid',
  'orbital-rings',
  'neon-ribbons',
  'burning-cloud',
  'prism-bars',
  'radial',
  'tunnel',
  'galaxy',
  'aurora',
  'confetti',
  'pulse',
  'oscilloscope',
];

const AUTO_VJ_LOW: VisualizerPreset[] = [
  'spectrum',
  'oscilloscope',
  'album-breathe',
  'prism-bars',
  'orbital-rings',
  'pulse',
];

export function pickAutoVjPreset(current: VisualizerPreset, energy: number, perfTier: VizPerformance): VisualizerPreset {
  const pool = perfTier === 'low' ? AUTO_VJ_LOW : AUTO_VJ_BALANCED;
  const currentIndex = Math.max(0, pool.indexOf(current));
  if (energy < 0.12) return 'album-breathe';
  if (energy > 0.68 && perfTier !== 'low') {
    const highEnergy = ['plasma-grid', 'neon-ribbons', 'burning-cloud', 'confetti'] as const;
    return highEnergy[(currentIndex + 1) % highEnergy.length]!;
  }
  return pool[(currentIndex + 1) % pool.length]!;
}

export function vjElapsedMs(now: number, lastSwitchAt: number, lastPickAt = 0): number {
  return now - Math.max(lastSwitchAt, lastPickAt);
}

export function readAutoVj(): boolean {
  try { return window.localStorage.getItem(VIZ_AUTO_VJ_KEY) === '1'; } catch { return false; }
}

export function setAutoVj(enabled: boolean): void {
  try { window.localStorage.setItem(VIZ_AUTO_VJ_KEY, enabled ? '1' : '0'); } catch { /* session only */ }
}
