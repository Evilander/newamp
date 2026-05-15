export interface PracticeLoop {
  start: number | null;
  end: number | null;
  enabled: boolean;
}

const MIN_LOOP_SECONDS = 0.5;

export function normalizePracticeLoop(loop: PracticeLoop, duration?: number | null): PracticeLoop {
  const max = Number.isFinite(duration) && duration != null && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const start = normalizePoint(loop.start, max);
  const end = normalizePoint(loop.end, max);

  let nextStart = start;
  let nextEnd = end;
  if (nextStart != null && nextEnd != null && nextStart > nextEnd) {
    [nextStart, nextEnd] = [nextEnd, nextStart];
  }

  const normalized = {
    start: nextStart,
    end: nextEnd,
    enabled: loop.enabled,
  };
  return {
    ...normalized,
    enabled: loop.enabled && canEnablePracticeLoop(normalized),
  };
}

export function canEnablePracticeLoop(loop: PracticeLoop): boolean {
  return loop.start != null && loop.end != null && loop.end - loop.start >= MIN_LOOP_SECONDS;
}

export function shouldRestartPracticeLoop(loop: PracticeLoop, currentTime: number): boolean {
  if (!loop.enabled || !canEnablePracticeLoop(loop) || !Number.isFinite(currentTime)) return false;
  return currentTime >= loop.end!;
}

export function loopProgressPercent(loop: PracticeLoop, currentTime: number): number {
  if (!canEnablePracticeLoop(loop) || !Number.isFinite(currentTime)) return 0;
  const span = loop.end! - loop.start!;
  const pct = ((currentTime - loop.start!) / span) * 100;
  return round2(Math.max(0, Math.min(100, pct)));
}

function normalizePoint(value: number | null, max: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return round2(Math.max(0, Math.min(max, value)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
