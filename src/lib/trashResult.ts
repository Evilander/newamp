// What "Move to Recycle Bin" can be offered for, and what to tell the user
// once the main process has done it. Pure, so the wording is testable
// without the store or a window.
import type { Track, TrashProgress, TrashTracksResult } from '@shared/types';

export interface TrashToast {
  tone: 'info' | 'ok' | 'warn';
  title: string;
  detail?: string;
}

function isLocalPath(path: string | null | undefined): path is string {
  return !!path && !/^[a-z][a-z0-9+.-]+:\/\//i.test(path);
}

/** Library files only: CUE and podcast tracks (negative ids) have no file of their own to move. */
export function canTrashTracks(tracks: Track[]): boolean {
  return tracks.length > 0 && tracks.every((track) => track.id > 0 && !track.cueStart && isLocalPath(track.path));
}

/**
 * The toast while a large move runs. The last report (everything handled) has
 * none: the result toasts follow right behind it, and a small move never
 * reports short of that.
 */
export function describeTrashProgress(progress: TrashProgress, bin: string): TrashToast | null {
  if (!(progress.total > 0) || progress.done >= progress.total) return null;
  return {
    tone: 'info',
    title: `Moving files to the ${bin}`,
    detail: `${Math.max(0, progress.done).toLocaleString()} of ${progress.total.toLocaleString()}`,
  };
}

export function describeTrashResult(result: TrashTracksResult, tracks: Track[], bin: string): TrashToast[] {
  if (result.cancelled) return [];
  if (result.refused) return [{ tone: 'warn', title: result.refused }];
  const titles = new Map(tracks.map((track) => [track.id, track.title]));
  const name = (ids: number[], count: number): string =>
    count === 1 ? titles.get(ids[0]!) ?? tracks[0]?.title ?? 'One file' : `${count.toLocaleString()} files`;
  const toasts: TrashToast[] = [];
  if (result.failed.length) {
    toasts.push({
      tone: 'warn',
      title: `${result.failed.length === 1 ? 'One file' : `${result.failed.length.toLocaleString()} files`} could not be moved to the ${bin}`,
      detail: result.failed[0]!.error,
    });
  }
  const trashedIds = result.trashedIds ?? [];
  const removed = new Set(result.removedIds ?? []);
  if (result.trashed) {
    const stillIn = trashedIds.filter((id) => !removed.has(id)).length;
    toasts.push({
      tone: stillIn ? 'warn' : 'ok',
      title: `Moved to the ${bin}`,
      detail: `${name(trashedIds, result.trashed)}. ${
        stillIn ? `${stillIn === 1 ? 'One is' : `${stillIn.toLocaleString()} are`} still in the library.` : 'Gone from the library too.'
      }`,
    });
  }
  // Rows removed without a move: their file was not there any more.
  const moved = new Set(trashedIds);
  const goneIds = [...removed].filter((id) => !moved.has(id));
  if (goneIds.length) {
    toasts.push({
      tone: 'ok',
      title: 'Removed from the library',
      detail: goneIds.length === 1
        ? `${name(goneIds, 1)}. Its file was not there to move.`
        : `${goneIds.length.toLocaleString()} tracks. Their files were not there to move.`,
    });
  }
  return toasts;
}
