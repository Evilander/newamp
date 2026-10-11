// Volume change for wheel input over a volume control. A notched mouse
// reports one event of about 100 px per click. A trackpad or Magic Mouse
// reports a flick as dozens of small events, with momentum, so a fixed amount
// per event turned one flick into a jump of half the range. Distance is what
// counts, tracked per gesture so a burst of oversized events cannot run away.

/** One click of a notched mouse wheel, as Chromium reports it. */
const NOTCH_PX = 100;
/** Volume change per notch (0..2 scale). Shift multiplies it. */
const VOLUME_PER_NOTCH = 0.04;
const SHIFT_GAIN = 3;

/** A pause this long between two events ends a gesture. */
export const GESTURE_GAP_MS = 300;
/** What a gesture may move the volume before it has run for a while. */
export const GESTURE_BUDGET = 0.5;
/** What each second a gesture keeps going adds to its budget, so a long
 *  deliberate roll is never stuck while a short burst still is. */
export const GESTURE_BUDGET_PER_S = 1;
/** No wheel turns faster than a notch per this many ms, so an event carries
 *  at most that much distance for the time since the one before it. An event
 *  merged after a stall spans the stall and keeps its distance; a lone
 *  oversized event after a short gap is an acceleration artifact and
 *  doesn't. */
const MS_PER_NOTCH = 4;
const MAX_NOTCHES_PER_EVENT = 10;

// Heuristic: an event that follows a pause is a deliberate click, not part of
// a stream, and macOS can report a slow click as a few pixels (0.002 of
// volume). The first event after a pause always moves at least one step in
// its direction so a slow click never reads as the wheel having stopped. A
// stream keeps its proportional deltas, and sub-pixel jitter is left alone.
const ISOLATED_MS = 80;
const MIN_STEP = 0.02;
const MIN_STEP_PX = 1;

/** Sideways movement counts only once it adds up to this much... */
const HORIZONTAL_MIN_PX = 20;
/** ...and is more than this many times the vertical movement, so a swipe
 *  that drifts a few pixels sideways cannot nudge the volume. */
const HORIZONTAL_DOMINANCE = 2;

/** After the wheel stops at 100%, further upward input is absorbed until the
 *  wheel has been quiet this long. Shift goes straight through. */
export const DETENT_MS = 400;
const UNITY = 1;
const EPSILON = 1e-6;

export const WHEEL_LOG_CAPACITY = 200;
const LONG_TASK_CAPACITY = 200;
/** How far back from an event a long task still counts as part of its delay. */
const LONG_TASK_WINDOW_MS = 1000;

export type WheelSource = 'slider' | 'knob' | 'fullscreen' | 'fullscreen-meter';

export type WheelOutcome =
  | 'moved'
  | 'detent'
  | 'detent-held'
  | 'budget'
  | 'bounds'
  | 'ignored-axis'
  | 'ignored-zero'
  | 'ignored-ctrl'
  | 'invalid';

export interface WheelVolumeEvent {
  deltaY: number;
  deltaX?: number;
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode: number;
  shiftKey?: boolean;
  /** Set on the wheel events a trackpad pinch generates. */
  ctrlKey?: boolean;
  /** Legacy Chromium field, logged only. */
  wheelDeltaY?: number;
}

export interface WheelInputSample {
  /** Event time on the renderer clock, ms. */
  at: number;
  source: WheelSource;
  deltaY: number;
  deltaX: number;
  deltaMode: number;
  wheelDeltaY: number | null;
  shiftKey: boolean;
  ctrlKey: boolean;
  msSincePrev: number | null;
  /** Input arrival to handler, ms: how far behind the renderer was. */
  lagMs: number | null;
  gesture: number;
  newGesture: boolean;
  before: number;
  after: number;
  /** Total movement of the gesture so far, this event included. */
  gestureMoved: number;
  outcome: WheelOutcome;
}

export interface LoggedWheelSample extends WheelInputSample {
  /** Main-thread tasks over 50 ms in the second before this event. */
  longTasks: number;
  longTaskMs: number;
}

interface LongTask {
  at: number;
  ms: number;
}

export interface WheelLogMeta {
  app: string;
  userAgent: string;
}

/**
 * The last wheel events the volume controls saw, with what each did. Wheel
 * trouble depends on the mouse or trackpad and can't be reproduced from
 * elsewhere, and DevTools isn't something to ask users for, so Settings copies
 * this out as text for a bug report. Kept in memory only.
 */
export class WheelInputLog {
  private samples: WheelInputSample[] = [];
  private longTasks: LongTask[] = [];
  private recorded = 0;
  private longTaskCount = 0;
  private longTaskMs = 0;

  constructor(readonly capacity = WHEEL_LOG_CAPACITY) {}

  record(sample: WheelInputSample): void {
    this.samples.push(sample);
    this.recorded += 1;
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /** `at` is when the task started, on the same clock as the wheel events. */
  noteLongTask(at: number, ms: number): void {
    this.longTasks.push({ at, ms });
    this.longTaskCount += 1;
    this.longTaskMs += ms;
    if (this.longTasks.length > LONG_TASK_CAPACITY) this.longTasks.shift();
  }

  get totalRecorded(): number {
    return this.recorded;
  }

  /** Oldest first. Long tasks are matched up here, not when the event is
   *  recorded, because the browser reports them a little after they ran. A task
   *  that started after the input arrived but before the handler ran is the one
   *  that delayed it (`lagMs`), so it counts too. */
  entries(): LoggedWheelSample[] {
    return this.samples.map((sample) => {
      const window = Math.min(sample.msSincePrev ?? LONG_TASK_WINDOW_MS, LONG_TASK_WINDOW_MS);
      const handled = sample.at + Math.max(0, sample.lagMs ?? 0);
      let count = 0;
      let ms = 0;
      for (const task of this.longTasks) {
        const ended = task.at + task.ms;
        if (task.at <= handled && ended > sample.at - window) {
          count += 1;
          ms += task.ms;
        }
      }
      return { ...sample, longTasks: count, longTaskMs: ms };
    });
  }

  format(meta: WheelLogMeta): string {
    const round = (value: number | null, places: number): number | null =>
      value === null ? null : Math.round(value * 10 ** places) / 10 ** places;
    const entries = this.entries();
    const lines = [
      'NewAmp wheel input log',
      `app: ${meta.app}`,
      `userAgent: ${meta.userAgent}`,
      `captured: ${new Date().toISOString()}`,
      `renderer clock: ${Math.round(performance.now())} ms since the window loaded (the "at" values use it)`,
      `samples: ${entries.length} of ${this.recorded} recorded`,
      `long tasks: ${this.longTaskCount} totalling ${Math.round(this.longTaskMs)} ms since the first wheel event`,
      '',
    ];
    for (const entry of entries) {
      lines.push(
        JSON.stringify({
          ...entry,
          at: round(entry.at, 1),
          msSincePrev: round(entry.msSincePrev, 1),
          lagMs: round(entry.lagMs, 1),
          before: round(entry.before, 4),
          after: round(entry.after, 4),
          gestureMoved: round(entry.gestureMoved, 4),
          longTaskMs: round(entry.longTaskMs, 1),
        }),
      );
    }
    return lines.join('\n');
  }
}

export const wheelInputLog = new WheelInputLog();

export function clampVolume(value: number): number {
  return Math.max(0, Math.min(2, value));
}

function wheelPixels(event: WheelVolumeEvent, lineHeightPx = 16, pageHeightPx = 800): { dx: number; dy: number } {
  const scale = event.deltaMode === 1 ? lineHeightPx : event.deltaMode === 2 ? pageHeightPx : 1;
  return { dx: (event.deltaX ?? 0) * scale, dy: event.deltaY * scale };
}

export interface WheelVolumeStep {
  volume: number;
  outcome: WheelOutcome;
}

/**
 * Turns a stream of wheel events into volume changes. It lives across events:
 * what a wheel event does depends on how long ago the last one was, how much
 * the current gesture has already moved, and whether it just stopped at 100%.
 */
export class WheelVolumeInput {
  private lastAt = -Infinity;
  private gesture = 0;
  private gestureStart = 0;
  private moved = 0;
  /** What the gesture has used of its budget, in plain-notch units: Shift
   *  movement counts at 1/gain, so a Shift run doesn't starve the plain
   *  notches after it (or the way back down). */
  private spent = 0;
  private sumX = 0;
  private sumY = 0;
  private detentUntil = -Infinity;

  constructor(private readonly log: WheelInputLog = wheelInputLog) {}

  /** The volume after this wheel event. `current` is the live volume, `now`
   *  the event's own timestamp (so a stalled renderer still sees real gaps). */
  next(
    event: WheelVolumeEvent,
    current: number,
    now: number,
    meta: { source?: WheelSource; lagMs?: number | null } = {},
  ): WheelVolumeStep {
    const gap = now - this.lastAt;
    const finish = (volume: number, outcome: WheelOutcome, newGesture: boolean): WheelVolumeStep => {
      this.log.record({
        at: now,
        source: meta.source ?? 'slider',
        deltaY: event.deltaY,
        deltaX: event.deltaX ?? 0,
        deltaMode: event.deltaMode,
        wheelDeltaY: typeof event.wheelDeltaY === 'number' ? event.wheelDeltaY : null,
        shiftKey: !!event.shiftKey,
        ctrlKey: !!event.ctrlKey,
        msSincePrev: Number.isFinite(gap) ? gap : null,
        lagMs: meta.lagMs ?? null,
        gesture: this.gesture,
        newGesture,
        before: current,
        after: volume,
        gestureMoved: this.moved,
        outcome,
      });
      return { volume, outcome };
    };

    // A pinch on a trackpad arrives as ctrl+wheel; it is not a volume gesture.
    if (event.ctrlKey) return finish(current, 'ignored-ctrl', false);

    this.lastAt = now;
    const newGesture = !(gap < GESTURE_GAP_MS);
    if (newGesture) {
      this.gesture += 1;
      this.gestureStart = now;
      this.moved = 0;
      this.spent = 0;
      this.sumX = 0;
      this.sumY = 0;
    }

    const { dx, dy } = wheelPixels(event);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return finish(current, 'invalid', newGesture);
    const shift = !!event.shiftKey;
    // With Shift held the sideways delta is the vertical roll (see below), so
    // it counts as vertical here. Counted as sideways, a few Shift notches
    // would make the gesture read as a swipe and swallow the first plain
    // notch after Shift is let go.
    this.sumY += Math.abs(shift && dy === 0 ? dx : dy);
    if (!shift) this.sumX += Math.abs(dx);

    const horizontal = !shift && this.sumX >= HORIZONTAL_MIN_PX && this.sumX > HORIZONTAL_DOMINANCE * this.sumY;
    // macOS turns Shift+wheel into a horizontal scroll before the page sees
    // it, so the vertical intent arrives in deltaX with its sign kept. A real
    // sideways swipe over a left-to-right control: right is louder.
    const px = horizontal ? -dx : dy !== 0 ? dy : shift ? dx : 0;
    if (px === 0) return finish(current, dx !== 0 || dy !== 0 ? 'ignored-axis' : 'ignored-zero', newGesture);

    const gain = shift ? SHIFT_GAIN : 1;
    // Scrolling up (negative deltaY) raises the volume.
    let delta = -(px / NOTCH_PX) * VOLUME_PER_NOTCH * gain;

    const cap = Math.min(MAX_NOTCHES_PER_EVENT, Math.max(1, gap / MS_PER_NOTCH)) * VOLUME_PER_NOTCH * gain;
    delta = Math.max(-cap, Math.min(cap, delta));
    if (gap >= ISOLATED_MS && Math.abs(px) >= MIN_STEP_PX && Math.abs(delta) < MIN_STEP) {
      delta = Math.sign(delta) * MIN_STEP;
    }

    const allowed = GESTURE_BUDGET + (GESTURE_BUDGET_PER_S * (now - this.gestureStart)) / 1000;
    const room = Math.max(0, allowed - this.spent) * gain;
    let outcome: WheelOutcome = 'moved';
    if (Math.abs(delta) > room) {
      delta = Math.sign(delta) * room;
      outcome = 'budget';
    }

    let target = current + delta;
    if (delta > 0 && !shift) {
      if (current < UNITY - EPSILON && target >= UNITY - EPSILON) {
        target = UNITY;
        this.detentUntil = now + DETENT_MS;
        outcome = 'detent';
      } else if (Math.abs(current - UNITY) < EPSILON && now < this.detentUntil) {
        target = UNITY;
        this.detentUntil = now + DETENT_MS;
        outcome = 'detent-held';
      }
    }

    const volume = clampVolume(target);
    if (volume === current && outcome === 'moved') outcome = 'bounds';
    const change = Math.abs(volume - current);
    this.moved += change;
    this.spent += change / gain;
    return finish(volume, outcome, newGesture);
  }
}

export const wheelVolumeInput = new WheelVolumeInput();

let observingLongTasks = false;

function observeLongTasks(log: WheelInputLog): void {
  if (observingLongTasks || typeof PerformanceObserver === 'undefined') return;
  observingLongTasks = true;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) log.noteLongTask(entry.startTime, entry.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    // Not every runtime reports long tasks; the log is still useful without.
  }
}

export interface VolumeAccess {
  read(): number;
  write(volume: number): void;
}

/**
 * The one wheel handler every volume control uses. The base is the volume
 * read at event time, not whatever was last rendered: wheel events outrun
 * React, and adding to a stale value stalls the scroll.
 */
export function handleVolumeWheel(event: WheelEvent, source: WheelSource, volume: VolumeAccess): void {
  observeLongTasks(wheelInputLog);
  const clock = performance.now();
  const at = Number.isFinite(event.timeStamp) && event.timeStamp > 0 ? event.timeStamp : clock;
  const current = volume.read();
  const step = wheelVolumeInput.next(event, current, at, { source, lagMs: clock - at });
  // The control owns the wheel while the pointer is over it, even for events
  // that change nothing; the page behind must not scroll instead.
  if (step.outcome !== 'ignored-ctrl') event.preventDefault();
  if (step.volume !== current) volume.write(step.volume);
}
