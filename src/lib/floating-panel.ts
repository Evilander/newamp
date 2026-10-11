// Where a floating panel sits: the clamp that keeps it on screen, the saved
// position, and the arrow-key nudge for people who do not drag.

export interface PanelPosition {
  left: number;
  top: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

/** Space kept between a panel and the window edge. */
export const PANEL_MARGIN = 8;
/**
 * The highest a panel may sit: just under the 40px title bar. The bar holds the
 * window buttons and the OS drag region, so a panel that reached it would cover
 * the one and fight the other. colour-editor.css repeats it in max-height.
 */
export const PANEL_TOP_LIMIT = 44;
/** Where a panel opens, clear of the title bar. */
const DEFAULT_TOP = 52;
const DEFAULT_SIDE_GAP = 16;

const STORAGE_PREFIX = 'newamp:floating-panel:';
const STORAGE_VERSION = 1;

type PanelStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): PanelStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The closest spot to `at` where a box of `size` is fully inside `viewport`; a
 * box too big for it sits at the margin. `top` is the least distance from the
 * top edge, for a box that must stay under something (the margin by default).
 */
export function placeInViewport(
  at: PanelPosition,
  size: PanelSize,
  viewport: PanelSize,
  margin = PANEL_MARGIN,
  top = margin,
): PanelPosition {
  const fit = (value: number, extent: number, room: number, least: number): number => {
    const farthest = room - extent - margin;
    const wanted = Number.isFinite(value) ? value : least;
    return Math.round(Math.max(least, Math.min(wanted, farthest)));
  };
  return { left: fit(at.left, size.width, viewport.width, margin), top: fit(at.top, size.height, viewport.height, top) };
}

/** Top right, below the title bar. */
export function defaultPanelPosition(size: PanelSize, viewport: PanelSize): PanelPosition {
  return placeInViewport({ left: viewport.width - size.width - DEFAULT_SIDE_GAP, top: DEFAULT_TOP }, size, viewport, PANEL_MARGIN, PANEL_TOP_LIMIT);
}

/** A saved position, or null for anything that is not one. */
export function normalizePanelPosition(input: unknown): PanelPosition | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as { v?: unknown; left?: unknown; top?: unknown };
  if (record.v !== STORAGE_VERSION) return null;
  if (typeof record.left !== 'number' || typeof record.top !== 'number') return null;
  if (!Number.isFinite(record.left) || !Number.isFinite(record.top)) return null;
  return { left: Math.round(record.left), top: Math.round(record.top) };
}

export function loadPanelPosition(id: string, storage: PanelStorage | null = defaultStorage()): PanelPosition | null {
  if (!storage) return null;
  try {
    return normalizePanelPosition(JSON.parse(storage.getItem(STORAGE_PREFIX + id) ?? 'null'));
  } catch {
    return null;
  }
}

export function savePanelPosition(id: string, position: PanelPosition, storage: PanelStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(STORAGE_PREFIX + id, JSON.stringify({ v: STORAGE_VERSION, left: Math.round(position.left), top: Math.round(position.top) }));
  } catch {
    /* a blocked store only costs the remembered spot */
  }
}

const NUDGE = 8;
const NUDGE_FAR = 32;

/** The position after an arrow key, or null for any other key. Shift goes further. */
export function nudgePanel(position: PanelPosition, key: string, shiftKey: boolean): PanelPosition | null {
  const step = shiftKey ? NUDGE_FAR : NUDGE;
  switch (key) {
    case 'ArrowLeft': return { left: position.left - step, top: position.top };
    case 'ArrowRight': return { left: position.left + step, top: position.top };
    case 'ArrowUp': return { left: position.left, top: position.top - step };
    case 'ArrowDown': return { left: position.left, top: position.top + step };
    default: return null;
  }
}
