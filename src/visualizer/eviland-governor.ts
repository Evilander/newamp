// Eviland Auto-Pilot — a frame-budget governor for the visualizer render loops.
//
// The old story: detectPerformanceTier() sniffs cores/RAM/GPU string ONCE and
// picks 'balanced' or 'low' forever. A hardware sniff can't see thermal
// throttling, battery savers, a driver having a bad day, or OBS eating the
// GPU — so on marginal machines the visualizer slowly turns the whole app
// heavy while the tier still says "balanced".
//
// The governor closes the loop with *measured* cost instead:
//   - feed it the measured render cost of each painted frame (endFrame)
//   - it keeps an EMA and steps a discrete render scale down when the loop
//     is sustainably over budget, and back up when headroom returns
//   - past the resolution floor it stretches the paint interval (fps trim)
//     as the second, stronger relief valve
//   - the cost it is fed is the time the CPU spent issuing GL calls, which is
//     asynchronous to the GPU: a GPU-bound machine reports a few ms while
//     frames actually take 30. So it also watches the interval the frames are
//     really painted at, against the interval it last asked the caller for
//     (intervalMs), and counts a loop that keeps falling behind as over budget.
//
// Design constraints (why it looks like this):
//   - renderer.resize() reallocates FBOs, so scale moves in DISCRETE steps
//     with a minimum dwell between steps — never continuously.
//   - Step-down is fast (~1.5s of sustained pain), step-up is slow (~10s of
//     proven headroom) so the scale never oscillates ("sawtooths") on a
//     machine that sits exactly at budget.
//   - Time is injected (performance.now() timestamps passed in); the module
//     never reads a clock, so tests drive it deterministically.
//   - It is advisory: callers read scale()/intervalMs() each frame and apply
//     them; the governor itself touches nothing.

export interface GovernorOptions {
  /** Render-cost budget per painted frame, ms. The governor trims when the
   *  EMA sits above this. Keep well under the paint interval — the renderer
   *  shares the main thread with React and audio bookkeeping. */
  costBudgetMs?: number;
  /** Sustained over-budget time before a step down, ms. */
  downDwellMs?: number;
  /** Sustained headroom time before a step back up, ms. */
  upDwellMs?: number;
  /** Minimum time between any two steps, ms. */
  stepCooldownMs?: number;
  /** EMA smoothing factor per painted frame (0..1, higher = snappier). */
  emaAlpha?: number;
  /** Achieved-over-requested paint interval above which the loop counts as late. */
  lateRatio?: number;
}

export type GovernorVerdict = 'cruise' | 'trimming' | 'floor';

export interface GovernorSnapshot {
  /** Smoothed render cost of painted frames, ms. */
  costMs: number;
  /** Smoothed achieved paint interval over the interval asked for (1 = on time). 1 until intervalMs has been read. */
  lateness: number;
  /** Current discrete render-scale multiplier (1 = native). */
  scale: number;
  /** Current level index into the ladder (0 = full quality). */
  level: number;
  /** Paint-interval multiplier (1 = base cadence). */
  intervalMul: number;
  verdict: GovernorVerdict;
  /** Total steps taken this session (for telemetry/tests). */
  steps: number;
}

// The relief ladder. Resolution first (cheap, nearly invisible at these
// steps), then frame-rate — a 0.55-scale 30fps field still *moves right*,
// while a full-res slideshow does not. Scale multiplies the DPR the caller
// already computed, so it composes with the existing maxPixels fit.
const LADDER: ReadonlyArray<{ scale: number; intervalMul: number }> = [
  { scale: 1.0, intervalMul: 1 },
  { scale: 0.85, intervalMul: 1 },
  { scale: 0.7, intervalMul: 1 },
  { scale: 0.55, intervalMul: 1 },
  { scale: 0.55, intervalMul: 1.5 },
];

export interface Governor {
  /** Record the measured render cost of a painted frame. `now` is the same
   *  timebase as endFrame's caller (performance.now()). */
  endFrame(now: number, costMs: number): void;
  /** Current render-scale multiplier to apply to DPR. */
  scale(): number;
  /** Effective paint interval given the caller's base cadence. */
  intervalMs(baseMs: number): number;
  /** Paint-interval multiplier (1 until the ladder's fps-trim floor).
   *  Allocation-free — safe to read inside a render loop. */
  intervalMul(): number;
  snapshot(): GovernorSnapshot;
  /** Drop back to full quality (e.g. on mode/track-surface change). */
  reset(): void;
}

export function createGovernor(options: GovernorOptions = {}): Governor {
  const budget = options.costBudgetMs ?? 8;
  const downDwell = options.downDwellMs ?? 1500;
  const upDwell = options.upDwellMs ?? 10_000;
  const cooldown = options.stepCooldownMs ?? 3000;
  const alpha = options.emaAlpha ?? 0.12;
  const lateRatio = options.lateRatio ?? 1.3;
  // Step back up only when the smoothed cost shows real headroom — at 60% of
  // budget — so a machine hovering at 99% of budget doesn't climb into a
  // step-down two seconds later.
  const upThreshold = budget * 0.6;

  let ema = 0;
  let primed = false;
  // The paint interval last handed out by intervalMs, and the smoothed ratio of
  // the interval frames actually arrived at to it.
  let requestedMs = 0;
  let lateness = 1;
  // A step down that only the lateness signal asked for (the cost looked fine)
  // is likely GPU-bound; climbing straight back would put the loop back into
  // the jank it just left, so the way up stays shut for a while.
  const LATE_HOLD_MS = 60_000;
  let noUpUntil = -1;
  let level = 0;
  let overSince = -1;
  let underSince = -1;
  let lastStepAt = -1;
  let lastFrameAt = -1;
  let steps = 0;
  // A paint gap this long (pause, hidden window, tab switch) breaks the
  // dwell chain: stale over/under timestamps from before the gap must not
  // count toward a step decision after it.
  const GAP_MS = 1000;

  function stepTo(next: number, now: number): void {
    level = next;
    lastStepAt = now;
    steps += 1;
    overSince = -1;
    underSince = -1;
    // Re-seed the EMA optimistically after a step so the *new* level is
    // judged on its own frames, not the old level's backlog.
    primed = false;
    lateness = 1;
  }

  return {
    endFrame(now: number, costMs: number): void {
      if (!Number.isFinite(costMs) || costMs < 0) return;
      const since = lastFrameAt >= 0 ? now - lastFrameAt : -1;
      if (since > GAP_MS) {
        // Session break: judge the fresh frames on their own merits.
        overSince = -1;
        underSince = -1;
        primed = false;
        lateness = 1;
      }
      lastFrameAt = now;
      if (!primed) {
        ema = costMs;
        primed = true;
        return;
      }
      ema += alpha * (costMs - ema);
      // A frame that follows a long idle stretch (a paused or idle visualizer
      // waking up) would read as many times late; capped, one cannot decide a step.
      if (requestedMs > 0 && since > 0 && since <= GAP_MS) {
        lateness += alpha * (Math.min(2, since / requestedMs) - lateness);
      }

      const canStep = lastStepAt < 0 || now - lastStepAt >= cooldown;
      const late = lateness > lateRatio;
      if (ema > budget || late) {
        underSince = -1;
        if (overSince < 0) overSince = now;
        else if (canStep && now - overSince >= downDwell && level < LADDER.length - 1) {
          stepTo(level + 1, now);
          if (ema <= budget) noUpUntil = now + LATE_HOLD_MS;
        }
      } else if (ema < upThreshold) {
        overSince = -1;
        if (underSince < 0) underSince = now;
        else if (canStep && now - underSince >= upDwell && level > 0 && now >= noUpUntil) {
          stepTo(level - 1, now);
        }
      } else {
        // Comfortable middle: neither trimming further nor recovering.
        overSince = -1;
        underSince = -1;
      }
    },
    scale(): number {
      return LADDER[level].scale;
    },
    intervalMs(baseMs: number): number {
      requestedMs = baseMs * LADDER[level].intervalMul;
      return requestedMs;
    },
    intervalMul(): number {
      return LADDER[level].intervalMul;
    },
    snapshot(): GovernorSnapshot {
      return {
        costMs: ema,
        lateness,
        scale: LADDER[level].scale,
        level,
        intervalMul: LADDER[level].intervalMul,
        verdict: level === 0 ? 'cruise' : level === LADDER.length - 1 ? 'floor' : 'trimming',
        steps,
      };
    },
    reset(): void {
      level = 0;
      ema = 0;
      lateness = 1;
      noUpUntil = -1;
      primed = false;
      overSince = -1;
      underSince = -1;
      lastStepAt = -1;
      lastFrameAt = -1;
    },
  };
}
