import { isShuffleMode, repeatModeOf, type PlaybackMode } from './types.js';

/**
 * With a drive or server offline every queued track fails the same way, and
 * repeat-all or shuffle would otherwise skip through them forever.
 */
export const MAX_CONSECUTIVE_PLAYBACK_FAILURES = 8;

export interface PlaybackErrorAdvanceInput {
  error: string | null;
  currentTrackId: number | null;
  index: number;
  queueLength: number;
  mode: PlaybackMode;
  lastErrorKey: string | null;
  /** Shuffle with repeat off plays each track once; a finished cycle ends the queue. */
  shuffleCycleComplete?: boolean;
  /** Failures in a row before this one; the caller resets it once a track plays. */
  consecutiveFailures?: number;
}

export interface PlaybackErrorAdvanceDecision {
  key: string | null;
  shouldAdvance: boolean;
  shouldStop: boolean;
  /** Set only when the run of failures hit the limit and playback gave up. */
  gaveUp?: true;
}

export function playbackFailureLimit(queueLength: number): number {
  const length = Math.trunc(Number(queueLength));
  if (!Number.isFinite(length) || length < 1) return 1;
  return Math.min(length, MAX_CONSECUTIVE_PLAYBACK_FAILURES);
}

export function playbackErrorKey(input: {
  error: string | null;
  currentTrackId: number | null;
  index: number;
}): string | null {
  const trackId = Math.trunc(Number(input.currentTrackId));
  const index = Math.trunc(Number(input.index));
  const error = String(input.error ?? '').trim();
  if (!Number.isFinite(trackId) || trackId === 0 || !Number.isFinite(index) || index < 0 || !error) {
    return null;
  }
  return `${trackId}:${index}:${error.slice(0, 160)}`;
}

export function resolvePlaybackErrorAdvance(input: PlaybackErrorAdvanceInput): PlaybackErrorAdvanceDecision {
  const key = playbackErrorKey({
    error: input.error,
    currentTrackId: input.currentTrackId,
    index: input.index,
  });
  if (!key || key === input.lastErrorKey) {
    return { key, shouldAdvance: false, shouldStop: false };
  }

  const queueLength = Math.trunc(Number(input.queueLength));
  const index = Math.trunc(Number(input.index));
  if (!Number.isFinite(queueLength) || queueLength <= 0 || !Number.isFinite(index) || index < 0) {
    return { key, shouldAdvance: false, shouldStop: true };
  }
  if (queueLength === 1) return { key, shouldAdvance: false, shouldStop: true };
  const failuresInARow = Math.max(0, Math.trunc(Number(input.consecutiveFailures) || 0)) + 1;
  if (failuresInARow >= playbackFailureLimit(queueLength)) {
    return { key, shouldAdvance: false, shouldStop: true, gaveUp: true };
  }
  if (
    isShuffleMode(input.mode) &&
    repeatModeOf(input.mode) === 'off' &&
    input.shuffleCycleComplete === true
  ) {
    return { key, shouldAdvance: false, shouldStop: true };
  }
  if (index < queueLength - 1) return { key, shouldAdvance: true, shouldStop: false };
  // Any mode other than plain 'normal' (repeat-one/-all, shuffle, or a
  // shuffle+repeat combo) keeps playing past the end of the queue.
  if (input.mode !== 'normal') {
    return { key, shouldAdvance: true, shouldStop: false };
  }
  return { key, shouldAdvance: false, shouldStop: true };
}
