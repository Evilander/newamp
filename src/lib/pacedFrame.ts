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
  // The wake-up leads the due time by a margin for timer jitter. On a fast
  // display that margin must stay under a refresh, or the animation frame it
  // takes lands before the frame is due and the page wakes twice per paint.
  const wait = due - now - Math.min(PACED_FRAME_SLACK_MS, Math.max(2, refreshMs * 0.35));
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

// ── Display refresh ─────────────────────────────────────────────────────────
// Animation frames arrive on vsync, so a loop can only draw on multiples of
// the refresh interval. Comparing the elapsed time to a target such as 22.2 ms
// (45 fps) on a 60 Hz display rejects every 16.7 ms gap and accepts the 33.3 ms
// one: 30 fps, not 45. The gate below takes frames up to half a refresh early
// and books each slot from the schedule, not from when the last frame landed,
// so the average rate lands on the target at any refresh rate.

const DEFAULT_REFRESH_MS = 1000 / 60;
// Gaps outside this range are a stall or a timestamp glitch, not a refresh.
const MIN_REFRESH_MS = 2;
const MAX_REFRESH_MS = 50;
const REFRESH_PROBE_FRAMES = 30;
const REFRESH_MIN_SAMPLES = 8;
const REFRESH_REMEASURE_MS = 60_000;
// A probe that comes back doubtful is repeated after this long.
const REFRESH_RETRY_MS = 2_000;
// A gap this close to the smallest one is the same refresh interval.
const REFRESH_AGREE = 1.1;
// A display this much slower than the one measured before is not taken on one
// probe's word: a main thread too busy to deliver frames on time stretches
// every gap of a probe alike.
const REFRESH_SLOWER_RATIO = 1.25;

let refreshMs = DEFAULT_REFRESH_MS;
let refreshMeasuredAt = -Infinity;
let probing = false;
// A slower refresh seen once, waiting for a second probe to agree.
let refreshPending: number | null = null;

/**
 * The refresh interval: the smallest plausible gap between animation frames,
 * if at least two gaps agree on it. One short gap alone is a catch-up frame
 * after a long one, not the display.
 */
export function estimateRefreshMs(timestamps: readonly number[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    const gap = timestamps[i]! - timestamps[i - 1]!;
    if (gap >= MIN_REFRESH_MS && gap <= MAX_REFRESH_MS) gaps.push(gap);
  }
  if (gaps.length < REFRESH_MIN_SAMPLES) return null;
  gaps.sort((a, b) => a - b);
  const smallest = gaps[0]!;
  return gaps[1]! <= smallest * REFRESH_AGREE ? smallest : null;
}

/** The refresh interval of the display this page is on; 60 Hz until measured. */
export function displayRefreshMs(): number {
  return refreshMs;
}

/**
 * Reads the display's refresh interval from a short burst of animation
 * frames. Cheap, idempotent and rate-limited, so loops may call it freely;
 * `force` re-measures straight away (the window moved to another display).
 */
export function measureDisplayRefresh(force = false): void {
  if (probing || typeof requestAnimationFrame !== 'function') return;
  if (!force && performance.now() - refreshMeasuredAt < REFRESH_REMEASURE_MS) return;
  probing = true;
  const stamps: number[] = [];
  const step = (t: number): void => {
    stamps.push(t);
    if (stamps.length < REFRESH_PROBE_FRAMES) {
      requestAnimationFrame(step);
      return;
    }
    probing = false;
    const now = performance.now();
    refreshMeasuredAt = now;
    const retrySoon = (): void => {
      refreshMeasuredAt = now - REFRESH_REMEASURE_MS + REFRESH_RETRY_MS;
    };
    const estimate = estimateRefreshMs(stamps);
    if (!estimate) {
      retrySoon();
      return;
    }
    // A display that really changed (`force`) is believed; otherwise a much
    // slower refresh has to be seen twice.
    if (!force && estimate > refreshMs * REFRESH_SLOWER_RATIO) {
      const confirmed = refreshPending !== null && estimate <= refreshPending * REFRESH_AGREE && refreshPending <= estimate * REFRESH_AGREE;
      if (!confirmed) {
        refreshPending = estimate;
        retrySoon();
        return;
      }
    }
    refreshPending = null;
    refreshMs = estimate;
  };
  requestAnimationFrame(step);
}

export interface CadenceGate {
  /** Whether a frame is due at `now`. Does not take the slot. */
  due(now: number): boolean;
  /** Takes the slot for a frame drawn at `now` and books the next one. */
  commit(now: number): void;
  /** Milliseconds until `due` turns true; 0 when it already is. */
  msUntilDue(now: number): number;
  reset(): void;
}

export interface CadenceOptions {
  /** Accept frames this early on top of half a refresh. Paced loops wake slightly before they are due. */
  slackMs?: number;
  /** Refresh interval to gate against; the measured one by default. */
  refreshMs?: () => number;
  /**
   * Book frames on this grid instead of from the last one. A loop that
   * requestPacedFrame snaps to the grid wakes at a grid slot; a schedule kept
   * from the first frame's phase would sit off the slot it wakes at, and on a
   * fast display the wake would arrive just before its frame is due.
   */
  gridMs?: number;
}

// An interval this close to a whole number of refreshes is that many
// refreshes: 30 fps on a 59.94 Hz display is every second frame, not a 33.33 ms
// schedule that slips against the vsync grid and doubles up now and then.
const WHOLE_REFRESH_TOLERANCE = 0.02;

export function createCadenceGate(intervalMs: number | (() => number), options: CadenceOptions = {}): CadenceGate {
  let nextDue = 0;
  const refreshOf = (): number => options.refreshMs?.() ?? refreshMs;
  const intervalOf = (): number => {
    const interval = typeof intervalMs === 'function' ? intervalMs() : intervalMs;
    const refreshes = interval / refreshOf();
    const whole = Math.round(refreshes);
    return whole >= 1 && Math.abs(refreshes - whole) < whole * WHOLE_REFRESH_TOLERANCE ? whole * refreshOf() : interval;
  };
  const slackOf = (interval: number): number =>
    Math.min(Math.max(options.slackMs ?? 0, refreshOf() * 0.5), interval * 0.5);
  return {
    due: (now) => now >= nextDue - slackOf(intervalOf()),
    commit(now) {
      const interval = intervalOf();
      if (options.gridMs) {
        // The slot the frame was woken for is the nearest one; a frame more
        // than half a slot late has missed it and skips ahead, not catches up.
        nextDue = Math.round((now + interval) / options.gridMs) * options.gridMs;
      } else {
        // A frame later than a whole interval means the loop stalled (hidden
        // window, long task): start over rather than catch up with a burst.
        const next = nextDue + interval;
        nextDue = nextDue > 0 && next > now ? next : now + interval;
      }
      measureDisplayRefresh();
    },
    msUntilDue: (now) => Math.max(0, nextDue - slackOf(intervalOf()) - now),
    reset() {
      nextDue = 0;
    },
  };
}

// ── Paced loop ──────────────────────────────────────────────────────────────

export interface PacedLoopGate {
  (now: number): boolean;
  msUntilDue(now: number): number;
}

export interface PacedLoopOptions {
  /** Look again this long after a frame that was due but could not be drawn (hidden page, empty canvas). */
  retryMs: number;
  /** Take the shared 30 Hz grid (see requestPacedFrame). */
  snapToGrid?: boolean;
  /**
   * Keep drawing from a timer if animation frames stop arriving while the
   * page still reports itself visible. Only for loops that draw without a GPU
   * context: submitting GL commands while the compositor is not consuming
   * frames blocks the renderer thread.
   */
  rescue?: boolean;
}

// An animation frame is overdue after this long without one; from then on a
// timer draws this often (a few frames a second) until they come back.
export const RESCUE_AFTER_MS = 1000;
export const RESCUE_TICK_MS = 250;

/**
 * Calls `render` at the gate's cadence. `render` may return the delay before
 * the next wake-up (a resting loop); otherwise the gate decides. The next
 * wake-up is booked before `render` returns, so a throw cannot end the loop.
 */
export function startPacedLoop(
  gate: PacedLoopGate,
  render: (now: number) => number | void,
  options: PacedLoopOptions,
): () => void {
  let cancel = () => {};
  let stopped = false;
  // The last wake-up that came from an animation frame, not from the rescue.
  let lastFrameWakeAt = performance.now();
  // An animation frame's timestamp is when its frame began, which can be
  // earlier than the performance.now() the rescue timer just passed.
  let lastNow = -Infinity;
  measureDisplayRefresh();

  const wake = (frameNow: number, rescued = false): void => {
    if (stopped) return;
    const now = Math.max(frameNow, lastNow);
    lastNow = now;
    if (!rescued) {
      lastFrameWakeAt = performance.now();
      measureDisplayRefresh();
    }
    if (!gate(now)) {
      const wait = gate.msUntilDue(now);
      cancel = requestPacedFrame(wake, wait > 0 ? wait : options.retryMs, options.snapToGrid);
      return;
    }
    let delay: number | void = undefined;
    try {
      delay = render(now);
    } finally {
      if (!stopped) {
        cancel = requestPacedFrame(wake, typeof delay === 'number' ? delay : gate.msUntilDue(performance.now()), options.snapToGrid);
      }
    }
  };
  cancel = requestPacedFrame(wake, 0, options.snapToGrid);

  const watchdog = options.rescue
    ? window.setInterval(() => {
        const now = performance.now();
        if (now - lastFrameWakeAt < RESCUE_AFTER_MS || document.visibilityState === 'hidden') return;
        cancel();
        wake(now, true);
      }, RESCUE_TICK_MS)
    : 0;

  return () => {
    stopped = true;
    if (watchdog) window.clearInterval(watchdog);
    cancel();
  };
}

/**
 * Calls `onChange` when the page moves to a display with another pixel ratio
 * (a window dragged between a 1x panel and a 2x TV). Also re-measures the
 * refresh rate, which usually changes with it.
 */
export function watchDisplayChange(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  let query: MediaQueryList | null = null;
  let stopped = false;
  const changed = (): void => {
    if (stopped) return;
    measureDisplayRefresh(true);
    onChange();
    arm();
  };
  const arm = (): void => {
    query?.removeEventListener('change', changed);
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener('change', changed, { once: true });
  };
  arm();
  return () => {
    stopped = true;
    query?.removeEventListener('change', changed);
  };
}
