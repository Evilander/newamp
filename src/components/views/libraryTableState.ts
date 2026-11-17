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

/**
 * Every row after the ones a list already holds, read page by page from
 * `offset`, for a queue that has to run past the loaded slice. Rows in
 * `exclude` are skipped (a scan can shift the list under the offset). Null when
 * `isCurrent` turns false between pages: the queue it was for is gone, so
 * nothing read is worth appending. A page that fails ends the read with what
 * came before it and the error, so the caller can still queue the rows it got.
 * `maxRows` bounds how many rows are read in all.
 */
export async function readRemainingRows(options: {
  getPage: (offset: number, limit: number) => Promise<Track[]>;
  offset: number;
  total: number;
  pageSize: number;
  exclude: ReadonlySet<number>;
  isCurrent: () => boolean;
  pause?: () => Promise<void>;
  maxRows?: number;
}): Promise<{ rows: Track[]; error: unknown } | null> {
  const { getPage, total, pageSize, exclude, isCurrent, pause, maxRows = Infinity } = options;
  const seen = new Set(exclude);
  const rows: Track[] = [];
  let offset = options.offset;
  let error: unknown = null;
  while (offset < total && rows.length < maxRows) {
    let page: Track[];
    const limit = Math.min(pageSize, maxRows - rows.length);
    try {
      page = await getPage(offset, limit);
    } catch (caught) {
      error = caught;
      break;
    }
    if (!isCurrent()) return null;
    offset += page.length;
    for (const track of page) {
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      rows.push(track);
    }
    if (page.length < limit) break;
    // Reading the whole library in one burst would starve the main process
    // that is also feeding the audio element.
    if (pause) await pause();
    if (!isCurrent()) return null;
  }
  if (!isCurrent()) return null;
  return { rows, error };
}

// Hands out one check per request, true only while no later request has begun.
// Playing a second row cancels the read still paging behind the first, which
// would otherwise append the same tail to the new queue as well.
export function createLatestRequestGate(): { begin: () => () => boolean } {
  let latest = 0;
  return {
    begin: () => {
      const mine = ++latest;
      return () => mine === latest;
    },
  };
}

/** A count bounds paging; an empty page ends a read even when a concurrent count is ahead. */
export function hasMoreTrackRows(offset: number, total: number, pageLength: number): boolean {
  return pageLength > 0 && offset < total;
}

/** One index per list revision, including misses; failed reads can be tried on a later revision. */
export function createTrackPositionCache(): {
  invalidate: () => void;
  find: (id: number, total: number, getIds: (offset: number, limit: number) => Promise<number[]>) => Promise<number>;
} {
  let cached: Promise<Map<number, number>> | null = null;
  return {
    invalidate: () => { cached = null; },
    find: async (id, total, getIds) => {
      if (!cached) {
        cached = (async () => {
          const positions = new Map<number, number>();
          for (let offset = 0; offset < total; offset += 100000) {
            const ids = await getIds(offset, 100000);
            ids.forEach((value, index) => positions.set(value, offset + index));
            if (ids.length < 100000) break;
          }
          return positions;
        })();
      }
      return (await cached).get(id) ?? -1;
    },
  };
}

/** Read through a playing row, or re-read a shifted loaded window once. Success always contains the id. */
export async function readThroughTrack(options: {
  trackId: number;
  offset: number;
  total: number;
  pageSize: number;
  getIds: (offset: number, limit: number) => Promise<number[]>;
  getPosition?: (id: number) => Promise<number>;
  getPage: (offset: number, limit: number) => Promise<Track[]>;
  isCurrent: () => boolean;
  pause: () => Promise<void>;
  maxRows?: number;
}): Promise<{ rows: Track[]; offset: number; replace: boolean; hasMore: boolean } | null> {
  const { trackId, total, pageSize, getIds, getPage, isCurrent, pause, maxRows = 20000 } = options;
  const position = await (options.getPosition ?? ((id) => createTrackPositionCache().find(id, total, getIds)))(trackId);
  if (!isCurrent() || position < 0 || position >= maxRows) return null;
  const replace = position < options.offset;
  if (replace && options.offset > maxRows) return null;
  const target = Math.min(maxRows, replace ? options.offset : position + 1);
  const rows: Track[] = [];
  let offset = replace ? 0 : options.offset;
  let lastPageLength = 0;
  while (offset < target) {
    const limit = Math.min(pageSize, maxRows - offset, replace ? target - offset : pageSize);
    const page = await getPage(offset, limit);
    if (!isCurrent()) return null;
    lastPageLength = page.length;
    rows.push(...page);
    offset += page.length;
    if (page.length < limit) break;
    if (offset < target) await pause();
    if (!isCurrent()) return null;
  }
  return rows.some((row) => row.id === trackId) ? { rows, offset, replace, hasMore: hasMoreTrackRows(offset, total, lastPageLength) } : null;
}

/** Scroll only when the playing row is outside the unobscured viewport. */
export function playingRowScrollTop(options: {
  index: number;
  rowHeight: number;
  bodyTop: number;
  headerHeight: number;
  scrollTop: number;
  viewportHeight: number;
  footerHeight: number;
}): number {
  const { index, rowHeight, bodyTop, headerHeight, scrollTop, viewportHeight, footerHeight } = options;
  const top = bodyTop + index * rowHeight;
  if (top >= scrollTop + headerHeight && top + rowHeight <= scrollTop + viewportHeight - footerHeight) return scrollTop;
  const room = Math.max(rowHeight, viewportHeight - headerHeight - footerHeight);
  return Math.max(0, top - headerHeight - (room - rowHeight) / 2);
}
