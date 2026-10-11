// Pure rules for the projector's floating control bar (keys and colour), kept
// apart from main.tsx's DOM wiring so scripts/projector-controls-test.mjs can
// run them directly.
import type { DetachedFramePayload } from '../visualizer/frame-bus';

/** The transport snapshot, plus the skin's accent when the main window sends it. */
export type ProjectorTransport = NonNullable<DetachedFramePayload['transport']> & { accent?: string | null };

export const PROJECTOR_ACCENT_FALLBACK = '#7aa8ff';

const CSS_COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([0-9\s.,%/+-]+\))$/i;

/** The slider colour for a frame's transport: the skin's accent when it is a plain colour value, else the default blue. */
export function projectorAccent(transport: ProjectorTransport | null | undefined): string {
  const accent = transport?.accent?.trim();
  return accent && CSS_COLOR.test(accent) ? accent : PROJECTOR_ACCENT_FALLBACK;
}

export const PROJECTOR_SEEK_STEP = 5;
export const PROJECTOR_VOLUME_STEP = 0.05;

/**
 * Where an arrow-key seek lands. A stream reports no duration, and clamping to
 * that sent the forward seek to 0:00, so the end is only a limit when there is
 * one.
 */
export function projectorSeekTarget(transport: { currentTime: number; duration: number }, delta: number): number {
  const target = transport.currentTime + delta;
  return Math.max(0, transport.duration > 0 ? Math.min(transport.duration, target) : target);
}

/** One Up/Down step from the last known volume (0..2), kept to whole percents so repeats do not drift. */
export function projectorVolumeTarget(volume: number, direction: 1 | -1): number {
  const base = Number.isFinite(volume) ? volume : 0;
  return Math.max(0, Math.min(2, Math.round((base + direction * PROJECTOR_VOLUME_STEP) * 100) / 100));
}
