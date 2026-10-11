import type { Track } from './types.js';

export interface QueueInsertResult {
  queue: Track[];
  index: number;
}

export function insertTrackNext(
  queue: Track[],
  currentIndex: number,
  track: Track,
): QueueInsertResult {
  return insertTracksNext(queue, currentIndex, [track]);
}

export function insertTracksNext(
  queue: Track[],
  currentIndex: number,
  tracks: Track[],
): QueueInsertResult {
  const normalizedIndex = normalizeCurrentIndex(currentIndex, queue.length);
  if (!tracks.length) return { queue: [...queue], index: normalizedIndex };
  const insertAt = playNextInsertAt(queue.length, currentIndex);
  const next = [...queue];
  next.splice(insertAt, 0, ...tracks);
  return { queue: next, index: normalizedIndex };
}

/** Where Play Next puts new tracks: right after the current one, or first in an idle queue. */
export function playNextInsertAt(queueLength: number, currentIndex: number): number {
  const normalizedIndex = normalizeCurrentIndex(currentIndex, queueLength);
  return normalizedIndex >= 0 ? normalizedIndex + 1 : 0;
}

export function appendTrackToQueue(
  queue: Track[],
  currentIndex: number,
  track: Track,
): QueueInsertResult {
  return appendTracksToQueue(queue, currentIndex, [track]);
}

export function appendTracksToQueue(
  queue: Track[],
  currentIndex: number,
  tracks: Track[],
): QueueInsertResult {
  return {
    queue: [...queue, ...tracks],
    index: normalizeCurrentIndex(currentIndex, queue.length),
  };
}

function normalizeCurrentIndex(index: number, length: number): number {
  if (!length || index < 0) return -1;
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}
