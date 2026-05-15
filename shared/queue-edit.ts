import type { Track } from './types.js';

export interface QueueEditResult {
  queue: Track[];
  index: number;
}

export interface QueueRemoveResult extends QueueEditResult {
  removedCurrent: boolean;
}

export function moveQueueItem(
  queue: Track[],
  currentIndex: number,
  fromIndex: number,
  toIndex: number,
): QueueEditResult {
  if (!queue.length) return { queue: [], index: -1 };
  const from = clampIndex(fromIndex, queue.length);
  const to = clampIndex(toIndex, queue.length);
  if (from === to) return { queue: [...queue], index: normalizeCurrentIndex(currentIndex, queue.length) };

  const next = [...queue];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);

  const currentId = queue[normalizeCurrentIndex(currentIndex, queue.length)]?.id ?? null;
  const index = currentId == null ? -1 : next.findIndex((track) => track.id === currentId);
  return { queue: next, index };
}

export function removeQueueItem(
  queue: Track[],
  currentIndex: number,
  removeIndex: number,
): QueueRemoveResult {
  if (!queue.length) return { queue: [], index: -1, removedCurrent: false };
  const remove = clampIndex(removeIndex, queue.length);
  const normalizedCurrent = normalizeCurrentIndex(currentIndex, queue.length);
  const removedCurrent = remove === normalizedCurrent;
  const next = queue.filter((_track, index) => index !== remove);
  if (!next.length) return { queue: [], index: -1, removedCurrent };

  if (removedCurrent) {
    return { queue: next, index: Math.min(remove, next.length - 1), removedCurrent };
  }
  const currentId = queue[normalizedCurrent]?.id ?? null;
  const index = currentId == null ? -1 : next.findIndex((track) => track.id === currentId);
  return { queue: next, index, removedCurrent };
}

function normalizeCurrentIndex(index: number, length: number): number {
  if (!length) return -1;
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}
