// Visualizer preference readers shared across code-split boundaries.
//
// The fullscreen visualizer owns these localStorage keys (its toolbar writes
// them); the headless Eviland producer ALSO needs them to pick the detached
// projector's render tier, and it lives in the eagerly-loaded App bundle
// while FullscreenVisualizer is lazy — so the keys + derivation live here.

export const VIZ_QUALITY_KEY = 'newamp:viz:quality';
export const VIZ_PERFORMANCE_KEY = 'newamp:viz:performance';

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
