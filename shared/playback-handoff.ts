import { isShuffleMode, repeatModeOf, type PlaybackMode } from './types.js';

export interface HandoffIndexInput {
  queueLength: number;
  index: number;
  mode: PlaybackMode;
}

export interface HandoffDecisionInput extends HandoffIndexInput {
  playing: boolean;
  duration: number;
  currentTime: number;
  crossfadeMs: number;
  currentTrackId: number | null;
  lastHandoffKey: string | null;
}

export function nextHandoffIndex(input: HandoffIndexInput): number | null {
  const queueLength = Math.trunc(Number(input.queueLength) || 0);
  const index = Math.trunc(Number(input.index) || 0);
  if (queueLength <= 1 || index < 0 || isShuffleMode(input.mode) || repeatModeOf(input.mode) === 'one') return null;
  if (repeatModeOf(input.mode) === 'all' && index >= queueLength - 1) return 0;
  if (index >= queueLength - 1) return null;
  return index + 1;
}

/**
 * Whether a handoff has ANY valid target from this position — true whenever
 * nextHandoffIndex resolves one (sequential advance, or repeat-all wrapping
 * to 0), and also true for shuffle once the queue has more than one track
 * and repeat-one is not holding on the current track (shuffle always finds
 * a candidate: smart-shuffle resets and reuses the bag once exhausted).
 *
 * nextHandoffIndex itself stays shuffle-blind on purpose — a specific
 * shuffle pick needs RNG and play history that do not belong in this pure
 * module, so that lives in the store (see shared/shuffle-handoff.ts). This
 * only answers "is a handoff possible", which
 * shouldStartTrackHandoff/shouldPrepareTrackHandoff need regardless of who
 * ends up choosing the index.
 */
export function hasHandoffTarget(input: HandoffIndexInput): boolean {
  if (nextHandoffIndex(input) != null) return true;
  const queueLength = Math.trunc(Number(input.queueLength) || 0);
  const index = Math.trunc(Number(input.index) || 0);
  return queueLength > 1 && index >= 0 && isShuffleMode(input.mode) && repeatModeOf(input.mode) !== 'one';
}

export function shouldStartTrackHandoff(input: HandoffDecisionInput): boolean {
  if (!input.playing || input.currentTrackId == null) return false;
  if (!Number.isFinite(input.duration) || input.duration <= 0) return false;
  if (!Number.isFinite(input.currentTime) || input.currentTime <= 0) return false;
  const crossfadeMs = Math.max(0, Math.round(input.crossfadeMs));
  if (crossfadeMs <= 0) return false;
  if (!hasHandoffTarget(input)) return false;
  const key = handoffKey(input.currentTrackId, input.index);
  if (input.lastHandoffKey === key) return false;
  const windowSeconds = Math.max(0.25, Math.min(12, crossfadeMs / 1000));
  const remaining = input.duration - input.currentTime;
  return remaining > 0 && remaining <= windowSeconds;
}

export function shouldPrepareTrackHandoff(input: HandoffDecisionInput): boolean {
  if (!input.playing || input.currentTrackId == null) return false;
  if (!Number.isFinite(input.duration) || input.duration <= 0) return false;
  if (!Number.isFinite(input.currentTime) || input.currentTime <= 0) return false;
  if (Math.max(0, Math.round(input.crossfadeMs)) > 0) return false;
  if (!hasHandoffTarget(input)) return false;
  const key = handoffKey(input.currentTrackId, input.index);
  if (input.lastHandoffKey === key) return false;
  const remaining = input.duration - input.currentTime;
  return remaining > 0 && remaining <= 10;
}

export function handoffKey(trackId: number, index: number): string {
  return `${trackId}:${index}`;
}
