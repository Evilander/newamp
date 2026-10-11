// Seeking with the mouse wheel over a seek bar. A notched mouse reports one
// event of about 100 px per click; a trackpad reports a flick as dozens of
// small events with momentum. Distance is what counts, so a click is one step
// of SEEK_SECONDS_PER_NOTCH and a flick adds up to the same steps, with a cap
// per gesture so momentum cannot carry the playhead across the song.

export const SEEK_SECONDS_PER_NOTCH = 5;
/** One click of a notched mouse wheel, as Chromium reports it. */
const NOTCH_PX = 100;
const LINE_PX = 16;
const PAGE_PX = 800;
/** A pause this long between two events ends a gesture. */
export const GESTURE_GAP_MS = 250;
/** Notches a gesture may move before it has run for a while... */
export const GESTURE_BUDGET_NOTCHES = 4;
/** ...and what each further second of it adds. */
export const GESTURE_BUDGET_PER_S = 4;
/** Seeking to the very end would skip to the next track; stop this short of it. */
const END_MARGIN_S = 1;

export interface WheelSeekEvent {
  deltaX?: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode: number;
  /** Set on the wheel events a trackpad pinch generates. */
  ctrlKey?: boolean;
}

export interface WheelSeekResult {
  /** The event belongs to this control, so the page behind it should not scroll. */
  consumed: boolean;
  /** Where to seek to, in seconds, or null when this event moves nothing. */
  target: number | null;
}

export interface WheelSeek {
  handle(event: WheelSeekEvent, now: number, position: number, duration: number): WheelSeekResult;
}

const IGNORED: WheelSeekResult = { consumed: false, target: null };

export function createWheelSeek(): WheelSeek {
  let lastAt = -Infinity;
  let gestureStart = 0;
  let spent = 0;
  let carried = 0;
  // Where the gesture has got to. The player's own position lags a seek by a
  // tick or two, so each step builds on this rather than on the position.
  let aim: number | null = null;

  return {
    handle(event, now, position, duration) {
      if (event.ctrlKey || !(duration > 0)) return IGNORED;
      const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1;
      const dy = event.deltaY * scale;
      const dx = (event.deltaX ?? 0) * scale;
      if (!Number.isFinite(dy) || !Number.isFinite(dx) || dy === 0) return IGNORED;
      // A sideways swipe is a different gesture.
      if (Math.abs(dx) > Math.abs(dy)) return IGNORED;

      const fresh = now - lastAt > GESTURE_GAP_MS;
      if (fresh) {
        gestureStart = now;
        spent = 0;
        carried = 0;
        aim = null;
      }
      lastAt = now;
      if (carried !== 0 && Math.sign(carried) !== Math.sign(dy)) carried = 0;
      carried += dy;

      let notches = Math.trunc(carried / NOTCH_PX);
      // A slow click on a trackpad can report a few pixels; the first event of
      // a gesture still moves one step.
      if (notches === 0 && fresh) notches = Math.sign(dy);
      if (notches === 0) return { consumed: true, target: null };
      carried -= notches * NOTCH_PX;
      if (fresh) carried = 0;

      const allowed = GESTURE_BUDGET_NOTCHES + (GESTURE_BUDGET_PER_S * (now - gestureStart)) / 1000;
      const room = Math.max(0, Math.floor(allowed - spent));
      if (Math.abs(notches) > room) notches = Math.sign(notches) * room;
      if (notches === 0) return { consumed: true, target: null };
      spent += Math.abs(notches);

      // Scrolling up (negative deltaY) moves forward, as it raises the volume.
      const base = aim ?? position;
      const limit = Math.max(0, duration - END_MARGIN_S);
      const target = Math.max(0, Math.min(limit, base - notches * SEEK_SECONDS_PER_NOTCH));
      aim = target;
      return { consumed: true, target: target === base ? null : target };
    },
  };
}
