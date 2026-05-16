import type { PlaybackMode } from './types.js';

export interface PlaybackErrorAdvanceInput {
  error: string | null;
  currentTrackId: number | null;
  index: number;
  queueLength: number;
  mode: PlaybackMode;
  lastErrorKey: string | null;
}

export interface PlaybackErrorAdvanceDecision {
  key: string | null;
  shouldAdvance: boolean;
  shouldStop: boolean;
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
  if (index < queueLength - 1) return { key, shouldAdvance: true, shouldStop: false };
  if (input.mode === 'repeat-all' || input.mode === 'repeat-one' || input.mode === 'shuffle') {
    return { key, shouldAdvance: true, shouldStop: false };
  }
  return { key, shouldAdvance: false, shouldStop: true };
}
