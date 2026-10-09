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

interface WheelLike {
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode: number;
  shiftKey?: boolean;
}

export function wheelVolumeDelta(event: WheelLike, lineHeightPx = 16, pageHeightPx = 800): number {
  let px = event.deltaY;
  if (!Number.isFinite(px)) return 0;
  if (event.deltaMode === 1) px *= lineHeightPx;
  else if (event.deltaMode === 2) px *= pageHeightPx;
  // One event never moves more than one notch, however large its delta.
  px = Math.max(-NOTCH_PX, Math.min(NOTCH_PX, px));
  // Scrolling up (negative deltaY) raises the volume.
  return -(px / NOTCH_PX) * VOLUME_PER_NOTCH * (event.shiftKey ? SHIFT_GAIN : 1);
}

export function clampVolume(value: number): number {
  return Math.max(0, Math.min(2, value));
}
