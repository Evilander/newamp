import type { DeskWidgetLayout, DeskWidgetLevel, DeskWidgetState } from '../shared/types.js';
import { placeOrigin, type WindowRect } from './window-state.js';

// Pure rules for the desktop widget: a small player window that stays out
// beside the library and can sit under every other window. No Electron
// runtime calls, so placement and the per-platform level rules are
// unit-testable in Node.

export const DESK_WIDGET_SIZES: Record<DeskWidgetLayout, { width: number; height: number }> = {
  platter: { width: 240, height: 240 },
  card: { width: 380, height: 128 },
};

// How far a widget that has never been placed sits from the corner of the screen.
const EDGE_MARGIN = 24;
const MAX_SAVED_ORIGIN = 100000;

const LAYOUTS: readonly DeskWidgetLayout[] = ['platter', 'card'];
const LEVELS: readonly DeskWidgetLevel[] = ['desktop', 'normal', 'floating'];

export function emptyDeskWidgetState(): DeskWidgetState {
  return { open: false, layout: 'platter', level: 'desktop', origin: null };
}

function normalizeOrigin(raw: unknown): { x: number; y: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > MAX_SAVED_ORIGIN || Math.abs(y) > MAX_SAVED_ORIGIN) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

export function normalizeDeskWidgetState(raw: unknown): DeskWidgetState {
  const fallback = emptyDeskWidgetState();
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Record<string, unknown>;
  return {
    open: value.open === true,
    layout: LAYOUTS.includes(value.layout as DeskWidgetLayout) ? (value.layout as DeskWidgetLayout) : fallback.layout,
    level: LEVELS.includes(value.level as DeskWidgetLevel) ? (value.level as DeskWidgetLevel) : fallback.level,
    origin: normalizeOrigin(value.origin),
  };
}

/** The levels the widget's menu offers. Only macOS has one between the desktop and ordinary windows. */
export function deskWidgetLevels(platform: NodeJS.Platform): DeskWidgetLevel[] {
  return platform === 'darwin' ? ['desktop', 'normal', 'floating'] : ['normal', 'floating'];
}

/** The level a saved choice means on this platform: `desktop` is an ordinary window off macOS. */
export function resolveDeskWidgetLevel(level: DeskWidgetLevel, platform: NodeJS.Platform): DeskWidgetLevel {
  return level === 'desktop' && platform !== 'darwin' ? 'normal' : level;
}

export interface DeskWidgetLevelCall {
  onTop: boolean;
  level: 'normal' | 'floating';
  relativeLevel: number;
}

/**
 * The BrowserWindow.setAlwaysOnTop arguments for a level. `desktop` is one
 * step under ordinary windows: over the wallpaper and the desktop icons,
 * under every app, and still clickable. Electron reports such a window as
 * "always on top", so nothing should read isAlwaysOnTop() to mean pinned.
 */
export function deskWidgetLevelCall(level: DeskWidgetLevel, platform: NodeJS.Platform): DeskWidgetLevelCall {
  const resolved = resolveDeskWidgetLevel(level, platform);
  if (resolved === 'floating') return { onTop: true, level: 'floating', relativeLevel: 0 };
  if (resolved === 'desktop') return { onTop: true, level: 'normal', relativeLevel: -1 };
  return { onTop: false, level: 'normal', relativeLevel: 0 };
}

/**
 * Where the widget opens. A saved corner that is still on a connected display
 * is kept and pulled fully inside that display's work area. A widget that was
 * never placed, or whose display is gone, goes to the bottom right of the
 * primary work area.
 */
export function placeDeskWidget(
  origin: { x: number; y: number } | null,
  layout: DeskWidgetLayout,
  workAreas: readonly WindowRect[],
  primaryWorkArea: WindowRect,
): WindowRect {
  const size = DESK_WIDGET_SIZES[layout];
  const kept = origin ? placeOrigin({ ...origin, ...size }, size, workAreas) : null;
  if (kept) return { ...kept, ...size };
  return {
    x: Math.round(primaryWorkArea.x + Math.max(0, primaryWorkArea.width - size.width - EDGE_MARGIN)),
    y: Math.round(primaryWorkArea.y + Math.max(0, primaryWorkArea.height - size.height - EDGE_MARGIN)),
    ...size,
  };
}
