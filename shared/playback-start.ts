export function resolvePlaybackStartIndex(queueLength: number, index: number): number {
  const length = Math.max(0, Math.trunc(queueLength));
  if (!length) return -1;
  if (index < 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}
