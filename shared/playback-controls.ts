export const MAX_SLEEP_TIMER_MINUTES = 480;

export function normalizeSleepTimerMinutes(value: unknown): number | null {
  const minutes = Math.trunc(Number(value));
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(1, Math.min(MAX_SLEEP_TIMER_MINUTES, minutes));
}

export function sleepTimerEndTime(minutes: unknown, now = Date.now()): number | null {
  const normalized = normalizeSleepTimerMinutes(minutes);
  return normalized == null ? null : now + normalized * 60_000;
}

export function stopAfterCurrentKey(trackId: number | null, index: number): string | null {
  if (trackId == null || !Number.isFinite(trackId)) return null;
  return `${Math.trunc(trackId)}:${Math.trunc(Number(index) || 0)}`;
}

export function shouldStopAfterCurrent(input: {
  ended: boolean;
  stopAfterCurrent: boolean;
  currentTrackId: number | null;
  index: number;
  lastStopKey: string | null;
}): boolean {
  if (!input.ended || !input.stopAfterCurrent) return false;
  const key = stopAfterCurrentKey(input.currentTrackId, input.index);
  return !!key && key !== input.lastStopKey;
}

export function shouldStopForSleepTimer(input: {
  playing: boolean;
  sleepTimerEndsAt: number | null;
  now?: number;
}): boolean {
  if (!input.playing || input.sleepTimerEndsAt == null) return false;
  const now = input.now ?? Date.now();
  return Number.isFinite(input.sleepTimerEndsAt) && now >= input.sleepTimerEndsAt;
}
