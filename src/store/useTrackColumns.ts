// Which columns every track table shows, and in what order. One layout for
// all of them (Library, playlists, mixes), kept in localStorage next to the
// column widths.
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

const STORAGE_KEY = 'newamp:track-table:columns';

interface TrackColumnLayout {
  order: TrackColumnKey[];
  hidden: TrackColumnKey[];
}

function isFixed(key: TrackColumnKey): boolean {
  return TRACK_COLUMNS_FIXED.includes(key);
}

/** Every known column exactly once, the fixed ones first; nothing unknown. */
function normalizeLayout(input: unknown): TrackColumnLayout {
  const known = new Set<string>(TRACK_COLUMN_ORDER_DEFAULT);
  const raw = (input && typeof input === 'object' ? input : {}) as { order?: unknown; hidden?: unknown };
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
  for (const key of Array.isArray(raw.hidden) ? raw.hidden : []) {
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
