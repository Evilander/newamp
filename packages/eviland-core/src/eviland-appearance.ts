import type { EvilandFrame } from './eviland-audio';
import type { PaletteConfig, RGB } from './eviland-operators';

export type EvilandPaletteMode = 'theme' | 'phosphor' | 'ice' | 'sunset' | 'rainbow';
export type EvilandReactivity = 'truth' | 'punch' | 'wild';

// The last key-shifted theme palette. The shift only moves for a couple of
// seconds after a modulation; the rest of the time this is a cache hit and
// resolving the palette allocates nothing.
let shiftedFrom: PaletteConfig | null = null;
let shiftedBy = 0;
let shifted: PaletteConfig | null = null;

/** Rotate a colour's hue about the grey axis by `turns` (1 = full circle); brightness is kept. */
function rotateHue(rgb: RGB, turns: number): RGB {
  const angle = turns * Math.PI * 2;
  const c = Math.cos(angle);
  const s = Math.sin(angle) / Math.sqrt(3);
  const k = (1 - c) / 3;
  const [r, g, b] = rgb;
  return [
    Math.max(0, r * (c + k) + g * (k - s) + b * (k + s)),
    Math.max(0, r * (k + s) + g * (c + k) + b * (k - s)),
    Math.max(0, r * (k - s) + g * (k + s) + b * (c + k)),
  ];
}

/**
 * Resolve once for the complete image, before any source is drawn.
 *
 * `keyShift` (turns, from the song score) rotates the palette when the music
 * modulates away from its home key. It applies to 'theme' and 'rainbow' only:
 * a palette the user picked by name stays exactly that palette.
 */
export function resolveEvilandPalette(mode: EvilandPaletteMode, theme: PaletteConfig, seconds = 0, keyShift = 0): PaletteConfig {
  if (mode === 'theme') {
    const turns = Math.round(keyShift * 720) / 720;
    if (turns === 0) return theme;
    if (shifted && shiftedFrom === theme && shiftedBy === turns) return shifted;
    shiftedFrom = theme;
    shiftedBy = turns;
    shifted = { bg: theme.bg, dark: rotateHue(theme.dark, turns), accent: rotateHue(theme.accent, turns), light: rotateHue(theme.light, turns) };
    return shifted;
  }
  if (mode === 'phosphor') return { bg: [0.002, 0.01, 0.004], dark: [0.02, 0.22, 0.06], accent: [0.2, 1, 0.35], light: [0.62, 1, 0.7] };
  if (mode === 'ice') return { bg: [0.003, 0.008, 0.025], dark: [0.03, 0.15, 0.45], accent: [0.1, 0.68, 1], light: [0.55, 0.95, 1] };
  if (mode === 'sunset') return { bg: [0.018, 0.002, 0.012], dark: [0.45, 0.03, 0.22], accent: [1, 0.12, 0.24], light: [1, 0.68, 0.16] };
  const hue = (offset: number): RGB => [0, 1, 2].map(i =>
    0.12 + 0.88 * Math.max(0, Math.cos((seconds * 0.035 + keyShift + offset - i / 3) * Math.PI * 2)),
  ) as RGB;
  return { bg: [0.006, 0.004, 0.012], dark: hue(0.66).map(c => c * 0.35) as RGB, accent: hue(0), light: hue(0.25) };
}

/**
 * How firmly Eviland Live's final image is pulled onto the resolved palette.
 * A palette the user picked by name owns the picture outright. 'theme' (skin +
 * album art) leaves part of the MilkDrop preset's own hue variation in, and
 * 'rainbow' leaves most of it — its whole point is colour travel.
 */
export function liveGradeFor(mode: EvilandPaletteMode): number {
  if (mode === 'theme') return 0.72;
  if (mode === 'rainbow') return 0.45;
  return 1;
}

/** Tune visual amplitude without changing band classification, tempo or sections. */
export function tuneEvilandFrame(frame: EvilandFrame, mode: EvilandReactivity): EvilandFrame {
  if (mode === 'truth') return frame;
  const gain = mode === 'wild' ? 1.85 : 1.35;
  const curve = mode === 'wild' ? 0.72 : 0.86;
  const amp = (v: number): number => Math.min(1, Math.pow(Math.max(0, v), curve) * gain);
  return {
    ...frame, bands: frame.bands.map(amp),
    onsets: frame.onsets.map(o => ({ ...o, intensity: amp(o.intensity) })),
    energy: amp(frame.energy), kick: amp(frame.kick), bass: amp(frame.bass),
    snare: amp(frame.snare), hat: amp(frame.hat), vocal: amp(frame.vocal),
  };
}
