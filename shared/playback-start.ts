export function resolvePlaybackStartIndex(queueLength: number, index: number): number {
  const length = Math.max(0, Math.trunc(queueLength));
  if (!length) return -1;
  if (index < 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}

/**
 * Remaps a saved queue position onto a post-filter surviving track list by
 * following the saved track's id, instead of clamping the raw saved index
 * against the filtered length. A flat clamp silently lands playback on an
 * unrelated track whenever any entry before the saved position was deleted
 * (e.g. session restore after a library re-scan) — the clamp shifts every
 * surviving track after a gap back by however many were dropped.
 *
 * Falls back to the count of surviving entries before the saved position
 * when the saved track itself no longer exists.
 */
export interface ResumePosition {
  /** Index into the surviving track list, or -1 for a loaded-but-idle queue. */
  index: number;
  /** True only when the track that was current is the one selected, so its saved position can be applied. */
  currentSurvived: boolean;
}

/**
 * Where a restored queue should land. A saved `currentTrackId` is followed by
 * identity; a saved index of -1 (or a null id) means nothing was current and
 * the queue comes back idle rather than with track 0 selected; a record from
 * before `currentTrackId` existed falls back to remapResumeIndex.
 */
export function resolveResumePosition(
  ids: readonly number[],
  savedIndex: number,
  currentTrackId: number | null | undefined,
  survivingTrackIds: ReadonlySet<number>,
): ResumePosition {
  const survivingIds = ids.filter((id) => survivingTrackIds.has(id));
  if (!survivingIds.length) return { index: -1, currentSurvived: false };
  if (savedIndex < 0 || currentTrackId === null) return { index: -1, currentSurvived: false };
  if (typeof currentTrackId === 'number') {
    const direct = survivingIds.indexOf(currentTrackId);
    if (direct >= 0) return { index: direct, currentSurvived: true };
    return { index: remapResumeIndex(ids, savedIndex, survivingTrackIds), currentSurvived: false };
  }
  const clampedSavedIndex = Math.max(0, Math.min(Math.trunc(savedIndex), ids.length - 1));
  const target = ids[clampedSavedIndex];
  const index = remapResumeIndex(ids, savedIndex, survivingTrackIds);
  return { index, currentSurvived: target !== undefined && survivingIds[index] === target };
}

export function remapResumeIndex(
  ids: readonly number[],
  savedIndex: number,
  survivingTrackIds: ReadonlySet<number>,
): number {
  if (!ids.length) return -1;
  const clampedSavedIndex = Math.max(0, Math.min(Math.trunc(savedIndex), ids.length - 1));
  const targetId = ids[clampedSavedIndex];
  const survivingIds = ids.filter((id) => survivingTrackIds.has(id));
  if (!survivingIds.length) return -1;
  const direct = survivingIds.indexOf(targetId!);
  if (direct >= 0) return direct;
  const survivedBeforeCount = ids.slice(0, clampedSavedIndex).filter((id) => survivingTrackIds.has(id)).length;
  return Math.max(0, Math.min(survivedBeforeCount, survivingIds.length - 1));
}
