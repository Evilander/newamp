import type { VisualizerPreset } from '@shared/types';

// Preset registry. `group` drives the labeled sections in the new preset
// picker popover so users can scan by category instead of one long rail. The
// five `crazy` entries are the GPU shader modes added in 1.6.2 (the type
// union + dispatch live in Visualizer.tsx; this file only labels them).
export const PRESETS = [
  { id: 'eviland-live', label: 'Eviland Live', group: 'milkdrop' },
  { id: 'butterchurn', label: 'Milkdrop', group: 'milkdrop' },
  { id: 'eviland', label: 'Eviland', group: 'gpu' },
  { id: 'kaleido-bloom', label: 'Kaleido Bloom', group: 'crazy' },
  { id: 'liquid-aurora-storm', label: 'Aurora Storm', group: 'crazy' },
  { id: 'fractal-pulse', label: 'Fractal Pulse', group: 'crazy' },
  { id: 'starfield-warp', label: 'Starfield Warp', group: 'crazy' },
  { id: 'spectral-tunnel', label: 'Spectral Tunnel', group: 'crazy' },
  { id: 'particle-flow', label: 'Particle Flow', group: 'gpu' },
  { id: 'tempo-pulse', label: 'Tempo Pulse', group: 'reactive' },
  { id: 'lattice-strobe', label: 'Lattice Strobe', group: 'reactive' },
  { id: 'liquid-mercury', label: 'Liquid Mercury', group: 'reactive' },
  { id: 'neon-waves', label: 'Neon Waves', group: 'reactive' },
  { id: 'neon-ribbons', label: 'Neon Ribbons', group: 'reactive' },
  { id: 'plasma-grid', label: 'Plasma Grid', group: 'reactive' },
  { id: 'prism-bars', label: 'Prism Bars', group: 'reactive' },
  { id: 'confetti', label: 'Confetti', group: 'reactive' },
  { id: 'burning-cloud', label: 'Burning Cloud', group: 'reactive' },
  { id: 'spectrum', label: 'Spectrum', group: 'classic' },
  { id: 'orbital-rings', label: 'Orbital Rings', group: 'classic' },
  { id: 'radial', label: 'Radial', group: 'classic' },
  { id: 'tunnel', label: 'Tunnel', group: 'classic' },
  { id: 'pulse', label: 'Pulse', group: 'classic' },
  { id: 'galaxy', label: 'Galaxy', group: 'classic' },
  { id: 'aurora', label: 'Aurora', group: 'classic' },
  { id: 'oscilloscope', label: 'Oscilloscope', group: 'classic' },
  { id: 'album-breathe', label: 'Album Breathe', group: 'art' },
] as const satisfies ReadonlyArray<{ id: VisualizerPreset; label: string; group: PresetGroup }>;

type PresetGroup = 'milkdrop' | 'crazy' | 'gpu' | 'reactive' | 'classic' | 'art';
export const PRESET_GROUPS: ReadonlyArray<{ id: PresetGroup; label: string }> = [
  { id: 'milkdrop', label: 'Milkdrop' },
  { id: 'crazy', label: 'Shaders' },
  { id: 'gpu', label: 'GPU particles' },
  { id: 'reactive', label: 'Reactive' },
  { id: 'classic', label: 'Classic' },
  { id: 'art', label: 'Album art' },
];

