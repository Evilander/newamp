// Volume change for one wheel event, in proportion to how far the wheel
// moved. A notched mouse reports one event of about 100 px per click. A
// trackpad or Magic Mouse reports a flick as dozens of small events, with
// momentum, so a fixed amount per event turned one flick into a jump of
// half the range.

/** One click of a notched mouse wheel, as Chromium reports it. */
const NOTCH_PX = 100;
/** Volume change per notch (0..2 scale). Shift multiplies it. */
const VOLUME_PER_NOTCH = 0.04;
const SHIFT_GAIN = 3;
/** The most one event may move. When the renderer falls behind, Chromium
 *  merges the queued wheel events into one carrying their summed distance,
 *  so the cap has to leave room for a whole flick, or a busy app loses
 *  most of the scroll. It only guards against absurd deltas. */
const MAX_NOTCHES_PER_EVENT = 10;

interface WheelLike {
  deltaY: number;
  deltaX?: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode: number;
  shiftKey?: boolean;
}

export function wheelVolumeDelta(event: WheelLike, lineHeightPx = 16, pageHeightPx = 800): number {
  let px = event.deltaY;
  const sideways = event.deltaX ?? 0;
  if (px === 0 && sideways !== 0) {
    // macOS turns Shift+wheel into a horizontal scroll before the page
    // sees it, so the vertical intent arrives in deltaX with its sign kept.
    // A real sideways swipe over a left-to-right slider: right is louder.
    px = event.shiftKey ? sideways : -sideways;
  }
  if (!Number.isFinite(px)) return 0;
  if (event.deltaMode === 1) px *= lineHeightPx;
  else if (event.deltaMode === 2) px *= pageHeightPx;
  const limit = NOTCH_PX * MAX_NOTCHES_PER_EVENT;
  px = Math.max(-limit, Math.min(limit, px));
  // Scrolling up (negative deltaY) raises the volume.
  return -(px / NOTCH_PX) * VOLUME_PER_NOTCH * (event.shiftKey ? SHIFT_GAIN : 1);
}

export function clampVolume(value: number): number {
  return Math.max(0, Math.min(2, value));
}

/** How long a value the wheel just sent stays the base for the next event
 *  while the UI has not painted it yet. Longer than any gap inside a
 *  flick, shorter than a deliberate pause. */
const PENDING_MS = 250;

interface PendingVolume {
  value: number;
  at: number;
}

/**
 * Wheel events arrive faster than React paints, and far faster when the
 * app is busy. Adding each delta to the last *rendered* volume then
 * re-sends the same value over and over and the scroll goes nowhere. This
 * keeps the last value the wheel sent and builds on it until the rendered
 * value catches up (or the window passes, in case something else moved the
 * volume meanwhile).
 */
export class WheelVolumeAccumulator {
  private pending: PendingVolume | null = null;

  /** Call on every render with the value the UI currently shows. */
  observe(rendered: number): void {
    if (this.pending && Math.abs(this.pending.value - rendered) < 1e-9) this.pending = null;
  }

  /** The volume after this wheel event, given what the UI currently shows. */
  next(rendered: number, delta: number, now = performance.now()): number {
    const base = this.pending && now - this.pending.at < PENDING_MS ? this.pending.value : rendered;
    const value = clampVolume(base + delta);
    this.pending = { value, at: now };
    return value;
  }
}
