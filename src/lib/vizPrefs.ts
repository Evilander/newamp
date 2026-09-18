// Visualizer preference readers shared across code-split boundaries.
//
// The fullscreen visualizer owns these localStorage keys (its toolbar writes
// them); the headless Eviland producer ALSO needs them to pick the detached
// projector's render tier, and it lives in the eagerly-loaded App bundle
// while FullscreenVisualizer is lazy — so the keys + derivation live here.

import type { EvilandPaletteMode, EvilandReactivity } from '../visualizer/eviland-appearance';

export const VIZ_QUALITY_KEY = 'newamp:viz:quality';
export const VIZ_PERFORMANCE_KEY = 'newamp:viz:performance';
export const VIZ_PALETTE_KEY = 'newamp:viz:palette';
export const VIZ_REACTIVITY_KEY = 'newamp:viz:reactivity';
export const VIZ_LOOKAHEAD_KEY = 'newamp:viz:lookahead';

/**
 * Eviland look-ahead (song scores). On unless the user turned it off: it
 * costs a one-off 1–2 s analysis per track, which is theirs to decline.
 */
export function lookAheadEnabled(): boolean {
  try {
    return window.localStorage.getItem(VIZ_LOOKAHEAD_KEY) !== 'off';
  } catch {
    return true;
  }
}

export type ProjectorQuality = 'high' | 'medium' | 'low';

/**
 * Detached-projector render tier, derived from the user's visualizer prefs:
 * 'low' perf → 'low' (no scene overlay, DPR 1); 4K opt-in → 'high' (accent
 * scene + full DPR — the user has GPU headroom and said so); everyone else →
 * 'medium'. The projector previously ran hardcoded 'high' for every user,
 * which is exactly why it "suffered mightily" on single-GPU setups running
 * both windows at once.
 */
export function projectorQualityTier(): ProjectorQuality {
  if (typeof window === 'undefined') return 'medium';
  try {
    if (window.localStorage.getItem(VIZ_PERFORMANCE_KEY) === 'low') return 'low';
    return window.localStorage.getItem(VIZ_QUALITY_KEY) === '4k' ? 'high' : 'medium';
  } catch {
    return 'medium';
  }
}

/**
 * The toolbar's palette + reactivity choices, for the headless producer: the
 * detached projector has no toolbar state of its own, so without this it
 * ignored both controls.
 */
export function readEvilandTuning(): { palette: EvilandPaletteMode; reactivity: EvilandReactivity } {
  try {
    const palette = window.localStorage.getItem(VIZ_PALETTE_KEY);
    const reactivity = window.localStorage.getItem(VIZ_REACTIVITY_KEY);
    return {
      palette:
        palette === 'phosphor' || palette === 'ice' || palette === 'sunset' || palette === 'rainbow' ? palette : 'theme',
      reactivity: reactivity === 'truth' || reactivity === 'wild' ? reactivity : 'punch',
    };
  } catch {
    return { palette: 'theme', reactivity: 'punch' };
  }
}
