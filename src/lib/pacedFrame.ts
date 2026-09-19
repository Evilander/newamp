// requestAnimationFrame for loops that draw below the display refresh rate.
// Sleeps on a timer until the next draw is nearly due, then takes the next
// animation frame. A bare rAF loop that skips frames until its interval has
// passed still wakes the renderer on every vsync (165 Hz on some monitors)
// just to decide not to draw. While the page is hidden, timers are throttled
// and rAF does not fire, so a paced loop stays asleep like a rAF loop would.
//
// Loops running at the ambient rate (Resonance, the transport spectrum) snap
// their wake-ups to one shared 30 Hz grid, so they land in the same animation
// frame and the page renders once per slot instead of once per loop.

export const AMBIENT_FRAME_MS = 1000 / 30;
// Wake this much before the due time so the draw lands on the vsync nearest
// it. A loop that gates on elapsed time must accept frames this early.
export const PACED_FRAME_SLACK_MS = 6;
// A due time this close after a grid slot still takes that slot, so a loop
// running at the grid rate does not slip to every other slot.
const SNAP_TOLERANCE_MS = 8;

export function requestPacedFrame(
  callback: FrameRequestCallback,
  delayMs: number,
  snapToGrid = false,
): () => void {
  let raf = 0;
  let timer = 0;
  const now = performance.now();
  const due = snapToGrid
    ? Math.ceil((now + delayMs - SNAP_TOLERANCE_MS) / AMBIENT_FRAME_MS) * AMBIENT_FRAME_MS
    : now + delayMs;
  const wait = due - now - PACED_FRAME_SLACK_MS;
  if (wait <= 0) {
    raf = requestAnimationFrame(callback);
  } else {
    timer = window.setTimeout(() => {
      timer = 0;
      raf = requestAnimationFrame(callback);
    }, wait);
  }
  return () => {
    if (timer) window.clearTimeout(timer);
    if (raf) cancelAnimationFrame(raf);
    timer = 0;
    raf = 0;
  };
}
