// Which columns every track table shows, and in what order. One layout for
// all of them (Library, playlists, mixes), kept in localStorage next to the
// column widths. This file also owns the width defaults and the rules for
// reading saved widths, so the table and its tests agree on them.
import { create } from 'zustand';

export type TrackColumnKey =
  | 'play'
  | 'select'
  | 'queue'
  | 'playlist'
  | 'number'
  | 'title'
  | 'artist'
  | 'album'
  | 'year'
  | 'time'
  | 'plays'
  | 'rating'
  | 'mix'
  | 'tag'
  | 'love';

export const TRACK_COLUMN_ORDER_DEFAULT: readonly TrackColumnKey[] = [
  'select',
  'play',
  'queue',
  'playlist',
  'number',
  'title',
  'artist',
  'album',
  'year',
  'time',
  'plays',
  'rating',
  'mix',
  'tag',
  'love',
];

/** Always first and always shown: the selection box and the play control. */
export const TRACK_COLUMNS_FIXED: readonly TrackColumnKey[] = ['select', 'play'];

export const TRACK_COLUMN_LABELS: Record<TrackColumnKey, string> = {
  select: 'Select',
  play: 'Play',
  queue: 'Queue',
  playlist: 'Playlist',
  number: '#',
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  year: 'Year',
  time: 'Time',
  plays: 'Plays',
  rating: 'Rating',
  mix: 'Mix',
  tag: 'Tag',
  love: 'Love',
};

/**
 * Hidden on a fresh install. All fifteen columns need about 1,250 px even at
 * the narrow default widths below, more than the table has in the default
 * window, so the last ones (Time to Love) sat off-screen. Playlist repeats the
 * right-click menu; Mix and Tag are per-track housekeeping. The Columns button
 * brings any of them back.
 */
export const TRACK_COLUMNS_HIDDEN_DEFAULT: readonly TrackColumnKey[] = ['playlist', 'mix', 'tag'];

const STORAGE_KEY = 'newamp:track-table:columns';

export interface TrackColumnLayout {
  order: TrackColumnKey[];
  hidden: TrackColumnKey[];
}

function isFixed(key: TrackColumnKey): boolean {
  return TRACK_COLUMNS_FIXED.includes(key);
}

/** Every known column exactly once, the fixed ones first; nothing unknown. */
export function normalizeLayout(input: unknown): TrackColumnLayout {
  const known = new Set<string>(TRACK_COLUMN_ORDER_DEFAULT);
  const saved = !!input && typeof input === 'object';
  const raw = (saved ? input : {}) as { order?: unknown; hidden?: unknown };
  const order: TrackColumnKey[] = [...TRACK_COLUMNS_FIXED];
  const seen = new Set<TrackColumnKey>(order);
  for (const key of Array.isArray(raw.order) ? raw.order : []) {
    if (typeof key === 'string' && known.has(key) && !seen.has(key as TrackColumnKey)) {
      order.push(key as TrackColumnKey);
      seen.add(key as TrackColumnKey);
    }
  }
  for (const key of TRACK_COLUMN_ORDER_DEFAULT) {
    if (!seen.has(key)) {
      order.push(key);
      seen.add(key);
    }
  }
  const hidden: TrackColumnKey[] = [];
  // A saved layout keeps exactly what the user hid, even if that is nothing.
  for (const key of Array.isArray(raw.hidden) ? raw.hidden : saved ? [] : TRACK_COLUMNS_HIDDEN_DEFAULT) {
    if (typeof key === 'string' && known.has(key) && !isFixed(key as TrackColumnKey) && !hidden.includes(key as TrackColumnKey)) {
      hidden.push(key as TrackColumnKey);
    }
  }
  return { order, hidden };
}

function loadLayout(): TrackColumnLayout {
  if (typeof localStorage === 'undefined') return normalizeLayout(null);
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return normalizeLayout(null);
  }
}

function saveLayout(layout: TrackColumnLayout): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* ignore storage failures */
  }
}

interface TrackColumnsState extends TrackColumnLayout {
  setHidden: (key: TrackColumnKey, hidden: boolean) => void;
  /** Put `key` at `index` in the order as it reads with `key` taken out. */
  moveTo: (key: TrackColumnKey, index: number) => void;
  reset: () => void;
}

export const useTrackColumns = create<TrackColumnsState>((set, get) => ({
  ...loadLayout(),
  setHidden: (key, hidden) => {
    if (isFixed(key)) return;
    const current = get();
    const next = {
      order: current.order,
      hidden: hidden ? [...new Set([...current.hidden, key])] : current.hidden.filter((k) => k !== key),
    };
    saveLayout(next);
    set(next);
  },
  moveTo: (key, index) => {
    if (isFixed(key)) return;
    const order = get().order.filter((k) => k !== key);
    const at = Math.max(TRACK_COLUMNS_FIXED.length, Math.min(order.length, Math.round(index)));
    order.splice(at, 0, key);
    const next = { order, hidden: get().hidden };
    saveLayout(next);
    set(next);
  },
  reset: () => {
    const next = normalizeLayout(null);
    saveLayout(next);
    set(next);
  },
}));

// ── column widths ───────────────────────────────────────────────────────────
// Defaults are sized so the columns a fresh install shows (everything but
// Playlist, Mix and Tag) add up to about 1,010 px: Time and Love are on-screen
// in the default 1280 px window, and wider windows stretch the table to fit.
// In a narrower pane the columns nobody has resized give up width, down to
// their minimums (fitTrackColumnWidths), before the table scrolls sideways.

export const TRACK_COLUMN_WIDTH_DEFAULTS: Record<TrackColumnKey, number> = {
  play: 34,
  select: 34,
  queue: 70,
  playlist: 132,
  number: 44,
  title: 240,
  artist: 140,
  album: 150,
  year: 52,
  time: 64,
  plays: 52,
  rating: 92,
  mix: 62,
  tag: 50,
  love: 40,
};

export const TRACK_COLUMN_WIDTH_MINS: Record<TrackColumnKey, number> = {
  play: 28,
  select: 28,
  queue: 58,
  playlist: 112,
  number: 36,
  title: 160,
  artist: 120,
  album: 130,
  year: 48,
  time: 54,
  plays: 48,
  rating: 82,
  mix: 58,
  tag: 46,
  love: 36,
};

export const TRACK_COLUMN_WIDTH_MAX = 680;

/**
 * What the defaults were before the narrower set above. Widths used to be
 * saved for every column at once, so in such a record a value that still equals
 * one of these was never chosen; it reads as the default rather than pinning
 * the old, wider layout. Records written since carry a version and are read as
 * they are, so a width someone sets to one of these values stays.
 */
const TRACK_COLUMN_WIDTH_DEFAULTS_PREVIOUS: Record<TrackColumnKey, number> = {
  play: 34,
  select: 34,
  queue: 74,
  playlist: 154,
  number: 44,
  title: 340,
  artist: 210,
  album: 220,
  year: 62,
  time: 70,
  plays: 62,
  rating: 96,
  mix: 70,
  tag: 56,
  love: 44,
};

const TRACK_COLUMN_WIDTHS_VERSION = 2;

export interface TrackColumnWidthsRecord {
  v: number;
  widths: Partial<Record<TrackColumnKey, number>>;
}

export function clampTrackColumnWidth(key: TrackColumnKey, width: number): number {
  return Math.max(TRACK_COLUMN_WIDTH_MINS[key], Math.min(TRACK_COLUMN_WIDTH_MAX, Math.round(width)));
}

/** Saved widths over the defaults; anything missing or unreadable stays default. */
export function normalizeTrackColumnWidths(input: unknown): Record<TrackColumnKey, number> {
  const object = (input && typeof input === 'object' ? input : {}) as { v?: unknown; widths?: unknown };
  const versioned = object.v === TRACK_COLUMN_WIDTHS_VERSION && !!object.widths && typeof object.widths === 'object';
  const raw = (versioned ? object.widths : object) as Partial<Record<TrackColumnKey, unknown>>;
  const widths = { ...TRACK_COLUMN_WIDTH_DEFAULTS };
  for (const key of Object.keys(TRACK_COLUMN_WIDTH_DEFAULTS) as TrackColumnKey[]) {
    if (raw[key] == null) continue;
    const value = Number(raw[key]);
    if (!Number.isFinite(value)) continue;
    const clamped = clampTrackColumnWidth(key, value);
    if (!versioned && clamped === TRACK_COLUMN_WIDTH_DEFAULTS_PREVIOUS[key]) continue;
    widths[key] = clamped;
  }
  return widths;
}

/** Only the widths that differ from the defaults, so a later change to a default reaches everyone who never moved it. */
export function changedTrackColumnWidths(widths: Record<TrackColumnKey, number>): Partial<Record<TrackColumnKey, number>> {
  const changed: Partial<Record<TrackColumnKey, number>> = {};
  for (const key of Object.keys(TRACK_COLUMN_WIDTH_DEFAULTS) as TrackColumnKey[]) {
    if (widths[key] !== TRACK_COLUMN_WIDTH_DEFAULTS[key]) changed[key] = widths[key];
  }
  return changed;
}

/** What is stored: the changed widths, tagged so they are never mistaken for the older all-columns form. */
export function trackColumnWidthsRecord(widths: Record<TrackColumnKey, number>): TrackColumnWidthsRecord {
  return { v: TRACK_COLUMN_WIDTHS_VERSION, widths: changedTrackColumnWidths(widths) };
}

/** The narrowest the table can be with these columns showing. */
export function trackTableMinWidth(columns: readonly TrackColumnKey[], widths: Record<TrackColumnKey, number>): number {
  return columns.reduce((sum, key) => sum + widths[key], 0);
}

/**
 * What to draw when the columns add up to more than the pane: each column
 * nobody has resized gives up a share of the difference in proportion to how far
 * it sits above its minimum, and none goes below it. Columns that have been
 * resized keep their width. Nothing saved changes; if the minimums still do not
 * fit, the table scrolls sideways.
 */
export function fitTrackColumnWidths(
  columns: readonly TrackColumnKey[],
  widths: Record<TrackColumnKey, number>,
  available: number,
): Record<TrackColumnKey, number> {
  const overflow = trackTableMinWidth(columns, widths) - available;
  if (!(available > 0) || overflow <= 0) return widths;
  const room = (key: TrackColumnKey): number =>
    widths[key] === TRACK_COLUMN_WIDTH_DEFAULTS[key] ? Math.max(0, widths[key] - TRACK_COLUMN_WIDTH_MINS[key]) : 0;
  const total = columns.reduce((sum, key) => sum + room(key), 0);
  if (total <= 0) return widths;
  const share = Math.min(1, overflow / total);
  const fitted = { ...widths };
  for (const key of columns) fitted[key] = widths[key] - Math.min(room(key), Math.ceil(room(key) * share));
  return fitted;
}

/** Pixels a column handle moves per arrow press, or 0 for any other key. */
export function trackColumnResizeStep(key: string, shiftKey: boolean): number {
  if (key === 'ArrowRight') return shiftKey ? 32 : 8;
  if (key === 'ArrowLeft') return shiftKey ? -32 : -8;
  return 0;
}
