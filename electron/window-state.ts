import type { SavedWindowRect, SavedWindowState } from '../shared/types.js';

// Pure geometry for remembering where the main window (and the compact deck)
// lives between launches. No Electron runtime calls, so the display-removal
// and clamping cases are unit-testable in Node.

export type WindowRect = SavedWindowRect;

export interface WindowPlacementLimits {
  minWidth: number;
  minHeight: number;
  defaultWidth: number;
  defaultHeight: number;
}

export interface WindowPlacement {
  /** Absent when no saved position is usable; the OS then picks the spot. */
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface WindowSnapshot {
  compact: boolean;
  maximized: boolean;
  fullscreen: boolean;
  minimized: boolean;
  bounds: WindowRect;
  normalBounds: WindowRect;
}

const MIN_SAVED_EDGE = 80;
const MAX_SAVED_EDGE = 16384;
const MAX_SAVED_ORIGIN = 100000;
// A window counts as reachable when this much of it overlaps a display, so a
// sliver hanging off the edge of a removed monitor does not stay unreachable.
const MIN_VISIBLE_WIDTH = 160;
const MIN_VISIBLE_HEIGHT = 80;

export function emptyWindowState(): SavedWindowState {
  return { normal: null, maximized: false, deck: null };
}

export function normalizeWindowRect(raw: unknown): WindowRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (Math.abs(x) > MAX_SAVED_ORIGIN || Math.abs(y) > MAX_SAVED_ORIGIN) return null;
  if (width < MIN_SAVED_EDGE || height < MIN_SAVED_EDGE) return null;
  if (width > MAX_SAVED_EDGE || height > MAX_SAVED_EDGE) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function normalizeWindowState(raw: unknown): SavedWindowState {
  if (!raw || typeof raw !== 'object') return emptyWindowState();
  const value = raw as Record<string, unknown>;
  return {
    normal: normalizeWindowRect(value.normal),
    maximized: value.maximized === true,
    deck: normalizeWindowRect(value.deck),
  };
}

function sameRect(a: WindowRect | null, b: WindowRect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameState(a: SavedWindowState, b: SavedWindowState): boolean {
  return a.maximized === b.maximized && sameRect(a.normal, b.normal) && sameRect(a.deck, b.deck);
}

function overlap(a: WindowRect, b: WindowRect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

// The work area the saved rectangle mostly sits on, or null when it is not
// reachable on any display that is connected now.
function hostDisplay(rect: WindowRect, workAreas: readonly WindowRect[]): WindowRect | null {
  let best: WindowRect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const shared = overlap(rect, area);
    if (shared.width < Math.min(rect.width, MIN_VISIBLE_WIDTH)) continue;
    if (shared.height < Math.min(rect.height, MIN_VISIBLE_HEIGHT)) continue;
    const sharedArea = shared.width * shared.height;
    if (sharedArea > bestArea) {
      best = area;
      bestArea = sharedArea;
    }
  }
  return best;
}

function fitAxis(start: number, size: number, areaStart: number, areaSize: number): number {
  const end = areaStart + areaSize;
  if (size >= areaSize) return areaStart;
  if (start < areaStart) return areaStart;
  if (start + size > end) return end - size;
  return start;
}

/**
 * Where a window of the saved shape should open. A rectangle that is still on
 * a connected display is kept, pulled fully inside that display's work area
 * and shrunk if the display got smaller. One that only existed on a monitor
 * that is gone keeps its size and loses its position, so the OS centers it.
 */
export function placeWindow(
  saved: WindowRect | null | undefined,
  workAreas: readonly WindowRect[],
  limits: WindowPlacementLimits,
): WindowPlacement {
  const rect = normalizeWindowRect(saved);
  if (!rect) return { width: limits.defaultWidth, height: limits.defaultHeight };
  const host = hostDisplay(rect, workAreas);
  if (!host) {
    const widest = workAreas.reduce((max, area) => Math.max(max, area.width), 0);
    const tallest = workAreas.reduce((max, area) => Math.max(max, area.height), 0);
    return {
      width: Math.max(limits.minWidth, widest ? Math.min(rect.width, widest) : rect.width),
      height: Math.max(limits.minHeight, tallest ? Math.min(rect.height, tallest) : rect.height),
    };
  }
  const width = Math.max(limits.minWidth, Math.min(rect.width, host.width));
  const height = Math.max(limits.minHeight, Math.min(rect.height, host.height));
  return {
    x: fitAxis(rect.x, width, host.x, host.width),
    y: fitAxis(rect.y, height, host.y, host.height),
    width,
    height,
  };
}

/**
 * Where a window that is about to change size (entering the deck) should
 * keep its top-left corner. Returns null when the saved spot is no longer on
 * any display, so the caller leaves the window where it is.
 */
export function placeOrigin(
  saved: WindowRect | null | undefined,
  size: { width: number; height: number },
  workAreas: readonly WindowRect[],
): { x: number; y: number } | null {
  const rect = normalizeWindowRect(saved);
  if (!rect) return null;
  const sized: WindowRect = { x: rect.x, y: rect.y, width: size.width, height: size.height };
  const host = hostDisplay(sized, workAreas);
  if (!host) return null;
  return {
    x: fitAxis(sized.x, sized.width, host.x, host.width),
    y: fitAxis(sized.y, sized.height, host.y, host.height),
  };
}

/**
 * The state to store after a move or resize, or null when nothing worth
 * writing changed. Fullscreen and minimized frames are never recorded (their
 * rectangles are the screen or the taskbar). The deck is stored apart from
 * the normal window so parking it in a corner never moves the main layout.
 */
export function nextWindowState(prev: SavedWindowState, snapshot: WindowSnapshot): SavedWindowState | null {
  if (snapshot.fullscreen || snapshot.minimized) return null;
  let next: SavedWindowState;
  if (snapshot.compact) {
    const deck = normalizeWindowRect(snapshot.bounds);
    if (!deck) return null;
    next = { ...prev, deck };
  } else {
    const normal = normalizeWindowRect(snapshot.normalBounds);
    if (!normal) return null;
    next = { normal, maximized: snapshot.maximized, deck: prev.deck };
  }
  return sameState(prev, next) ? null : next;
}
