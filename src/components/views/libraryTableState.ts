// Small pure rules behind the Library list and the shared track table, kept
// out of the components so they can be tested without a DOM.
import type { Track } from '@shared/types';
import type { TrackColumnKey } from '../../store/useTrackColumns';

/** The list without the given tracks; the same array when none of them are in it. */
export function withoutTracks(tracks: Track[], ids: readonly number[]): Track[] {
  if (!ids.length) return tracks;
  const gone = new Set(ids);
  const kept = tracks.filter((track) => !gone.has(track.id));
  return kept.length === tracks.length ? tracks : kept;
}

/**
 * The one row the table offers to Tab: the row that last had focus while it is
 * still drawn, otherwise the one at `firstOnScreen` (the first drawn row, unless
 * the list is scrolled and overscan rows sit above the screen). The rest are
 * reached with the arrow keys, so a long list does not cost one Tab press per
 * row.
 */
export function rovingRowId(
  renderedIds: readonly number[],
  focusedId: number | null,
  firstOnScreen = 0,
): number | null {
  if (focusedId != null && renderedIds.includes(focusedId)) return focusedId;
  return renderedIds[Math.min(firstOnScreen, renderedIds.length - 1)] ?? null;
}

/**
 * The one resize handle the header offers to Tab: the one that last had focus
 * while its column is shown, otherwise Title's (or the first column's when Title
 * is hidden). Left and Right resize it; the others are reached with the keys
 * below, so the header costs one Tab press rather than one per column.
 */
export function resizeHandleStop(
  columns: readonly TrackColumnKey[],
  focused: TrackColumnKey | null,
): TrackColumnKey | null {
  if (focused && columns.includes(focused)) return focused;
  return columns.includes('title') ? 'title' : columns[0] ?? null;
}

/**
 * Where a key takes focus from the resize handle of `from`: Down and Up step
 * to the next and previous column's handle, Home and End jump to the first and
 * last. Null for any other key. Left and Right are the handle's own.
 */
export function nextResizeHandle(
  columns: readonly TrackColumnKey[],
  from: TrackColumnKey,
  key: string,
): TrackColumnKey | null {
  const at = columns.indexOf(from);
  if (at < 0 || !columns.length) return null;
  if (key === 'ArrowDown') return columns[Math.min(columns.length - 1, at + 1)];
  if (key === 'ArrowUp') return columns[Math.max(0, at - 1)];
  if (key === 'Home') return columns[0];
  if (key === 'End') return columns[columns.length - 1];
  return null;
}

interface SlashKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/**
 * Whether `/` should jump to the search box: a bare slash that nothing else
 * took, pressed outside a text field and with no overlay up. The box is never
 * focused on its own, so the player shortcuts keep working until someone asks
 * to search.
 */
export function slashFocusesSearch(event: SlashKeyEvent, context: { typing: boolean; overlay: boolean }): boolean {
  if (event.defaultPrevented || event.key !== '/') return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !context.typing && !context.overlay;
}
