export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 1.5;
export const PLAYBACK_RATE_STEP = 0.05;

export function normalizePlaybackRate(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const stepped = Math.round(value / PLAYBACK_RATE_STEP) * PLAYBACK_RATE_STEP;
  return round2(Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, stepped)));
}

export function nudgePlaybackRate(current: number, direction: -1 | 1): number {
  return normalizePlaybackRate(current + direction * PLAYBACK_RATE_STEP);
}

export function playbackRateLabel(value: number): string {
  return `${normalizePlaybackRate(value).toFixed(2)}x`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
